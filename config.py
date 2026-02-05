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
VERSION = '1.0.0'

# Server settings
SERVER_HOST = '0.0.0.0'
SERVER_PORT = 58080
MAX_USERS   = 25
MAX_CAMERAS = 10

# TURN/STUN settings
STUN_SERVER = f'stun:{os.getenv('TURN_SERVER')}:{os.getenv('TURN_PORT')}'
TURN_SERVER = {
	'host'       : os.getenv('TURN_SERVER'),
	'port'       : os.getenv('TURN_PORT'),
	'username'   : os.getenv('TURN_USERNAME'),
	'credential' : os.getenv('TURN_PASSWORD')
}
ICE_TRANSPORT_POLICY = 'relay'


# IRC settings
IRC_SERVER          = f'wss://{os.getenv('IRC_SERVER')}:{os.getenv('IRC_PORT')}'
IRC_CHANNEL         = f'#{os.getenv('IRC_CHANNEL')}'
IRC_PROTOCOLS       = ['text.ircv3.net', 'binary.ircv3.net']
IRC_USER            = 'yapper'
IRC_REALNAME        = 'https://dev.hardchats.com/'
IRC_MAX_NICK_LENGTH = 20
IRC_RECONNECT_DELAY = 15000 # milliseconds
IRC_JOIN_DELAY      = 3000  # milliseconds (delay before joining channel)
IRC_MAX_BACKLOG     = 5000  # max messages to keep in chat history


def get_client_config():
	'''Returns configuration needed by the JavaScript client'''

	return {
		'version'     : VERSION,
		'max_users'   : MAX_USERS,
		'max_cameras' : MAX_CAMERAS,
		'turn'        : {
			'stun_url'             : STUN_SERVER,
			'host'                 : TURN_SERVER['host'],
			'port'                 : TURN_SERVER['port'],
			'username'             : TURN_SERVER['username'],
			'credential'           : TURN_SERVER['credential'],
			'ice_transport_policy' : ICE_TRANSPORT_POLICY
		},
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

