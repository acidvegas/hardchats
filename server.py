#!/usr/bin/env python3
# HARDCHATS WebRTC Voice/Video Server - Developed by acidvegas (https://github.com/acidvegas/hardchats)
# hardchats/server.py

import logging
import random
import time
import string
import uuid

try:
	from aiohttp import web
except ImportError:
	raise SystemExit('missing aiohttp library (pip install aiohttp)')

try:
	import apv
except ImportError:
	raise SystemExit('missing apv library (pip install apv)')

import config


# Globals
clients       = {} # client_id -> {ws, username, cam_on, mic_on, screen_on}
captchas      = {} # captcha_id -> {answer, expires}
session_start = None

ALLOWED_CHARS  = string.ascii_letters + string.digits


def generate_captcha():
	'''Generate a random captcha question and answer'''

	# Generate random numbers and operator
	a  = random.randint(1, 20)
	b  = random.randint(1, 20)
	op = random.choice(['+', '-', '*'])

	# Calculate answer and question based on operator
	if op == '+':
		answer   = a + b
		question = f'{a} + {b}'
	elif op == '-':
		if a < b: a, b = b, a
		answer   = a - b
		question = f'{a} - {b}'
	else:
		a, b     = random.randint(1, 10), random.randint(1, 10)
		answer   = a * b
		question = f'{a} × {b}'

	# Generate captcha ID and store in captchas dictionary
	captcha_id           = str(uuid.uuid4())[:8]
	captchas[captcha_id] = {'answer': answer, 'expires': time.time() + 300}

	return captcha_id, question


def verify_captcha(captcha_id: str, user_answer: str) -> bool:
	'''
	Verify if the user's answer is correct for the given captcha ID

	:param captcha_id: The ID of the captcha to verify
	:param user_answer: The user's answer to the captcha
	'''

	# Check if captcha ID is in captchas dictionary
	if captcha_id not in captchas:
		return False

	# Get captcha from dictionary
	captcha = captchas[captcha_id]

	# Check if captcha has expired
	if time.time() > captcha['expires']:
		del captchas[captcha_id]
		return False

	# Try to convert user answer to integer and compare to captcha answer
	try:
		if int(user_answer) == captcha['answer']:
			del captchas[captcha_id]
			return True
	except:
		pass

	return False


def cleanup_captchas():
	'''Cleanup expired captchas'''

	# Get current time
	now = time.time()

	# Get expired captchas
	expired = [k for k, v in captchas.items() if now > v['expires']]

	# Delete expired captchas
	for k in expired:
		del captchas[k]


def get_camera_count() -> int:
	'''Get the number of cameras currently on'''

	return sum(1 for c in clients.values() if c.get('cam_on', False))


async def index(request: web.Request) -> web.Response:
	'''Serve the index.html file'''

	with open('static/index.html', 'r') as f:
		return web.Response(
			text=f.read(), 
			content_type='text/html',
			headers={
				'Cache-Control': 'no-cache, no-store, must-revalidate',
				'Pragma': 'no-cache',
				'Expires': '0'
			}
		)


async def get_captcha(request: web.Request) -> web.Response:
	'''
	Generate a new captcha
	
	:param request: The request object
	'''

	# Cleanup expired captchas
	cleanup_captchas()

	# Generate a new captcha
	captcha_id, question = generate_captcha()

	return web.json_response({'id': captcha_id, 'question': question})


async def get_config(request: web.Request) -> web.Response:
	'''
	Serve client configuration
	
	:param request: The request object
	'''

	return web.json_response(config.get_client_config())


async def get_user_count(request: web.Request) -> web.Response:
	'''
	Get the current number of users in the room
	
	:param request: The request object
	'''
	
	active_users = len([c for c in clients.values() if c['username']])
	return web.json_response({'count': active_users})


async def leave_handler(request: web.Request) -> web.Response:
	'''
	Handle leave requests via beacon/POST (for reliable page unload notification)
	
	:param request: The request object
	'''

	try:
		data = await request.json()
		client_id = data.get('client_id')

		if client_id and client_id in clients:
			logging.info(f'[{client_id}] Leave via beacon')
			await cleanup(client_id)

		return web.Response(status=204)
	except:
		return web.Response(status=400)


async def websocket_handler(request: web.Request) -> web.WebSocketResponse:
	'''
	Handle WebSocket connections
	
	:param request: The request object
	'''

	global session_start

	# Heartbeat of 5 seconds - if client doesn't respond to ping within 5s, connection is closed
	ws = web.WebSocketResponse(heartbeat=5.0)
	await ws.prepare(request)

	client_id = str(uuid.uuid4())[:8]
	clients[client_id] = {'ws': ws, 'username': None, 'cam_on': False, 'mic_on': True, 'screen_on': False}

	logging.info(f'[{client_id}] Connected')

	try:
		async for msg in ws:
			if msg.type == web.WSMsgType.TEXT:
				data = __import__('json').loads(msg.data)
				await handle_message(client_id, data)
			elif msg.type == web.WSMsgType.ERROR:
				logging.error(f'[{client_id}] Error: {ws.exception()}')
	except Exception as e:
		logging.error(f'[{client_id}] Exception: {e}')
	finally:
		await cleanup(client_id)

	return ws


async def handle_message(client_id: str, data: dict):
	'''
	Handle messages from the client
	
	:param client_id: The ID of the client
	:param data: The data from the client
	'''

	global session_start
	msg_type = data.get('type')

	if msg_type == 'join':
		if not verify_captcha(data.get('captcha_id'), data.get('captcha_answer')):
			await clients[client_id]['ws'].send_json({'type': 'error', 'message': 'Invalid captcha'})
			return

		username = data.get('username', '').strip()
		if not all(c in ALLOWED_CHARS for c in username) or len(username) > 20:
			await clients[client_id]['ws'].send_json({'type': 'error', 'message': 'Invalid username. Use 1-20 printable characters.'})
			return

		# Check for duplicate username (case-insensitive)
		for cid, c in clients.items():
			if cid != client_id and c['username'] and c['username'].lower() == username.lower():
				await clients[client_id]['ws'].send_json({'type': 'error', 'message': 'Username already in use. Please choose a different name.'})
				return

		active_users = len([c for c in clients.values() if c['username']])
		if active_users >= config.MAX_USERS:
			await clients[client_id]['ws'].send_json({'type': 'error', 'message': 'Room is full'})
			return

		clients[client_id]['username'] = username

		if session_start is None:
			session_start = time.time()

		logging.info(f'[{client_id}] Joined as {username}')

		users = [
			{'id': cid, 'username': c['username'], 'cam_on': c.get('cam_on', False), 'mic_on': c.get('mic_on', True), 'screen_on': c.get('screen_on', False)}
			for cid, c in clients.items()
			if c['username'] and cid != client_id
		]

		await clients[client_id]['ws'].send_json({
			'type'          : 'users',
			'users'         : users,
			'you'           : client_id,
			'session_start' : session_start,
			'max_cameras'   : config.MAX_CAMERAS
		})

		await broadcast(client_id, {
			'type'     : 'user_joined',
			'id'       : client_id,
			'username' : username
		})

	elif msg_type in ('offer', 'answer', 'candidate'):
		target = data.get('target')
		if target and target in clients and clients[target]['username']:
			await clients[target]['ws'].send_json({
				'type'      : msg_type,
				'from'      : client_id,
				'username'  : clients[client_id]['username'],
				'sdp'       : data.get('sdp'),
				'candidate' : data.get('candidate')
			})

	elif msg_type == 'camera_status':
		enabled = data.get('enabled', False)

		if enabled and get_camera_count() >= config.MAX_CAMERAS:
			await clients[client_id]['ws'].send_json({
				'type'    : 'error',
				'message' : f'Maximum cameras ({config.MAX_CAMERAS}) reached'
			})
			return

		clients[client_id]['cam_on'] = enabled

		# Broadcast to ALL users including sender
		await broadcast_all({
			'type'    : 'camera_status',
			'id'      : client_id,
			'enabled' : enabled
		})

	elif msg_type == 'mic_status':
		enabled = data.get('enabled', True)
		clients[client_id]['mic_on'] = enabled

		# Broadcast to ALL users including sender
		await broadcast_all({
			'type'    : 'mic_status',
			'id'      : client_id,
			'enabled' : enabled
		})

	elif msg_type == 'screen_status':
		enabled = data.get('enabled', False)
		clients[client_id]['screen_on'] = enabled

		# Broadcast to ALL users including sender
		await broadcast_all({
			'type'    : 'screen_status',
			'id'      : client_id,
			'enabled' : enabled
		})

	elif msg_type == 'leave':
		# Explicit leave message for immediate cleanup (triggered on tab close)
		await cleanup(client_id)


async def broadcast(sender_id: str, message: dict):
	'''
	Send to all except sender
	
	:param sender_id: The ID of the sender
	:param message: The message to send
	'''

	# Send to all except sender
	for cid, client in list(clients.items()):
		if cid != sender_id and client['ws'] and not client['ws'].closed and client['username']:
			try:
				await client['ws'].send_json(message)
			except:
				pass


async def broadcast_all(message: dict):
	'''
	Send to all including sender
	
	:param message: The message to send
	'''

	# Send to all including sender
	for cid, client in list(clients.items()):
		if client['ws'] and not client['ws'].closed and client['username']:
			try:
				await client['ws'].send_json(message)
			except:
				pass


async def cleanup(client_id: str):
	'''
	Cleanup a client
	
	:param client_id: The ID of the client
	'''

	global session_start

	if client_id not in clients:
		return

	username = clients[client_id].get('username')
	del clients[client_id]

	active_users = len([c for c in clients.values() if c['username']])

	if active_users == 0:
		session_start = None

	logging.info(f'[{client_id}] Disconnected: {username} ({active_users} users)')

	if username:
		await broadcast_all({
			'type' : 'user_left',
			'id'   : client_id
		})


@web.middleware
async def no_cache_middleware(request: web.Request, handler):
	'''Add no-cache headers to all responses'''
	response = await handler(request)
	# Add no-cache headers to static files (JS, CSS)
	if request.path.startswith('/static/'):
		response.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
		response.headers['Pragma'] = 'no-cache'
		response.headers['Expires'] = '0'
	return response


async def init_app():
	'''Initialize the application'''

	# Create the application with no-cache middleware
	app = web.Application(middlewares=[no_cache_middleware])

	# Add routes
	app.router.add_get('/', index)
	app.router.add_get('/ws', websocket_handler)
	app.router.add_get('/api/captcha', get_captcha)
	app.router.add_get('/api/config', get_config)
	app.router.add_get('/api/users/count', get_user_count)
	app.router.add_post('/api/leave', leave_handler)
	app.router.add_static('/static/', 'static')

	return app


if __name__ == '__main__':
	import argparse

	# Parse command line arguments
	parser = argparse.ArgumentParser()
	parser.add_argument('-d', '--debug', action='store_true', help='Enable debug logging')
	args = parser.parse_args()

	# Setup logging
	if args.debug:
		apv.setup_logging(level='DEBUG', log_to_disk=True, max_log_size=5*1024*1024, max_backups=3, compress_backups=True, log_file_name='havoc', show_details=True)
		logging.debug('Debug logging enabled')
	else:
		apv.setup_logging(level='INFO', json_log=True, syslog=True)

	# Run the application
	web.run_app(init_app(), host=config.SERVER_HOST, port=config.SERVER_PORT)