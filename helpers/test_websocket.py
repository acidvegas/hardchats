#!/usr/bin/env python3
# HARDCHATS WebRTC Voice/Video Server - Developed by acidvegas (https://github.com/acidvegas/hardchats)
# hardchats/test_websocket.py

import asyncio
import ssl

try:
	import websockets
except ImportError:
	raise SystemExit('missing websockets library (pip install websockets)')


IRC_SERVER = 'wss://irc.supernets.org:7000'
NICK       = 'WSTest123'
USER       = 'hardchatter'
REALNAME   = 'https://dev.hardchats.com/'
CHANNEL    = '#hardchats'


async def test_irc():
	# Create SSL context (allows self-signed certs for testing)
	ssl_context = ssl.create_default_context()
	ssl_context.check_hostname = False
	ssl_context.verify_mode = ssl.CERT_NONE
	
	print(f'[*] Connecting to {IRC_SERVER}...')
	
	try:
		async with websockets.connect(
			IRC_SERVER,
			subprotocols=['text.ircv3.net', 'binary.ircv3.net'],
			ssl=ssl_context,
			close_timeout=5
		) as ws:
			print(f'[+] Connected! Protocol: {ws.subprotocol}')
			
			# Send registration
			await ws.send(f'NICK {NICK}')
			print(f'[>] NICK {NICK}')
			
			await ws.send(f'USER {USER} 0 * :{REALNAME}')
			print(f'[>] USER {USER} 0 * :{REALNAME}')
			
			# Listen for messages
			joined = False
			async for message in ws:
				print(f'[<] {message}')
				
				# Handle PING
				if message.startswith('PING'):
					pong = message.replace('PING', 'PONG', 1)
					await ws.send(pong)
					print(f'[>] {pong}')
				
				# Join channel after welcome (001)
				if ' 001 ' in message and not joined:
					await ws.send(f'JOIN {CHANNEL}')
					print(f'[>] JOIN {CHANNEL}')
					joined = True
				
				# Send test message after joining
				if f'JOIN {CHANNEL}' in message or f'JOIN :{CHANNEL}' in message:
					test_msg = f'PRIVMSG {CHANNEL} :WebSocket test successful!'
					await ws.send(test_msg)
					print(f'[>] {test_msg}')
					
					# Quit after sending
					await asyncio.sleep(2)
					await ws.send('QUIT :Test complete')
					print('[>] QUIT :Test complete')
					break
					
	except websockets.exceptions.InvalidStatusCode as e:
		print(f'[-] Invalid status code: {e.status_code}')
		print(f'[-] Server may not support WebSocket on this port')
	except websockets.exceptions.InvalidHandshake as e:
		print(f'[-] Invalid handshake: {e}')
		print(f'[-] Server responded but not with valid WebSocket upgrade')
	except ConnectionRefusedError:
		print(f'[-] Connection refused - port not open or not reachable')
	except ssl.SSLError as e:
		print(f'[-] SSL error: {e}')
	except Exception as e:
		print(f'[-] Error: {type(e).__name__}: {e}')

if __name__ == '__main__':
	print('IRC WebSocket Test')
	print('=' * 40)
	asyncio.run(test_irc())

