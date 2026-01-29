#!/usr/bin/env python3
# HARDCHATS WebRTC Voice/Video Server - Developed by acidvegas (https://github.com/acidvegas/hardchats)
# hardchats/server.py

import random
import re
import time
import uuid
from aiohttp import web

import config

clients = {}  # client_id -> {ws, username, cam_on}
captchas = {}  # captcha_id -> {answer, expires}
session_start = None

USERNAME_REGEX = re.compile(r'^[\x20-\x7E]{1,20}$')


def generate_captcha():
    a = random.randint(1, 20)
    b = random.randint(1, 20)
    op = random.choice(['+', '-', '*'])
    
    if op == '+':
        answer = a + b
        question = f'{a} + {b}'
    elif op == '-':
        if a < b: a, b = b, a
        answer = a - b
        question = f'{a} - {b}'
    else:
        a, b = random.randint(1, 10), random.randint(1, 10)
        answer = a * b
        question = f'{a} × {b}'
    
    captcha_id = str(uuid.uuid4())[:8]
    captchas[captcha_id] = {'answer': answer, 'expires': time.time() + 300}
    return captcha_id, question


def verify_captcha(captcha_id, user_answer):
    if captcha_id not in captchas:
        return False
    
    captcha = captchas[captcha_id]
    if time.time() > captcha['expires']:
        del captchas[captcha_id]
        return False
    
    try:
        if int(user_answer) == captcha['answer']:
            del captchas[captcha_id]
            return True
    except:
        pass
    return False


def cleanup_captchas():
    now = time.time()
    expired = [k for k, v in captchas.items() if now > v['expires']]
    for k in expired:
        del captchas[k]


def get_camera_count():
    return sum(1 for c in clients.values() if c.get('cam_on', False))


async def index(request):
    with open('static/index.html', 'r') as f:
        return web.Response(text=f.read(), content_type='text/html')


async def get_captcha(request):
    cleanup_captchas()
    captcha_id, question = generate_captcha()
    return web.json_response({'id': captcha_id, 'question': question})


async def get_config(request):
    '''Serve client configuration'''
    return web.json_response(config.get_client_config())


async def websocket_handler(request):
    global session_start
    
    ws = web.WebSocketResponse()
    await ws.prepare(request)
    
    client_id = str(uuid.uuid4())[:8]
    clients[client_id] = {'ws': ws, 'username': None, 'cam_on': False}
    
    print(f'[{client_id}] Connected')
    
    try:
        async for msg in ws:
            if msg.type == web.WSMsgType.TEXT:
                data = __import__('json').loads(msg.data)
                await handle_message(client_id, data)
            elif msg.type == web.WSMsgType.ERROR:
                print(f'[{client_id}] Error: {ws.exception()}')
    except Exception as e:
        print(f'[{client_id}] Exception: {e}')
    finally:
        await cleanup(client_id)
    
    return ws


async def handle_message(client_id, data):
    global session_start
    msg_type = data.get('type')
    
    if msg_type == 'join':
        if not verify_captcha(data.get('captcha_id'), data.get('captcha_answer')):
            await clients[client_id]['ws'].send_json({'type': 'error', 'message': 'Invalid captcha'})
            return
        
        username = data.get('username', '').strip()
        if not USERNAME_REGEX.match(username):
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
        
        print(f'[{client_id}] Joined as {username}')
        
        users = [
            {'id': cid, 'username': c['username'], 'cam_on': c.get('cam_on', False)}
            for cid, c in clients.items()
            if c['username'] and cid != client_id
        ]
        
        await clients[client_id]['ws'].send_json({
            'type': 'users',
            'users': users,
            'you': client_id,
            'session_start': session_start,
            'max_cameras': config.MAX_CAMERAS
        })
        
        await broadcast(client_id, {
            'type': 'user_joined',
            'id': client_id,
            'username': username
        })
    
    elif msg_type in ('offer', 'answer', 'candidate'):
        target = data.get('target')
        if target and target in clients and clients[target]['username']:
            await clients[target]['ws'].send_json({
                'type': msg_type,
                'from': client_id,
                'username': clients[client_id]['username'],
                'sdp': data.get('sdp'),
                'candidate': data.get('candidate')
            })
    
    elif msg_type == 'camera_status':
        enabled = data.get('enabled', False)
        
        if enabled and get_camera_count() >= config.MAX_CAMERAS:
            await clients[client_id]['ws'].send_json({
                'type': 'error',
                'message': f'Maximum cameras ({config.MAX_CAMERAS}) reached'
            })
            return
        
        clients[client_id]['cam_on'] = enabled
        
        # Broadcast to ALL users including sender
        await broadcast_all({
            'type': 'camera_status',
            'id': client_id,
            'enabled': enabled
        })


async def broadcast(sender_id, message):
    '''Send to all except sender'''
    for cid, client in list(clients.items()):
        if cid != sender_id and client['ws'] and not client['ws'].closed and client['username']:
            try:
                await client['ws'].send_json(message)
            except:
                pass


async def broadcast_all(message):
    '''Send to all including sender'''
    for cid, client in list(clients.items()):
        if client['ws'] and not client['ws'].closed and client['username']:
            try:
                await client['ws'].send_json(message)
            except:
                pass


async def cleanup(client_id):
    global session_start
    
    if client_id not in clients:
        return
    
    username = clients[client_id].get('username')
    del clients[client_id]
    
    active_users = len([c for c in clients.values() if c['username']])
    
    if active_users == 0:
        session_start = None
    
    print(f'[{client_id}] Disconnected: {username} ({active_users} users)')
    
    if username:
        await broadcast_all({
            'type': 'user_left',
            'id': client_id
        })


async def init_app():
    app = web.Application()
    app.router.add_get('/', index)
    app.router.add_get('/ws', websocket_handler)
    app.router.add_get('/api/captcha', get_captcha)
    app.router.add_get('/api/config', get_config)
    app.router.add_static('/static/', 'static')
    return app


if __name__ == '__main__':
    print(f'Starting HardChats v{config.VERSION} on http://{config.SERVER_HOST}:{config.SERVER_PORT}')
    print(f'Max users: {config.MAX_USERS}, Max cameras: {config.MAX_CAMERAS}')
    web.run_app(init_app(), host=config.SERVER_HOST, port=config.SERVER_PORT)
