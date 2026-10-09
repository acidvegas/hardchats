#!/usr/bin/env python3
"""
hardchats irc bot
-----------------
pure-stdlib async irc bot for irc.supernets.org, baked into the hardchats
server (started as an asyncio task from server.py's on_startup). posts:
  - scheduled announcements about hardchats community events in #superbowl,
    #hardchats and #phreak, and answers !events / !testevents on demand
  - live join/leave announcements in #hardchats as people enter/leave the
    WebRTC room (server.py calls bot.announce_join / bot.announce_leave)

requires python 3.9+ (uses zoneinfo; the tzdata package supplies the zone
database on alpine).
"""

import asyncio
import pathlib
import random
import secrets
import ssl
import string
import sys
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo


# === configuration ====================================================

SERVER     = 'irc.supernets.org'
PORT       = 6697
USE_TLS    = True
NICK       = 'HARDCHATS'
USERNAME   = 'HARDCH'
REALNAME   = 'HTTPS://HARDCHATS.COM'
CHANNELS   = ('#superbowl', '#hardchats', '#phreak')
YAP_CHANNELS = ('#hardchats', '#phreak')
TZ         = ZoneInfo('America/New_York')
HARDCHATS  = 'https://hardchats.com'

# how many show-and-tell reminders to fire each week (random in this range, inclusive)
SHOWTELL_PER_WEEK = (3, 5)

# delay between consecutive PRIVMSGs to avoid server flood protection
SEND_DELAY = 0.7

# wait this long after the server's welcome (001) before sending JOINs
JOIN_DELAY = 6.0

# wait this long after a KICK before rejoining the same channel
REJOIN_DELAY = 3.0

# channels the bot should immediately part if it ever ends up in them
BLACKHOLE_CHANNELS = ('#blackhole',)

# only this nick may run !testevents
OWNER_NICK = 'acidvegas'

# nickserv registration: after the bot has been connected this long,
# register NICK (no email) with a random password. the password is saved
# to PASSWORD_PATH only once NickServ confirms (+r on us), so reconnects
# skip straight to identify.
REGISTER_AFTER = 2 * 60 * 60     # 2 hours in seconds
PASSWORD_LEN   = 20
PASSWORD_PATH  = pathlib.Path(__file__).resolve().parent / 'nickserv-hardchats.txt'


# === irc formatting helpers ===========================================

B  = '\x02'   # bold
U  = '\x1F'   # underline
I  = '\x1D'   # italic
RV = '\x16'   # reverse
RS = '\x0F'   # reset
CC = '\x03'   # color escape

# mIRC color codes
WHITE, BLACK, BLUE, GREEN, RED, BROWN, PURPLE, ORANGE = 0, 1, 2, 3, 4, 5, 6, 7
YELLOW, LIME, TEAL, CYAN, ROYAL, PINK, GREY, SILVER  = 8, 9, 10, 11, 12, 13, 14, 15


def color(text, fg, bg=None):
    if bg is None:
        return f'{CC}{fg:02d}{text}{CC}'
    return f'{CC}{fg:02d},{bg:02d}{text}{CC}'


def banner(label, fg, bg):
    return color(f' {B}{label}{B} ', fg, bg)


SPARK_CHARS = (
    '*', '~', '+', '=', '#', '>>>', '<<<', '::', '//', '**', '!!', '><',
    '>>', '<<', '##', '~~', '$$', '@@', '%%', '|>', '<|', '+++', '---',
    '===', '...', '.::.', '><><', '>><<', '[*]', '[+]', '[!]', '[?]',
    '<<<<', '>>>>', '<>', '/\\', '\\/', '|=|', '<==>', '>!<', '!*!',
    '*~*', '~+~', '+>>', '<<+', ':>', '<:', '>~<', '*::*',
)
DIVIDER_CHARS  = ('=', '-', '~', '*', '+', '#', '_', '.', ':', '/')
SPARK_COLORS   = (YELLOW, ORANGE, RED, PINK, CYAN, LIME, ROYAL, PURPLE)
DIVIDER_COLORS = (PURPLE, ROYAL, CYAN, PINK, ORANGE, LIME, RED, YELLOW)


def spark():
    return color(random.choice(SPARK_CHARS), random.choice(SPARK_COLORS))


def divider(width=42):
    ch = random.choice(DIVIDER_CHARS)
    return color(ch * width, random.choice(DIVIDER_COLORS))


def gen_password(n=PASSWORD_LEN):
    alphabet = string.ascii_letters + string.digits
    return ''.join(secrets.choice(alphabet) for _ in range(n))


# === randomised message bits ==========================================

HYPE_VERBS = (
    'hop in', 'pull up', 'slide through', 'roll in', 'drop by',
    'tune in', 'come thru', 'slide in', 'swing through', 'cruise by',
    'link up', 'ride in', 'show up', 'check in', 'pop in', 'come hang',
)

# every CTA explicitly names hardchats.com as the location of the event
CALL_TO_ACTIONS = (
    f'{B}Happening on{B} {U}{HARDCHATS}{U}',
    f'{B}Live on{B} {U}{HARDCHATS}{U}',
    f'{B}Join us on{B} {U}{HARDCHATS}{U}',
    f'{B}All going down at{B} {U}{HARDCHATS}{U}',
    f'{B}Hop on{B} {U}{HARDCHATS}{U}',
    f'{B}Pull up at{B} {U}{HARDCHATS}{U}',
    f'{B}Come yap on{B} {U}{HARDCHATS}{U}',
    f'{B}See you at{B} {U}{HARDCHATS}{U}',
    f'{B}Meet us at{B} {U}{HARDCHATS}{U}',
    f'{B}Slide into{B} {U}{HARDCHATS}{U}',
    f'{B}Drop in to{B} {U}{HARDCHATS}{U}',
    f'{B}Roll up to{B} {U}{HARDCHATS}{U}',
)


# friday night yaps ----------------------------------------------------

FNY_HEADERS = (
    'FRIDAY NIGHT YAPS',
    '>> FRIDAY NIGHT YAPS <<',
    '<<< FRIDAY NIGHT YAPS >>>',
    '[ FRIDAY NIGHT YAPS ]',
    '// FRIDAY NIGHT YAPS //',
    ':: FRIDAY NIGHT YAPS ::',
    '** FRIDAY NIGHT YAPS **',
    '$$$ FRIDAY NIGHT YAPS $$$',
)

# what FNY actually is: weekend, drinking, games, hacking, fucking around
FNY_TAGLINES = (
    'Weekend starts here: drinks, games, hacking, shenanigans',
    'Crack a drink, pull up, talk shit',
    'Drinking, gaming, hacking, fucking around',
    'No agenda, just the weekend and bad decisions',
    'Hack something, play something, drink something',
    'Shenanigans guaranteed, productivity not',
    'Bring a drink, bring a game, bring whatever youre breaking',
    'Games, hacks, booze, chaos',
    'Fuck around and find out, live',
)


def msg_friday_now():
    head = random.choice(FNY_HEADERS)
    return [
        f'{spark()} {banner(head, WHITE, RED)} {spark()} {color(B + "STARTING NOW" + B, YELLOW, BLACK)}',
        f'{color(random.choice(FNY_TAGLINES), CYAN)}',
        f'{B}{color(random.choice(HYPE_VERBS).upper(), LIME)}{B} :: {random.choice(CALL_TO_ACTIONS)}',
    ]


def msg_friday_teaser(hours_left):
    head = random.choice(FNY_HEADERS)
    when = f'T-MINUS {hours_left}H'
    return [
        f'{spark()} {banner(head, WHITE, PURPLE)} {spark()} {color(when, ORANGE)}',
        f'{color(random.choice(FNY_TAGLINES), CYAN)}',
        f'{B}Tonight 9pm EST on{B} {U}{HARDCHATS}{U}',
    ]


# show and tell --------------------------------------------------------

ST_HEADERS = (
    'SHOW & TELL',
    'SHOW AND TELL',
    '>>> SHOW AND TELL <<<',
    '<<< SHOW & TELL >>>',
    'MONTHLY SHOW & TELL',
    '[ SHOW + TELL ]',
    '[[ SHOW AND TELL ]]',
    '// SHOW AND TELL //',
    ':: SHOW AND TELL ::',
    '*** SHOW & TELL ***',
    'SHOW & TELL // MONTHLY',
)

# what S&T actually is: flex what youve been building or vibe coding
ST_PROMPTS = (
    'Show off what youve been vibe coding',
    'Flex what you built',
    'Demo your project, your tool, your hack',
    'Built something? Show it off',
    'Screenshare your build and walk us through it',
    'Doesnt have to be finished, show what youve got',
    'See what everyone else has been building',
    'Show off your side project',
)


def msg_show_and_tell():
    head = random.choice(ST_HEADERS)
    when = color(f'{B}FIRST MONDAY OF EVERY MONTH @ 9PM EST{B}', YELLOW)
    return [
        f'{spark()} {banner(head, WHITE, BLUE)} {spark()} {when}',
        f'{color(random.choice(ST_PROMPTS), LIME)}',
        f'{random.choice(CALL_TO_ACTIONS)}',
    ]


# lunch and learn ------------------------------------------------------

LL_HEADERS = (
    'LUNCH & LEARN',
    'LUNCH AND LEARN',
    'LUNCH N LEARN',
    '[[ LUNCH + LEARN ]]',
    '<< LUNCH AND LEARN >>',
    '// LUNCH & LEARN //',
    ':: LUNCH N LEARN ::',
    '*** LUNCH & LEARN ***',
    '[ LUNCH + LEARN ]',
)

# what L&L actually is: tech chats -- show off something or learn something
LL_TOPICS = (
    'Tech discussion, bring a topic',
    'Show off something you learned this week',
    'Stuck on something? Get a fresh set of eyes',
    'Talk tools, workflows, and whatever new tech youre into',
    'Learn something, teach something',
    'AI workflows, dev setups, how you actually work',
    'Bring a question, leave with an answer',
    'Share a trick you picked up',
    'Casual tech talk over lunch',
)


def msg_lunch_now():
    head = random.choice(LL_HEADERS)
    return [
        f'{spark()} {banner(head, WHITE, GREEN)} {spark()} {color(B + "LIVE NOW" + B, YELLOW, BLACK)}',
        f'{color(random.choice(LL_TOPICS), CYAN)}',
        f'{random.choice(CALL_TO_ACTIONS)}',
    ]


def msg_lunch_teaser():
    head = random.choice(LL_HEADERS)
    return [
        f'{spark()} {banner(head, WHITE, GREEN)} {spark()} {color("Today @ 2PM EST", ORANGE)}',
        f'{color(random.choice(LL_TOPICS), CYAN)}',
        f'{B}Today 2pm EST on{B} {U}{HARDCHATS}{U}',
    ]


# !events --------------------------------------------------------------

def _event_row(name, when, blurb, name_fg):
    return [
        f'  {B}{color(name, name_fg)}{B}  {color(when, YELLOW)}',
        f'    {color(blurb, CYAN)}',
    ]


def msg_events():
    title = banner('HARDCHATS // EVENTS', WHITE, PURPLE)
    rows  = []
    rows += _event_row('FRIDAY NIGHT YAPS', 'Every Fri @ 9PM EST',
                       'Hacking, showing off, terminal streaming, shenanigans, drinking, chaos, etc', LIME)
    rows += _event_row('LUNCH & LEARN',     'Every Wed @ 2PM EST',
                       'Show off what you learned, AI workflows, get help, share methodologies', ORANGE)
    rows += _event_row('SHOW & TELL',       '1st Monday of the month @ 9PM EST',
                       'Show off what you built, see others work, find collaborators', PINK)
    return [
        f'{divider(46)}',
        f'  {title}',
        *rows,
        f'  {B}{color("ALL EVENTS HAPPEN ON", RED)}{B} {U}{HARDCHATS}{U}',
        f'{divider(46)}',
    ]


# === irc client =======================================================

class IRC:
    def __init__(self):
        self.reader = None
        self.writer = None
        self.nick   = NICK
        self.pending_pw = None   # password sent with REGISTER, saved once NickServ confirms

    async def connect(self):
        ctx = ssl.create_default_context() if USE_TLS else None
        self.reader, self.writer = await asyncio.open_connection(SERVER, PORT, ssl=ctx)
        await self.send(f'NICK {self.nick}')
        await self.send(f'USER {USERNAME} 0 * :{REALNAME}')

    async def send(self, line, secret=None):
        if self.writer is None or self.writer.is_closing():
            return
        line = line.replace('\r', '').replace('\n', ' ')[:480]
        print(f'>> {line.replace(secret, "***") if secret else line}', flush=True)
        self.writer.write((line + '\r\n').encode('utf-8', 'replace'))
        await self.writer.drain()

    async def privmsg(self, target, lines):
        for line in lines:
            await self.send(f'PRIVMSG {target} :{line}')
            await asyncio.sleep(SEND_DELAY)

    async def announce(self, lines):
        for ch in CHANNELS:
            await self.privmsg(ch, lines)

    # --- live room join/leave announcements (called from server.py) -----

    async def _safe_privmsg(self, channel, lines):
        """Send only if currently connected; never let an IRC hiccup bubble
        into the web server's join/leave handling."""
        if self.writer is None or self.writer.is_closing():
            return
        try:
            await self.privmsg(channel, lines)
        except Exception as e:
            print(f'[!] announce failed: {e!r}', file=sys.stderr, flush=True)

    async def announce_join(self, username):
        line = (f'🟢 {B}{color(username, CYAN)}{B} '
                f'{color("is yappin", GREEN)} '
                f'{color("// " + HARDCHATS, GREY)}')
        for ch in YAP_CHANNELS:
            await self._safe_privmsg(ch, [line])

    async def announce_leave(self, username):
        line = (f'🔴 {B}{color(username, ORANGE)}{B} '
                f'{color("left yaps", RED)}')
        for ch in YAP_CHANNELS:
            await self._safe_privmsg(ch, [line])

    async def _delayed_join(self, delay):
        await asyncio.sleep(delay)
        for ch in dict.fromkeys(CHANNELS + YAP_CHANNELS):
            await self.send(f'JOIN {ch}')

    async def _delayed_rejoin(self, channel, delay):
        await asyncio.sleep(delay)
        await self.send(f'JOIN {channel}')

    async def _nickserv_setup(self):
        """If we have a stored password, identify. Otherwise wait
        REGISTER_AFTER seconds and register NICK. The password is written
        to PASSWORD_PATH by handle() when NickServ sets +r on us."""
        pw = PASSWORD_PATH.read_text().strip() if PASSWORD_PATH.exists() else ''
        if pw:
            await asyncio.sleep(2)
            await self.send(f'PRIVMSG NickServ :IDENTIFY {pw}', pw)
            print(f'[*] sent NickServ IDENTIFY (using stored password)', flush=True)
            return

        print(f'[*] nickserv registration scheduled in {REGISTER_AFTER:.0f}s', flush=True)
        await asyncio.sleep(REGISTER_AFTER)

        if PASSWORD_PATH.exists() and PASSWORD_PATH.read_text().strip():
            return  # something else won the race
        if self.pending_pw:
            return  # a registration is already in flight
        if self.nick != NICK:
            print(f'[!] not registering fallback nick {self.nick}', file=sys.stderr, flush=True)
            return

        self.pending_pw = gen_password(PASSWORD_LEN)
        await self.send(f'PRIVMSG NickServ :REGISTER {self.pending_pw}', self.pending_pw)

    async def read_loop(self):
        while True:
            try:
                raw = await asyncio.wait_for(self.reader.readline(), timeout=300)
            except asyncio.TimeoutError:
                raise ConnectionError('read timeout (no traffic in 5min)')
            if not raw:
                raise ConnectionError('disconnected by peer')
            line = raw.decode('utf-8', 'replace').rstrip('\r\n')
            if not line:
                continue
            print(f'<< {line}', flush=True)
            await self.handle(line)

    async def handle(self, line):
        prefix = ''
        if line.startswith(':'):
            prefix, _, line = line[1:].partition(' ')

        head, sep, trailing = line.partition(' :')
        args = head.split()
        if sep:
            args.append(trailing)
        if not args:
            return
        cmd = args[0].upper()

        if cmd == 'PING':
            await self.send(f'PONG :{args[-1]}')
            return

        if cmd == '001':
            asyncio.create_task(self._delayed_join(JOIN_DELAY))
            asyncio.create_task(self._nickserv_setup())
            return

        if cmd == '433':
            self.nick = f'{NICK}{random.randint(100, 999)}'
            await self.send(f'NICK {self.nick}')
            return

        # NickServ sets +r on us once REGISTER succeeds - only then persist the password
        if cmd == 'MODE' and len(args) >= 3 and args[1].lower() == self.nick.lower() and '+r' in args[2] and self.pending_pw:
            try:
                PASSWORD_PATH.write_text(self.pending_pw)
                PASSWORD_PATH.chmod(0o600)
                print(f'[*] nickserv registered {self.nick}, password saved to {PASSWORD_PATH.name}', flush=True)
            except Exception as e:
                print(f'[!] could not persist password: {e}', file=sys.stderr, flush=True)
            self.pending_pw = None
            return

        if cmd == 'JOIN' and len(args) >= 2:
            who     = prefix.split('!', 1)[0]
            channel = args[1].lstrip(':')
            if who.lower() == self.nick.lower() and channel.lower() in (c.lower() for c in BLACKHOLE_CHANNELS):
                await self.send(f'PART {channel} :nope')
            return

        if cmd == 'KICK' and len(args) >= 3:
            channel = args[1]
            victim  = args[2]
            if victim.lower() == self.nick.lower() and channel.lower() not in (c.lower() for c in BLACKHOLE_CHANNELS):
                asyncio.create_task(self._delayed_rejoin(channel, REJOIN_DELAY))
            return

        if cmd == 'PRIVMSG' and len(args) >= 3:
            target = args[1]
            text   = args[2].strip()
            sender = prefix.split('!', 1)[0]
            parts  = text.split()
            if not parts:
                return
            verb     = parts[0].lower()
            sub      = parts[1].lower() if len(parts) > 1 else ''
            reply_to = target if target.startswith('#') else sender

            if verb == '!events':
                await self.privmsg(reply_to, msg_events())
            elif verb == '!testevents' and sender.lower() == OWNER_NICK.lower():
                await self.run_testevents(reply_to, sub)

    async def run_testevents(self, reply_to, sub):
        """Fire the actual announcement output on demand, exactly as it would appear in channel."""
        catalog = {
            'friday':        msg_friday_now,
            'friday-teaser': lambda: msg_friday_teaser(4),
            'lunch':         msg_lunch_now,
            'lunch-teaser':  msg_lunch_teaser,
            'showtell':      msg_show_and_tell,
            'events':        msg_events,
        }

        if sub in ('help', '?'):
            await self.privmsg(reply_to, [
                f'{spark()} {color(B + "!testevents" + B, YELLOW)} '
                f'{color("[" + " | ".join(catalog) + "]", CYAN)}',
                f'  {color("No arg = fire all of them in order", GREY)}',
            ])
            return

        if sub and sub in catalog:
            keys = [sub]
        elif sub:
            await self.privmsg(reply_to, [
                f'{color("Unknown variant:", RED)} {sub}  '
                f'{color("Try: " + " | ".join(catalog), CYAN)}',
            ])
            return
        else:
            keys = list(catalog)

        sep = color('-' * 50, GREY)
        for i, key in enumerate(keys):
            if i > 0:
                await self.privmsg(reply_to, [sep])
            await self.privmsg(reply_to, catalog[key]())

    async def run(self):
        """Connect, run the scheduled-announcement tasks, and reconnect with
        exponential backoff. Cancelling this task (server on_cleanup) unwinds
        cleanly - CancelledError is a BaseException, so it skips the reconnect
        handlers below and runs the finally block on its way out."""
        delay = 5
        while True:
            connected = False
            tasks = []
            try:
                await self.connect()
                connected = True
                tasks = [
                    asyncio.create_task(self.read_loop()),
                    asyncio.create_task(task_friday_yaps(self)),
                    asyncio.create_task(task_lunch_learn(self)),
                    asyncio.create_task(task_show_and_tell(self)),
                ]
                done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_EXCEPTION)
                for t in pending:
                    t.cancel()
                for t in done:
                    exc = t.exception()
                    if exc:
                        raise exc
            except (ConnectionError, OSError, ssl.SSLError) as e:
                print(f'[!] connection error: {e}', file=sys.stderr, flush=True)
            except Exception as e:
                print(f'[!] error: {e!r}', file=sys.stderr, flush=True)
            finally:
                for t in tasks:
                    if not t.done():
                        t.cancel()
                try:
                    if self.writer and not self.writer.is_closing():
                        self.writer.close()
                        await self.writer.wait_closed()
                except Exception:
                    pass
                self.reader = None
                self.writer = None

            delay = 5 if connected else min(delay * 2, 300)
            print(f'[*] reconnecting in {delay}s', file=sys.stderr, flush=True)
            await asyncio.sleep(delay)


# === scheduling =======================================================

def now_tz():
    return datetime.now(TZ)


def next_weekday_at(weekday, hour, minute=0):
    """next datetime in TZ on the given weekday (0=Mon..6=Sun) at hour:minute."""
    n = now_tz()
    target = n.replace(hour=hour, minute=minute, second=0, microsecond=0)
    days_ahead = (weekday - n.weekday()) % 7
    if days_ahead == 0 and target <= n:
        days_ahead = 7
    return target + timedelta(days=days_ahead)


async def sleep_until(target):
    while True:
        delta = (target - now_tz()).total_seconds()
        if delta <= 0:
            return
        # cap each sleep so DST/clock changes are picked up
        await asyncio.sleep(min(delta, 1800))


async def task_friday_yaps(irc):
    while True:
        nxt   = next_weekday_at(4, 21)                 # fri 9pm EST
        tease = nxt - timedelta(hours=4)               # 5pm same day
        if now_tz() < tease:
            await sleep_until(tease)
            await irc.announce(msg_friday_teaser(4))
        await sleep_until(nxt)
        await irc.announce(msg_friday_now())
        await asyncio.sleep(90)


async def task_lunch_learn(irc):
    while True:
        nxt   = next_weekday_at(2, 14)                 # wed 2pm EST
        tease = nxt - timedelta(hours=2)               # noon same day
        if now_tz() < tease:
            await sleep_until(tease)
            await irc.announce(msg_lunch_teaser())
        await sleep_until(nxt)
        await irc.announce(msg_lunch_now())
        await asyncio.sleep(90)


async def task_show_and_tell(irc):
    """fire 3-5 random reminders spread across each rolling 7-day window."""
    while True:
        n = now_tz()
        count = random.randint(*SHOWTELL_PER_WEEK)
        slots = []
        for _ in range(count):
            day_off = random.randint(0, 6)
            hour    = random.randint(13, 22)            # 1pm - 10pm EST
            minute  = random.choice((0, 7, 13, 23, 37, 42, 51))
            t = (n + timedelta(days=day_off)).replace(
                hour=hour, minute=minute, second=0, microsecond=0
            )
            if t > n + timedelta(minutes=2):
                slots.append(t)
        slots.sort()
        for t in slots:
            await sleep_until(t)
            await irc.announce(msg_show_and_tell())
        # ride out the rest of the 7-day window before re-rolling
        await sleep_until(n + timedelta(days=7))


# === singleton + entrypoint ===========================================

# Shared instance. server.py starts bot.run() as an on_startup task and calls
# bot.announce_join / bot.announce_leave from the websocket join/leave paths.
bot = IRC()


if __name__ == '__main__':
    # Standalone mode (e.g. for testing outside the hardchats server).
    try:
        asyncio.run(bot.run())
    except KeyboardInterrupt:
        pass
