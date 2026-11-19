#!/usr/bin/env python3
# HARDCHATS WebRTC Voice/Video Server - Developed by acidvegas (https://github.com/acidvegas/hardchats)
# hardchats/config.py

import os

# Load environment variables if .env file exists (otherwise set by Docker -e flags)
if os.path.exists('.env'):
	try:
		from dotenv import load_dotenv
	except ImportError:
		raise ImportError('missing python-dotenv library (pip install python-dotenv)')
	else:
		load_dotenv()


# Version
VERSION = '2.0.0'

# Optional HTML shown in the page footer next to the version (empty = nothing)
LOGIN_NOTICE = os.getenv('LOGIN_NOTICE', '')

# Server settings
SERVER_HOST = '0.0.0.0'
SERVER_PORT = 58080
MAX_USERS   = 25
MAX_CAMERAS = 10

# LiveKit SFU settings
LIVEKIT_URL        = os.getenv('LIVEKIT_URL')                             # Public signaling URL the browser connects to (wss://...)
LIVEKIT_API_URL    = os.getenv('LIVEKIT_API_URL', 'http://127.0.0.1:7880') # Server-side RoomService URL
LIVEKIT_API_KEY    = os.getenv('LIVEKIT_API_KEY')
LIVEKIT_API_SECRET = os.getenv('LIVEKIT_API_SECRET')
LIVEKIT_ROOM       = 'hardchats'
LIVEKIT_TOKEN_TTL  = 600 # seconds, only used for the initial connect (LiveKit refreshes it while connected)
E2EE_MAX_PAYLOAD   = 2048 # bytes, cap on relayed key-exchange messages

# Client diagnostics: browsers stream their media/E2EE logs + receive stats to the server log (DIAG_LOGS=1)
DIAG_LOGS = os.getenv('DIAG_LOGS', '0') == '1'


# IRC settings
IRC_SERVER          = f'wss://{os.getenv('IRC_SERVER')}:{os.getenv('IRC_PORT')}'
IRC_CHANNEL         = os.getenv('IRC_CHANNEL')
IRC_PROTOCOLS       = ['text.ircv3.net', 'binary.ircv3.net']
IRC_USER            = 'yapper'
IRC_REALNAME        = 'https://hardchats.com/'
IRC_MAX_NICK_LENGTH = 20
IRC_RECONNECT_DELAY = 15000 # milliseconds
IRC_JOIN_DELAY      = 6000  # milliseconds (delay before joining channel)
IRC_MAX_BACKLOG     = 5000  # max messages to keep in chat history


# IRC bot (scheduled announcements + live join/leave lines), disabled with IRCBOT_ENABLED=0
IRCBOT_ENABLED = os.getenv('IRCBOT_ENABLED', '1') == '1'


# Zulip settings (join/leave announcements, disabled when ZULIP_BOT_KEY is unset)
ZULIP_SITE      = os.getenv('ZULIP_SITE', 'https://zulip.supernets.org')
ZULIP_BOT_EMAIL = os.getenv('ZULIP_BOT_EMAIL')
ZULIP_BOT_KEY   = os.getenv('ZULIP_BOT_KEY')
ZULIP_STREAM    = 'hardchats'
ZULIP_TOPIC     = '' # general chat
USER_AGENT      = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36'


def get_client_config():
	'''Returns configuration needed by the JavaScript client'''

	return {
		'version'     : VERSION,
		'max_users'   : MAX_USERS,
		'max_cameras' : MAX_CAMERAS,
		'livekit_url' : LIVEKIT_URL,
		'diag_logs'   : DIAG_LOGS,
		'irc': {
			'server'          : IRC_SERVER,
			'channel'         : IRC_CHANNEL,
			'protocols'       : IRC_PROTOCOLS,
			'user'            : IRC_USER,
			'realname'        : IRC_REALNAME,
			'max_nick_length' : IRC_MAX_NICK_LENGTH,
			'reconnect_delay' : IRC_RECONNECT_DELAY,
			'join_delay'      : IRC_JOIN_DELAY,
			'max_backlog'     : IRC_MAX_BACKLOG
		}
	}

