#!/usr/bin/env python3
"""
hardchats irc bot
-----------------
pure-stdlib async irc bot for irc.supernets.org, baked into the hardchats
server (started as an asyncio task from server.py's on_startup). posts:
  - scheduled announcements about hardchats community events in #superbowl
    and #hardchats, and answers !events / !testevents on demand
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
NICK       = 'EVENTS'
USERNAME   = 'eventbot'
REALNAME   = 'https://hardchats.com'
CHANNELS   = ('#superbowl', '#hardchats')
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

# nickserv registration: after the bot has been connected this long,
# register the current nick (no email), DM the password to OWNER_NICK,
# and identify. password persists in PASSWORD_PATH so reconnects skip
# straight to identify.
OWNER_NICK     = 'acidvegas'
REGISTER_AFTER = 1.5 * 60 * 60   # 1.5 hours in seconds
PASSWORD_LEN   = 20
PASSWORD_PATH  = pathlib.Path(__file__).resolve().parent / 'nick_password.txt'


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
    'tune in', 'come thru', 'jack in', 'log on', 'beam in',
    'slide in', 'swing through', 'fall through', 'ssh in', 'dial in',
    'plug in', 'sync up', 'cruise by', 'materialize', 'spawn in',
    'instantiate', 'boot up', 'mosey on over', 'port in', 'tab over',
    'link up', 'warp in', 'queue up', 'mosh in', 'ride in',
    'show up', 'check in', 'pop in', 'roll thru', 'come hang',
    'connect', 'sign on', 'load in', 'drop a connection',
)

VENUE_NOTE  = color('(WebRTC voice + video, no tracking)', GREY)
VENUE_NOTE2 = color('(no signup, no app, just a browser)', GREY)
VENUE_NOTE3 = color('(free, open, noscript-friendly)', GREY)
VENUE_NOTE4 = color('(mics + cams welcome, lurkers too)', GREY)

# every CTA explicitly names hardchats.com as the location of the event
CALL_TO_ACTIONS = (
    f'{B}Happening on{B} {U}{HARDCHATS}{U} {VENUE_NOTE}',
    f'{B}Live on{B} {U}{HARDCHATS}{U} {VENUE_NOTE}',
    f'{B}Join us on{B} {U}{HARDCHATS}{U}',
    f'{B}Where:{B} {U}{HARDCHATS}{U} {color("// fire up your mic + cam", GREY)}',
    f'{B}This is on{B} {U}{HARDCHATS}{U} {VENUE_NOTE}',
    f'{B}All going down at{B} {U}{HARDCHATS}{U}',
    f'{B}Hop on{B} {U}{HARDCHATS}{U} {VENUE_NOTE4}',
    f'{B}Pull up at{B} {U}{HARDCHATS}{U} {VENUE_NOTE}',
    f'{B}Come yap on{B} {U}{HARDCHATS}{U} {VENUE_NOTE}',
    f'{B}See you at{B} {U}{HARDCHATS}{U} {VENUE_NOTE2}',
    f'{B}Meet us at{B} {U}{HARDCHATS}{U}',
    f'{B}Point your browser at{B} {U}{HARDCHATS}{U} {VENUE_NOTE2}',
    f'{B}URL:{B} {U}{HARDCHATS}{U} {VENUE_NOTE3}',
    f'{B}Slide into{B} {U}{HARDCHATS}{U} {VENUE_NOTE4}',
    f'{B}We are at{B} {U}{HARDCHATS}{U} {VENUE_NOTE2}',
    f'{B}Drop in to{B} {U}{HARDCHATS}{U} {VENUE_NOTE}',
    f'{B}Link:{B} {U}{HARDCHATS}{U} {VENUE_NOTE2}',
    f'{B}Venue:{B} {U}{HARDCHATS}{U} {VENUE_NOTE}',
    f'{B}Go to{B} {U}{HARDCHATS}{U} {VENUE_NOTE3}',
    f'{B}Meet at{B} {U}{HARDCHATS}{U} {VENUE_NOTE4}',
    f'{B}Roll up to{B} {U}{HARDCHATS}{U} {VENUE_NOTE}',
)


# friday night yaps ----------------------------------------------------

FNY_HEADERS = (
    'FRIDAY NIGHT YAPS',
    'FRIDAY NIGHT HACKS',
    'FRIDAY NIGHT CHATS',
    '>> FRIDAY NIGHT YAPS <<',
    '<<< FRIDAY NIGHT HACKS >>>',
    '[ FRIDAY NIGHT MOTHERFUCKIN HACKS ]',
    '// FRIDAY NIGHT YAPS //',
    ':: FRIDAY NIGHT YAPS ::',
    '** FRIDAY NIGHT HACKS **',
    '$$$ FRIDAY NIGHT YAPS $$$',
    'FRIDAY.NIGHT.HACKS',
    'FRIDAY NIGHT [REDACTED]',
    'FRIDAY NIGHT TERMINAL JAMS',
    '$ ./fny --start',
    'HACK NIGHT',
    'HACK THE PLANET',
    'HACK THE FUCKING PLANET',
    'sudo friday-night-yaps',
    'weekend.hack()',
    'FRIDAY NIGHT VIBE CODE JAM',
    'FRINIGHT HACKS',
)

# what FNY actually is: live hacking, terminal streams, vibe coding,
# collaboration, hack-the-planet chaos
FNY_TAGLINES = (
    'Live hacking, terminal streams, vibe coding, chaos',
    'Stream your terminal, show off what youre hacking on',
    'Live code, live break, live fix',
    'Screenshare your stack, your dotfiles, your half-broken hack',
    'Vibe coding + collab + hack-the-planet energy',
    'Pair on your hack, find collaborators, fuck shit up',
    'Demo your novel hacks, weird tools, dumb ideas',
    'Collab on something, break something, ship something',
    'Hacker hangout: terminal share + vibe code + yap',
    'Novel hacks, weird stacks, late night chaos',
    'Live stream your shit, watch others stream theirs',
    'Come hack, come collab, come HACK THE FUCKING PLANET',
    'Free-form hacking with friends',
    'Show me what youre building, show me what youre breaking',
    'Co-hack, co-debug, co-vibe',
    'Open terminals, open repos, open chaos',
    'Hack the planet, vibe code, find your people',
    'Late night hacking, no agenda, all energy',
    'Novel exploits, weird tools, vibe-coded bullshit',
    'Cover your webcam, open your terminal, log on',
)

FNY_MOODS = (
    'Lights low, terminals open',
    'Mics hot, energy higher',
    'Screens dim, ideas bright',
    'Cursor blinking, brain humming',
    'Monospace fonts, monospace vibes',
    'Caps lock off, creativity on',
    'Tabs over spaces, friends over deadlines',
    'Nvim open, nothing else matters',
    'Desk lamp on, ego off',
    'One mic, three monitors, no plan',
    'Fans whirring, ideas swirling',
    'Tmux panes everywhere, zero regrets',
    'Late night, low light, high focus',
    'IDE wide open, coffee long cold',
    'Kernels patched, vibes immaculate',
    'Compilers warm, brains hot',
    'Screen flicker, mind sharp',
    'Lo-fi loops, high focus',
    'Too much pizza, just enough segfaults',
    'Thinkpads thinking, minds melting',
    'Vim configs ricer than your apartment',
    'Mechanical keyboards, mechanical thoughts',
    'Monitors humming, brain too',
    'Midnight committers in their natural habitat',
    'Discord muted, terminal unmuted',
    'RGB everywhere, regrets nowhere',
)


def msg_friday_now():
    head = random.choice(FNY_HEADERS)
    return [
        f'{spark()} {banner(head, WHITE, RED)} {spark()} {color(B + "STARTING NOW" + B, YELLOW, BLACK)}',
        f'{color(random.choice(FNY_TAGLINES), CYAN)} -- {color(random.choice(FNY_MOODS), PINK)}',
        f'{B}{color(random.choice(HYPE_VERBS).upper(), LIME)}{B} :: {random.choice(CALL_TO_ACTIONS)}',
    ]


def msg_friday_teaser(hours_left):
    head = random.choice(FNY_HEADERS)
    when = f'T-MINUS {hours_left}H'
    return [
        f'{spark()} {banner(head, WHITE, PURPLE)} {spark()} {color(when, ORANGE)}',
        f'{color(random.choice(FNY_TAGLINES), CYAN)} -- {color(random.choice(FNY_MOODS), PINK)}',
        f'{B}Tonight 9pm EST on{B} {U}{HARDCHATS}{U} {VENUE_NOTE}',
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
    '// SHOW.AND.TELL //',
    ':: SHOW AND TELL ::',
    '*** SHOW & TELL ***',
    'SHOW & TELL // MONTHLY',
    'DEMO MONDAY',
    'DEMO NIGHT',
    'SHOWCASE NIGHT',
    'THE DEMO MONDAY',
    'show.tell()',
    'show_and_tell.init()',
    '$ ./showtell',
    'SHOW & TELL :: monthly',
    'MONTHLY DEMO JAM',
)

# what S&T actually is: demo what youve been building, see others'
# work, find collaborators, get inspired -- becoming a contest w/ prizes
ST_PROMPTS = (
    'Demo what youve been building',
    'Show off your latest project',
    'Demo what youve been vibe coding',
    'Pitch your project, get feedback',
    'Show 5 minutes of your latest build',
    'Screenshare your work, walk us through it',
    'Show what youre proud of, what youre stuck on, what youve shipped',
    'Demo your tools, your scripts, your apps',
    'Pitch your idea, find co-conspirators',
    'Show the project youve been keeping under wraps',
    'Flex your build, get inspired by others',
    'Demo your codebase, your stack, your hack',
    'Show off, see others show off, find collaborators',
    'Present your work, no slides required',
    'Demo your side project, your weekend hack, your magnum opus',
    'Pitch what youre building, get others on board',
    'Live demo your latest thing',
    'Show the thing youre weirdly proud of',
)

ST_FILLER = (
    'Demo, watch demos, find collaborators, get inspired',
    'Monthly demo night',
    'Soon to be a contest -- monthly prizes incoming',
    'PRIZES coming soon -- monthly winners get rewarded',
    'See what others are building, get inspired',
    'Find collaborators, get unstuck, share what youre building',
    'Come demo, come watch, come get ideas',
    'Doesnt have to be done -- show what you have',
    'Works on my machine = good enough to demo',
    'Collabs born here, projects ship from here',
    '5 minute demos, infinite inspiration',
    'Lurkers welcome, demoers welcomer',
    'Come for the demos, stay for the collabs',
    'Bring repos, bring screenshots, bring questions',
    'Demos welcome from any stack, any state of done-ness',
    'Pitch something, get feedback, find your people',
    'This turns into a contest with prizes -- get warmed up',
    'Audience of devs, no judgement, all curiosity',
    'Find people to build with, find people to learn from',
    'Come show off the work nobody at your job appreciates',
)


def msg_show_and_tell():
    head = random.choice(ST_HEADERS)
    when = color(f'{B}FIRST MONDAY OF EVERY MONTH @ 9PM EST{B}', YELLOW)
    return [
        f'{spark()} {banner(head, WHITE, BLUE)} {spark()} {when}',
        f'{color(random.choice(ST_PROMPTS), LIME)} -- {color(random.choice(ST_FILLER), CYAN)}',
        f'{random.choice(CALL_TO_ACTIONS)}',
    ]


# lunch and learn ------------------------------------------------------

LL_HEADERS = (
    'LUNCH & LEARN',
    'LUNCH AND LEARN',
    'LUNCH N LEARN',
    '[[ LUNCH + LEARN ]]',    '<< LUNCH AND LEARN >>',
    '// LUNCH.LEARN //',
    ':: LUNCH N LEARN ::',
    '*** LUNCH & LEARN ***',
    '[ LUNCH + LEARN ]',
    'LUNCHBREAK CHATS',
    'LUNCH+LEARN.EXE',
    'WED LUNCH JAM',
    'lunch.learn()',
    '$ ./lunch-and-learn',
    'WEDNESDAY OFFICE HOURS',
    'lunch_and_learn.init()',
    'WED MIDDAY DEV CHAT',
    'MIDWEEK TECH TALK',
)

# what L&L actually is: techy discussion -- show off what you learned,
# AI workflows, get help on a problem, share methodology
LL_TOPICS = (
    'Show off something you learned this week',
    'Discuss AI workflows, share what works',
    'Ask for help on a problem, get unstuck',
    'Share a methodology, debate a methodology',
    'Techy discussion, no agenda, just devs talking shop',
    'Share new tools, novel approaches, weird tricks',
    'AI tooling, prompting strategies, workflow shares',
    'Pair on a problem, get a fresh perspective',
    'Walk through your dev setup, your prompt stack, your pipeline',
    'Show off the trick you figured out this week',
    'Ask questions about your stack, get real answers',
    'Share what youre learning, learn what others share',
    'AI workflow show-and-tell',
    'Open mic for technical questions',
    'Come learn something, come teach something',
    'Demo your workflow, swap tips, refine your stack',
    'Discuss tools, methodologies, new tech',
    'Bring a problem, leave with a plan',
    'Show off a clever solve, hear about clever solves',
    'Discuss the weird new framework, the wild new tool',
    'Walk through how you actually use AI day-to-day',
    'Methodology talk, tooling talk, stack talk',
)

LL_HINTS = (
    'Bring questions, bring topics, bring discoveries',
    'No agenda, no slides, just techy chat',
    'The wednesday office hours nobody booked',
    'Mics optional, topics encouraged',
    'Lurk and learn, or pitch in',
    'Come learn, come teach, come ask',
    'Pair-program through problems',
    'AI workflows, dev setups, methodologies -- whatever',
    'Open mics, open questions, open answers',
    'No question is too dumb, no method too weird',
    'Discussion-format, casual but technical',
    'Ask the dumb question, get the smart answer',
    'Share something you learned, ask something youre stuck on',
    'Bring your AI workflow, your prompt stack, your weird trick',
    'The lunch break that teaches you something',
    'Show your work, get help, share methods',
    'Techy yap, but make it productive',
)


def msg_lunch_now():
    head = random.choice(LL_HEADERS)
    return [
        f'{spark()} {banner(head, WHITE, GREEN)} {spark()} {color(B + "LIVE NOW" + B, YELLOW, BLACK)}',
        f'{color(random.choice(LL_TOPICS), CYAN)} -- {color(random.choice(LL_HINTS), PINK)}',
        f'{random.choice(CALL_TO_ACTIONS)}',
    ]


def msg_lunch_teaser():
    head = random.choice(LL_HEADERS)
    return [
        f'{spark()} {banner(head, WHITE, GREEN)} {spark()} {color("Today @ 2PM EST", ORANGE)}',
        f'{color(random.choice(LL_TOPICS), CYAN)} -- {color(random.choice(LL_HINTS), PINK)}',
        f'{B}Today 2pm EST on{B} {U}{HARDCHATS}{U} {VENUE_NOTE}',
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
                       'Show off what you built, see others work, find collaborators (contest + prizes soon)', PINK)
    return [
        f'{divider(46)}',
        f'  {title}',
        *rows,
        f'  {B}{color("ALL EVENTS HAPPEN ON", RED)}{B} {U}{HARDCHATS}{U}',
        f'    {color("WebRTC voice/video group chat, IRC text backend", GREY)}',
        f'{divider(46)}',
    ]


# === irc client =======================================================

class IRC:
    def __init__(self):
        self.reader = None
        self.writer = None
        self.nick   = NICK

    async def connect(self):
        ctx = ssl.create_default_context() if USE_TLS else None
        self.reader, self.writer = await asyncio.open_connection(SERVER, PORT, ssl=ctx)
        await self.send(f'NICK {self.nick}')
        await self.send(f'USER {USERNAME} 0 * :{REALNAME}')

    async def send(self, line):
        if self.writer is None or self.writer.is_closing():
            return
        line = line.replace('\r', '').replace('\n', ' ')[:480]
        print(f'>> {line}', flush=True)
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
        line = (f'{color(B + ">>" + B, LIME)} {B}{color(username, CYAN)}{B} '
                f'{color("hopped into the yap", GREEN)} '
                f'{color("// " + HARDCHATS, GREY)}')
        await self._safe_privmsg('#hardchats', [line])

    async def announce_leave(self, username):
        line = (f'{color(B + "<<" + B, RED)} {B}{color(username, ORANGE)}{B} '
                f'{color("bailed from the yap", RED)}')
        await self._safe_privmsg('#hardchats', [line])

    async def _delayed_join(self, delay):
        await asyncio.sleep(delay)
        for ch in CHANNELS:
            await self.send(f'JOIN {ch}')

    async def _delayed_rejoin(self, channel, delay):
        await asyncio.sleep(delay)
        await self.send(f'JOIN {channel}')

    async def _nickserv_setup(self):
        """If we have a stored password, identify. Otherwise wait
        REGISTER_AFTER seconds, register the nick (no email), DM the
        password to OWNER_NICK + send a memo, and identify."""
        if PASSWORD_PATH.exists():
            pw = PASSWORD_PATH.read_text().strip()
            if pw:
                await asyncio.sleep(2)
                await self.send(f'PRIVMSG NickServ :IDENTIFY {pw}')
                print(f'[*] sent NickServ IDENTIFY (using stored password)', flush=True)
                return

        print(f'[*] nickserv registration scheduled in {REGISTER_AFTER:.0f}s', flush=True)
        await asyncio.sleep(REGISTER_AFTER)

        if PASSWORD_PATH.exists():
            return  # something else won the race

        pw = gen_password(PASSWORD_LEN)
        try:
            PASSWORD_PATH.write_text(pw)
            try:
                PASSWORD_PATH.chmod(0o600)
            except Exception:
                pass
        except Exception as e:
            print(f'[!] could not persist password: {e}', file=sys.stderr, flush=True)

        # supernets/atheme accepts REGISTER <password> with no email when
        # email is optional; if your network requires email, append one here
        await self.send(f'PRIVMSG NickServ :REGISTER {pw}')

        msg = f'NickServ password for {self.nick} on {SERVER}: {pw}'
        await self.send(f'PRIVMSG {OWNER_NICK} :{msg}')
        # also memo, in case the owner is offline
        await self.send(f'PRIVMSG MemoServ :SEND {OWNER_NICK} {msg}')

        await asyncio.sleep(3)
        await self.send(f'PRIVMSG NickServ :IDENTIFY {pw}')
        print(f'[*] nickserv registered + identified as {self.nick}', flush=True)

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
            elif verb == '!testevents':
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
