#!/usr/bin/env python3
# HARDCHATS WebRTC Voice/Video Server - Developed by acidvegas (https://github.com/acidvegas/hardchats)
# hardchats/helpers/test_livekit.py
#
# End-to-end test of the LiveKit build with headless Chromium clients (fake mic + camera).
# Needs ssh access to the host running the hardchats-beta container (token minting + SFU API).
# Usage: python3 helpers/test_livekit.py [base_url] [test ...]

import asyncio
import json
import re
import sys

try:
	from playwright.async_api import async_playwright
except ImportError:
	raise SystemExit('missing playwright library (pip install playwright && playwright install chromium)')


BASE       = 'https://hardchats.com/'
SSH_HOST   = 'super-svc'
CONTAINER  = 'hardchats-beta'
SFU_IPS    = ('69.30.206.130', '2604:4300:a:282:')
USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36'
ARGS       = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--auto-select-desktop-capture-source=Entire screen']

results = []


# Per remote participant: every publication with its subscription/encryption state + receiver stats
STATS_JS = '''async (roomVar) => {
	const room = roomVar ? window[roomVar] : state.room;
	const out = {};
	for (const [id, p] of room?.remoteParticipants || []) {
		out[id] = [];
		for (const pub of p.trackPublications.values()) {
			const row = { source: pub.source, subscribed: pub.isSubscribed, encrypted: pub.isEncrypted };
			const receiver = pub.track?.receiver;
			if (receiver) {
				(await receiver.getStats()).forEach(r => {
					if (r.type !== 'inbound-rtp') return;
					Object.assign(row, { packets: r.packetsReceived, framesDecoded: r.framesDecoded, width: r.frameWidth, energy: r.totalAudioEnergy, samples: r.totalSamplesReceived });
				});
				const pair = receiver.transport?.iceTransport?.getSelectedCandidatePair?.();
				if (pair) row.route = `${pair.local.type}/${pair.local.protocol} -> ${pair.remote.address}:${pair.remote.port}/${pair.remote.protocol}`;
			}
			out[id].push(row);
		}
	}
	return out;
}'''

# Spectral peak-to-mean ratio of a remote mic over ~1.5s. The fake mic is a tone (sharp
# peak, high ratio); frames decoded from undecryptable ciphertext come out as noise.
SPECTRUM_JS = '''async ([roomVar, identity]) => {
	const room = roomVar ? window[roomVar] : state.room;
	const pub = [...room.remoteParticipants.get(identity).trackPublications.values()].find(p => p.source === 'microphone');
	const ctx = new AudioContext();
	const src = ctx.createMediaStreamSource(new MediaStream([pub.track.mediaStreamTrack]));
	const an = ctx.createAnalyser();
	an.fftSize = 2048;
	src.connect(an);
	const bins = new Float32Array(an.frequencyBinCount);
	let best = 0;
	for (let i = 0; i < 15; i++) {
		await new Promise(res => setTimeout(res, 100));
		an.getFloatFrequencyData(bins);
		const lin = Array.from(bins, db => Math.pow(10, db / 20));
		const mean = lin.reduce((a, b) => a + b, 0) / lin.length;
		if (mean > 0) best = Math.max(best, Math.max(...lin) / mean);
	}
	ctx.close();
	return best;
}'''

# Make a page's LiveKit client use TURN relays only (forces the TURN/TLS 5349 path)
RELAY_INIT = '''window.addEventListener('DOMContentLoaded', () => {
	const Room = LivekitClient.Room;
	LivekitClient.Room = class extends Room {
		constructor(opts) {
			super(opts);
			const connect = this.connect;
			this.connect = (url, token, connectOpts) => connect(url, token, { ...connectOpts, rtcConfig: { iceTransportPolicy: 'relay' } });
		}
	};
});'''


# Record the ICE servers every peer connection ends up with (after livekit.js rewrites them)
ICE_HOOK = '''const sld = RTCPeerConnection.prototype.setLocalDescription;
RTCPeerConnection.prototype.setLocalDescription = function (...args) {
	window.iceUrls = [...new Set([...(window.iceUrls || []), ...this.getConfiguration().iceServers.flatMap(s => [].concat(s.urls))])];
	return sld.apply(this, args);
};'''


def check(name: str, ok: bool, detail=''):
	results.append((name, ok))
	print(f'[{"PASS" if ok else "FAIL"}] {name}{f" - {detail}" if detail else ""}', flush=True)


def find(stats: dict, identity: str, source: str) -> dict:
	return next((t for t in stats.get(identity, []) if t['source'] == source), {})


async def remote_python(code: str) -> str:
	'''Run python inside the beta container (has the LiveKit secret) and return the last line of output'''
	proc = await asyncio.create_subprocess_exec('ssh', SSH_HOST, f'docker exec -i {CONTAINER} python3 -', stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
	out, err = await proc.communicate(code.encode())
	lines = out.decode().strip().splitlines()
	if not lines:
		raise RuntimeError(err.decode()[-500:])
	return lines[-1]


async def mint_token(identity: str) -> str:
	'''A valid room-join token, i.e. what anyone controlling the SFU path could obtain'''
	return await remote_python(f'import server\nprint(server.livekit_token({identity!r}, {identity!r}))\n')


async def list_participants() -> list:
	code = '\n'.join([
		'import json, urllib.request, server',
		"token = server.livekit_jwt({'video': {'room': 'hardchats', 'roomAdmin': True}}, 60)",
		"req = urllib.request.Request('http://172.17.0.1:7880/twirp/livekit.RoomService/ListParticipants', data=json.dumps({'room': 'hardchats'}).encode(), headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})",
		'print(urllib.request.urlopen(req, timeout=10).read().decode())'
	])
	return json.loads(await remote_python(code)).get('participants', [])


async def remove_participant(identity: str):
	'''Kick a media session from the SFU, the way LiveKit drops a client whose connection died'''
	code = '\n'.join([
		'import json, urllib.request, server',
		"token = server.livekit_jwt({'video': {'room': 'hardchats', 'roomAdmin': True}}, 60)",
		f"req = urllib.request.Request('http://172.17.0.1:7880/twirp/livekit.RoomService/RemoveParticipant', data=json.dumps({{'room': 'hardchats', 'identity': {identity!r}}}).encode(), headers={{'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'}})",
		'print(urllib.request.urlopen(req, timeout=10).read().decode())'
	])
	return await remote_python(code)


async def new_client(browser, name: str, extra_init: str = None, ctx=None):
	if ctx:
		pass # caller-built context (e.g. a mobile device profile)
	elif browser.browser_type.name == 'firefox':
		ctx = await browser.new_context() # Firefox keeps its own UA (a Chrome UA would make sites treat it as Chrome)
	else:
		ctx = await browser.new_context(user_agent=USER_AGENT, permissions=['microphone', 'camera'])
	page = await ctx.new_page()
	page.errors = []
	page.on('pageerror', lambda e: page.errors.append(str(e)))
	page.on('console', lambda m: page.errors.append(m.text) if m.type == 'error' else None)
	await page.add_init_script(ICE_HOOK)
	if extra_init:
		await page.add_init_script(extra_init)
	await page.goto(BASE)
	await page.fill('#username', name)
	await page.wait_for_function("document.getElementById('captcha-question').textContent.includes('=')")
	a, op, b = re.match(r'(\d+) (\S) (\d+)', await page.text_content('#captcha-question')).groups()
	await page.fill('#captcha-answer', str({'+': int(a) + int(b), '-': int(a) - int(b), '×': int(a) * int(b)}[op]))
	await page.evaluate("document.getElementById('connect-btn').click()")
	await page.wait_for_function("state.room && state.room.state === 'connected' && state.micPub", timeout=20000)
	page.hc_name = name
	page.hc_id = await page.evaluate('state.myId')
	return page


async def stats(page, room_var: str = None) -> dict:
	return await page.evaluate(STATS_JS, room_var)


async def wait_stats(page, predicate_js: str, timeout: int = 20, room_var: str = None):
	'''Poll the stats until predicate_js (with the stats as `s`) holds; returns (stats, ok)'''
	for _ in range(timeout):
		s = await stats(page, room_var)
		if await page.evaluate(f'(s) => {predicate_js}', s):
			return s, True
		await asyncio.sleep(1)
	return s, False


async def energy_delta(listener, identity: str, seconds: float) -> float:
	e1 = find(await stats(listener), identity, 'microphone').get('energy') or 0
	await asyncio.sleep(seconds)
	e2 = find(await stats(listener), identity, 'microphone').get('energy') or 0
	return e2 - e1


async def main():
	tests = set(sys.argv[2:])
	want = lambda t: not tests or t in tests

	async with async_playwright() as pw:
		browser = await pw.chromium.launch(args=ARGS)

		alice = await new_client(browser, 'alice_t')
		bob = await new_client(browser, 'bob_t')
		A, B = alice.hc_id, bob.hc_id
		check('both clients joined the LiveKit room', True, f'alice={A} bob={B}')

		for me, other in ((alice, bob), (bob, alice)):
			s, ok = await wait_stats(me, f"(s['{other.hc_id}']||[]).some(t => t.source === 'microphone' && t.subscribed && t.encrypted && t.energy > 0.01)")
			check(f'{me.hc_name} hears {other.hc_name} (encrypted mic, decoded audio)', ok, json.dumps(find(s, other.hc_id, 'microphone')))

		urls = await alice.evaluate('window.iceUrls')
		check('ICE servers are only our own (no third-party STUN)', bool(urls) and all('hardchats.com' in u for u in urls), json.dumps(urls))

		routes = {t.get('route') for t in (await stats(bob)).get(A, []) if t.get('route')}
		check('media routes only to the SFU, never to the other browser', bool(routes) and all(any(ip in r for ip in SFU_IPS) for r in routes), ', '.join(routes))

		if want('video'):
			await alice.click('#cam-btn')
			s, ok = await wait_stats(bob, f"(s['{A}']||[]).some(t => t.source === 'camera' && t.subscribed && t.encrypted && t.framesDecoded > 10 && t.width > 0)")
			check('bob receives + decodes alice camera (encrypted)', ok, json.dumps(find(s, A, 'camera')))
			await asyncio.sleep(1)
			tile = await bob.evaluate(f"(() => {{ const v = document.querySelector('#tile-{A} video'); return v ? [v.videoWidth, v.videoHeight, v.paused] : null; }})()")
			check('alice camera tile renders on bob', bool(tile) and tile[0] > 0 and not tile[2], json.dumps(tile))

		if want('screen'):
			await alice.click('#screen-btn')
			s, ok = await wait_stats(bob, f"(s['{A}']||[]).some(t => t.source === 'screen_share' && t.subscribed && t.encrypted && t.framesDecoded > 3)")
			check('bob receives + decodes alice screen share (encrypted)', ok, json.dumps(find(s, A, 'screen_share')))
			await alice.click('#screen-btn')
			_, ok = await wait_stats(bob, f"!(s['{A}']||[]).some(t => t.source === 'screen_share')")
			check('screen share ends for bob when alice stops it', ok)

		if want('eve'):
			# Eavesdropper: valid LiveKit token but no E2EE keys. The SFU hands it the
			# encrypted frames; it must not be able to decode them.
			token = await mint_token('eve00000')
			ctx = await browser.new_context(user_agent=USER_AGENT)
			eve = await ctx.new_page()
			await eve.goto(BASE + 'api/config')
			await eve.add_script_tag(url=BASE + 'static/js/vendor/livekit-client.umd.js')
			lk_url = await alice.evaluate('livekitUrl')
			await eve.evaluate("async ([u, t]) => { window.evil = new LivekitClient.Room(); await window.evil.connect(u, t, { autoSubscribe: true }); }", [lk_url, token])
			s, _ = await wait_stats(eve, f"(s['{A}']||[]).some(t => t.source === 'camera' && t.packets > 100) && (s['{A}']||[]).some(t => t.source === 'microphone' && t.packets > 100)", room_var='evil')
			cam = find(s, A, 'camera')
			check('eavesdropper gets alice camera packets but decodes 0 frames', cam.get('packets', 0) > 100 and not cam.get('framesDecoded'), json.dumps(cam))
			eve_ratio = await eve.evaluate(SPECTRUM_JS, ['evil', A])
			bob_ratio = await bob.evaluate(SPECTRUM_JS, [None, A])
			check('alice mic is a clean tone for bob and noise for the eavesdropper', bob_ratio > 20 and eve_ratio < bob_ratio / 4, f'peak/mean bob={bob_ratio:.1f} eve={eve_ratio:.1f} eve-mic={json.dumps(find(s, A, "microphone"))}')
			await eve.evaluate('window.evil.disconnect()')
			await ctx.close()

		if want('server'):
			tracks = [(p['identity'], t.get('source'), t.get('encryption')) for p in await list_participants() for t in p.get('tracks', [])]
			check('SFU reports every published track as GCM-encrypted', bool(tracks) and all(e == 'GCM' for _, _, e in tracks), json.dumps(tracks))

		if want('mute'):
			await alice.click('#mic-btn')
			await asyncio.sleep(2)
			d = await energy_delta(bob, A, 3)
			check('muted alice sends silence', d < 0.001, f'energy delta over 3s: {d:.5f}')
			await alice.click('#mic-btn')
			await asyncio.sleep(2)
			d = await energy_delta(bob, A, 3)
			check('unmuted alice is heard again', d > 0.01, f'energy delta over 3s: {d:.5f}')

		if want('rotate'):
			carol = await new_client(browser, 'carol_t')
			_, ok = await wait_stats(carol, f"(s['{A}']||[]).some(t => t.source === 'microphone' && t.energy > 0.01)")
			check('carol joins and hears alice', ok)
			before = [await p.evaluate('e2ee.keyIndex') for p in (alice, bob)]
			await carol.context.close()
			await asyncio.sleep(5)
			after = [await p.evaluate('e2ee.keyIndex') for p in (alice, bob)]
			check('alice + bob rotate their sender keys after carol leaves', all(k2 == k1 + 1 for k1, k2 in zip(before, after)), f'{before} -> {after}')
			d = await energy_delta(bob, A, 3)
			ratio = await bob.evaluate(SPECTRUM_JS, [None, A])
			check('bob still decodes alice after the rotation', d > 0.01 and ratio > 20, f'energy delta {d:.4f}, peak/mean {ratio:.1f}')
			check('carol was removed from the SFU room', carol.hc_id not in [p['identity'] for p in await list_participants()])

		if want('carmode'):
			await bob.evaluate("handleToggleClick('toggle-carmode', 'carMode'); applyCarMode();")
			s, ok = await wait_stats(bob, f"(s['{A}']||[]).some(t => t.source === 'camera' && !t.subscribed) && (s['{A}']||[]).some(t => t.source === 'microphone' && t.subscribed)")
			check('car mode: bob drops alice video, keeps audio', ok, json.dumps(s.get(A)))
			# The re-publish replaces bob's mic track, so give it time and measure on the new one
			await asyncio.sleep(4)
			d = await energy_delta(alice, B, 3)
			check('car mode: bob is still heard after his mic re-publish', d > 0.01, f'energy delta {d:.4f}, mic={json.dumps(find(await stats(alice), B, "microphone"))}')
			cap = await bob.evaluate('state.micPub.track.sender.getParameters().encodings.map(e => e.maxBitrate)')
			check('car mode: bob mic is capped at 24 kbps', cap == [24000], json.dumps(cap))
			await bob.evaluate("handleToggleClick('toggle-carmode', 'carMode'); applyCarMode();")
			_, ok = await wait_stats(bob, f"(s['{A}']||[]).some(t => t.source === 'camera' && t.subscribed && t.framesDecoded > 0)")
			check('car mode off: alice video comes back', ok)

		if want('breakout'):
			await alice.evaluate("send({ type: 'dial', sequence: '*87#' })")
			s, ok = await wait_stats(bob, f"!(s['{A}']||[]).some(t => t.subscribed)")
			check('breakout: bob stops receiving anything from alice', ok, json.dumps(s.get(A)))
			s, ok = await wait_stats(alice, f"!(s['{B}']||[]).some(t => t.subscribed)")
			check('breakout: alice stops receiving anything from bob', ok, json.dumps(s.get(B)))
			await alice.evaluate("send({ type: 'dial', sequence: '*87#' })")
			_, ok = await wait_stats(bob, f"(s['{A}']||[]).some(t => t.source === 'microphone' && t.subscribed && t.energy > 0)")
			check('breakout off: bob hears alice again', ok)

		if want('relay'):
			dave = await new_client(browser, 'dave_t', RELAY_INIT)
			s, ok = await wait_stats(dave, f"(s['{A}']||[]).some(t => t.source === 'microphone' && t.energy > 0.01 && (t.route||'').startsWith('relay'))")
			check('TURN/TLS-only client connects and hears alice', ok, json.dumps(find(s, A, 'microphone')))
			await dave.context.close()

		if want('voicefx'):
			await alice.evaluate('setVoiceChangerActive(true)')
			ok = await alice.evaluate('state.micPub.track.mediaStreamTrack === getOutgoingAudioTrack() && state.micPub.track.mediaStreamTrack !== state.localStream.getAudioTracks()[0]')
			await asyncio.sleep(2)
			d = await energy_delta(bob, A, 3)
			check('voice changer: published mic swaps to the processed track and bob still hears it', ok and d > 0.01, f'swapped={ok} energy delta {d:.4f}')
			await alice.evaluate('setVoiceChangerActive(false)')
			ok = await alice.evaluate('state.micPub.track.mediaStreamTrack === state.localStream.getAudioTracks()[0]')
			check('voice changer off: published mic is the raw mic again', ok)

		if want('lowbw'):
			if not await alice.evaluate('state.camEnabled'):
				await alice.click('#cam-btn')
			await wait_stats(bob, f"(s['{A}']||[]).some(t => t.source === 'camera' && t.framesDecoded > 0)")
			await alice.evaluate("handleToggleClick('toggle-lowbandwidth', 'lowBandwidth'); applyLowBandwidth();")
			await asyncio.sleep(3)
			layers = await alice.evaluate('state.camPub.track.sender.getParameters().encodings.map(e => e.maxBitrate)')
			s, ok = await wait_stats(bob, f"(s['{A}']||[]).some(t => t.source === 'camera' && t.subscribed && t.framesDecoded > 5)")
			check('low bandwidth: camera re-published as one layer capped at 300 kbps, bob still decodes it', ok and layers == [300000], f'encodings={layers} cam={json.dumps(find(s, A, "camera"))}')
			await alice.evaluate("handleToggleClick('toggle-lowbandwidth', 'lowBandwidth'); applyLowBandwidth();")

		if want('flip'):
			if not await alice.evaluate('state.camEnabled'):
				await alice.click('#cam-btn')
			await alice.wait_for_function('state.camPub && state.camPub.track')
			before = await alice.evaluate('state.camPub.track.mediaStreamTrack.id')
			await alice.evaluate('flipCamera()')
			await asyncio.sleep(2)
			after = await alice.evaluate('[state.camPub.track.mediaStreamTrack.id, state.camPub.trackSid]')
			f1 = find(await stats(bob), A, 'camera').get('framesDecoded') or 0
			await asyncio.sleep(3)
			f2 = find(await stats(bob), A, 'camera').get('framesDecoded') or 0
			check('camera flip swaps the track in place and bob keeps decoding', after[0] != before and f2 > f1, f'track {before[:8]} -> {after[0][:8]}, frames {f1} -> {f2}')

		if want('reconnect'):
			# Drop alice's app WebSocket: she rejoins with a new client id (= new LiveKit identity)
			await alice.evaluate('state.ws.close()')
			await alice.wait_for_function(f"state.myId && state.myId !== '{A}' && state.room && state.room.state === 'connected' && state.micPub", timeout=30000)
			A2 = await alice.evaluate('state.myId')
			s, ok = await wait_stats(bob, f"(s['{A2}']||[]).some(t => t.source === 'microphone' && t.subscribed && t.encrypted && t.energy > 0.01)")
			check('after a WebSocket drop alice rejoins and bob hears her new session', ok, f'{A} -> {A2}')
			check('alice\'s old session is gone from the SFU', A not in [p['identity'] for p in await list_participants()])
			_, ok = await wait_stats(alice, f"(s['{B}']||[]).some(t => t.source === 'microphone' && t.subscribed && t.energy > 0.01)")
			check('rejoined alice hears bob', ok)
			if await alice.evaluate('state.camEnabled'):
				s, ok = await wait_stats(bob, f"(s['{A2}']||[]).some(t => t.source === 'camera' && t.subscribed && t.framesDecoded > 5)")
				check('alice camera is re-published after the rejoin', ok, json.dumps(find(s, A2, 'camera')))

		if want('recording'):
			# *73# records what you hear (peer audio taps), *74# broadcasts it over the app WebSocket
			await alice.evaluate('startRecording()')
			await asyncio.sleep(3)
			await alice.evaluate('stopRecording()')
			await alice.wait_for_function('recordedBlob !== null', timeout=5000)
			size = await alice.evaluate('recordedBlob.size')
			await bob.evaluate('() => { window.gotRecording = 0; playBroadcastRecording = (audio) => { window.gotRecording = audio.length; }; }')
			await alice.evaluate("send({ type: 'dial', sequence: '*74#' })")
			await bob.wait_for_function('window.gotRecording > 0', timeout=10000)
			check('recording: alice records 3s of the call and bob receives the broadcast', size > 1000, f'blob {size} bytes, bob got {await bob.evaluate("window.gotRecording")} base64 chars')

		if want('soundboard'):
			await bob.evaluate('() => { window.gotSound = null; playSound = (name) => { window.gotSound = name; }; }')
			await alice.evaluate("send({ type: 'play_soundboard', sound: 'knock' })")
			await bob.wait_for_function("window.gotSound === 'knock'", timeout=10000)
			check('soundboard: bob gets the sound alice picked', True)

		if want('drop'):
			# LiveKit drops alice's media session while her app WebSocket stays up: she must rejoin on her own
			await remove_participant(A)
			await alice.wait_for_function("state.room && state.room.state === 'connected' && state.micPub", timeout=20000)
			s, ok = await wait_stats(bob, f"(s['{A}']||[]).some(t => t.source === 'microphone' && t.subscribed && t.energy > 0.01)")
			check('after LiveKit drops alice she rejoins the media room and bob hears her', ok, json.dumps(find(s, A, 'microphone')))
			_, ok = await wait_stats(alice, f"(s['{B}']||[]).some(t => t.source === 'microphone' && t.subscribed && t.energy > 0.01)")
			check('rejoined alice hears bob again', ok)

		if want('stale'):
			# Alice's socket dies without the server noticing (common on mobile) and she reconnects
			# while her old session is still registered: the reconnect must replace it.
			await alice.evaluate('() => { const old = state.ws; old.onclose = null; old.onmessage = null; disconnectLivekit(); connectWebSocket(state.username); }')
			await alice.wait_for_function(f"state.myId && state.myId !== '{A}' && state.room && state.room.state === 'connected' && state.micPub", timeout=20000)
			A3 = await alice.evaluate('state.myId')
			s, ok = await wait_stats(bob, f"(s['{A3}']||[]).some(t => t.source === 'microphone' && t.subscribed && t.energy > 0.01)")
			names = await bob.evaluate("[...document.querySelectorAll('#users-list .user-name')].map(e => e.textContent)")
			check('reconnect over a stale session: bob hears alice and lists her once', ok and sorted(names) == ['alice_t', 'bob_t'], f'{A} -> {A3}, bob list {names}')
			names = await alice.evaluate("[...document.querySelectorAll('#users-list .user-name')].map(e => e.textContent)")
			check('reconnected alice lists bob', sorted(names) == ['alice_t', 'bob_t'], json.dumps(names))
			A = A3

		if want('bfcache'):
			await bob.goto(BASE + 'api/config')
			await bob.go_back()
			await bob.wait_for_load_state()
			await asyncio.sleep(2)
			on_login = await bob.evaluate("!document.getElementById('login-screen').classList.contains('hidden')")
			names = await alice.evaluate("[...document.querySelectorAll('#users-list .user-name')].map(e => e.textContent)")
			check('navigating away and back: bob is on the login screen and gone from alice\'s list', on_login and names == ['alice_t'], f'login={on_login} alice list {names}')

		if want('continuity'):
			# Turning a camera on must not disturb the audio already flowing (no resubscribe)
			before = find(await stats(bob), A, 'microphone').get('packets') or 0
			await bob.click('#cam-btn')
			await wait_stats(alice, f"(s['{B}']||[]).some(t => t.source === 'camera' && t.framesDecoded > 5)")
			after = find(await stats(bob), A, 'microphone').get('packets') or 0
			check('bob turning his camera on keeps the same mic receiver for alice (packet count keeps growing)', after > before, f'{before} -> {after}')
			await bob.click('#cam-btn')

		if want('settings'):
			# Device switch through the settings dialog (re-acquire the mic, publish a camera)
			await alice.evaluate("openSettings({ stopPropagation() {} })")
			await alice.wait_for_function("document.getElementById('mic-select').options.length > 0 && document.getElementById('cam-select').options.length > 0")
			if await alice.evaluate('state.camEnabled'):
				await alice.click('#cam-btn')
			await alice.evaluate("() => { selectedMicId = 'force-switch'; const c = document.getElementById('cam-select'); c.value = [...c.options].find(o => o.value)?.value || ''; }")
			old_mic = await alice.evaluate('state.localStream.getAudioTracks()[0].id')
			await alice.evaluate('applySettings()')
			await alice.wait_for_function('state.camPub && state.camPub.track', timeout=10000)
			same = await alice.evaluate(f"state.localStream.getAudioTracks()[0].id !== '{old_mic}' && state.micPub.track.mediaStreamTrack === state.localStream.getAudioTracks()[0]")
			await asyncio.sleep(2)
			d = await energy_delta(bob, A, 3)
			check('settings: switching mic swaps the published track and bob still hears alice', same and d > 0.01, f'swapped={same} energy delta {d:.4f}')
			s, ok = await wait_stats(bob, f"(s['{A}']||[]).some(t => t.source === 'camera' && t.subscribed && t.framesDecoded > 5)")
			check('settings: picking a camera publishes it and bob decodes it', ok, json.dumps(find(s, A, 'camera')))
			await alice.evaluate('closeSettings()')

		if want('noise'):
			await alice.evaluate("handleToggleClick('toggle-noisesuppression', 'noiseSuppression'); applyNoiseSuppression();")
			await asyncio.sleep(2)
			d = await energy_delta(bob, A, 3)
			check('noise suppression toggle keeps alice audible', d > 0.01, f'energy delta {d:.4f}')
			await alice.evaluate("handleToggleClick('toggle-noisesuppression', 'noiseSuppression'); applyNoiseSuppression();")

		if want('speaker'):
			await bob.evaluate("handleToggleClick('toggle-speakermode', 'speakerMode'); rebuildAudioSinksForSpeakerMode();")
			el = await bob.evaluate(f"(() => {{ const e = state.peers['{A}'].audioElement; return e ? [e.tagName, e.paused, !!e.srcObject, e.srcObject?.getAudioTracks()[0]?.readyState] : null; }})()")
			check('speaker mode toggle rebuilds alice\'s sink as a live <audio> element', el == ['AUDIO', False, True, 'live'], json.dumps(el))
			await bob.evaluate("handleToggleClick('toggle-speakermode', 'speakerMode'); rebuildAudioSinksForSpeakerMode();")

		if want('volume'):
			await bob.evaluate(f"() => {{ state.peers['{A}'].volume = 0; applyPeerVolume('{A}'); }}")
			muted = await bob.evaluate(f"state.peers['{A}'].audioElement.muted")
			await bob.evaluate(f"() => {{ state.peers['{A}'].volume = 40; applyPeerVolume('{A}'); }}")
			el = await bob.evaluate(f"[state.peers['{A}'].audioElement.muted, state.peers['{A}'].audioElement.volume]")
			check('per-user volume: 0 mutes alice, 40 plays her at 0.4', muted and el == [False, 0.4], f'at 0 muted={muted}, at 40 {el}')
			await bob.evaluate(f"() => {{ state.peers['{A}'].volume = 100; applyPeerVolume('{A}'); }}")
			await bob.click('#volume-btn')
			gm = await bob.evaluate(f"state.peers['{A}'].audioElement.muted")
			await bob.click('#volume-btn')
			check('global mute button mutes alice\'s sink and unmute restores it', gm and not await bob.evaluate(f"state.peers['{A}'].audioElement.muted"))

		if want('defcon'):
			await bob.click('#defcon-btn')
			erin = await new_client(browser, 'erin_t')
			E = erin.hc_id
			await erin.click('#cam-btn')
			await asyncio.sleep(4)
			s = await stats(bob)
			cam, mic = find(s, E, 'camera'), find(s, E, 'microphone')
			el = await bob.evaluate(f"state.peers['{E}']?.audioElement?.muted")
			check('DEFCON: a newcomer\'s camera is not received and their audio is muted', cam.get('subscribed') is False and el is True, f'cam={json.dumps(cam)} mic-sub={mic.get("subscribed")} muted={el}')
			await bob.evaluate(f"togglePeerVideo('{E}')")
			_, ok = await wait_stats(bob, f"(s['{E}']||[]).some(t => t.source === 'camera' && t.subscribed && t.framesDecoded > 3)")
			check('DEFCON: showing their video again subscribes it', ok)
			await bob.click('#defcon-btn')
			await erin.context.close()

		if want('dialfx'):
			for code in ('*420#', '*666#', '*9059#', '*1337#', '*401#', '*000#', '*#06#'):
				await alice.evaluate(f"send({{ type: 'dial', sequence: '{code}' }})")
				await asyncio.sleep(0.5)
			await asyncio.sleep(1)
			d = await energy_delta(bob, A, 2)
			check('dial-code effects (trippy/schizo/pong/rainbow/ghost/reset/list) run without breaking audio', d > 0.01, f'energy delta {d:.4f}')

		if want('hangup'):
			gone = alice.hc_id
			await alice.evaluate("document.getElementById('hangup-btn').click()") # the *#06# list modal covers it
			await asyncio.sleep(3)
			names = await bob.evaluate("[...document.querySelectorAll('#users-list .user-name')].map(e => e.textContent)")
			check('hangup: alice leaves bob\'s list and the SFU', 'alice_t' not in names and gone not in [p['identity'] for p in await list_participants()], json.dumps(names))

		if want('ui'):
			await bob.click('#debug-btn')
			await asyncio.sleep(1)
			info = await bob.text_content('#debug-connection-info') + await bob.text_content('#debug-peers-info')
			check('debug panel shows LiveKit + E2EE state per peer', 'E2EE: enabled' in info and 'E2EE key exchanged: yes' in info and '[encrypted]' in info and 'NOT ENCRYPTED' not in info, info.replace(chr(10), ' | ')[:400])
			await bob.click('#debug-close')
			users = await bob.evaluate("[...document.querySelectorAll('#users-list .user-name')].map(e => e.textContent)")
			check('users list shows both users', sorted(users) == ['alice_t', 'bob_t'], json.dumps(users))
			if await alice.evaluate('state.camEnabled'):
				pip = await bob.evaluate("[!document.getElementById('pip-btn').classList.contains('hidden'), !!document.getElementById('pip-video')?.srcObject]")
				check('picture-in-picture is offered and fed with alice\'s camera', pip == [True, True], json.dumps(pip))
			count = await bob.evaluate("fetch('api/users/count').then(r => r.json())")
			check('user count API counts the room', count.get('count', 0) >= 2, json.dumps(count))

		for p in (alice, bob):
			check(f'{p.hc_name} has no JS errors', not p.errors, '; '.join(p.errors[:5]))

		await browser.close()

		if want('firefox'):
			# Cross-browser E2EE: Firefox (RTCRtpScriptTransform) <-> Chromium (insertable streams)
			ff = await pw.firefox.launch(firefox_user_prefs={'media.navigator.streams.fake': True, 'media.navigator.permission.disabled': True})
			browser = await pw.chromium.launch(args=ARGS)
			chrome = await new_client(browser, 'chrome_t')
			fox = await new_client(ff, 'fox_t')
			s, ok = await wait_stats(fox, f"(s['{chrome.hc_id}']||[]).some(t => t.source === 'microphone' && t.subscribed && t.encrypted && t.energy > 0.01)")
			check('firefox hears chrome (encrypted)', ok, json.dumps(find(s, chrome.hc_id, 'microphone')))
			s, ok = await wait_stats(chrome, f"(s['{fox.hc_id}']||[]).some(t => t.source === 'microphone' && t.subscribed && t.encrypted && t.energy > 0.01)")
			check('chrome hears firefox (encrypted)', ok, json.dumps(find(s, fox.hc_id, 'microphone')))
			await fox.click('#cam-btn')
			s, ok = await wait_stats(chrome, f"(s['{fox.hc_id}']||[]).some(t => t.source === 'camera' && t.subscribed && t.encrypted && t.framesDecoded > 5)")
			check('chrome decodes firefox camera (encrypted)', ok, json.dumps(find(s, fox.hc_id, 'camera')))
			await chrome.click('#cam-btn')
			s, ok = await wait_stats(fox, f"(s['{chrome.hc_id}']||[]).some(t => t.source === 'camera' && t.subscribed && t.encrypted && t.framesDecoded > 5)")
			check('firefox decodes chrome camera (encrypted)', ok, json.dumps(find(s, chrome.hc_id, 'camera')))
			for p in (chrome, fox):
				check(f'{p.hc_name} has no JS errors', not p.errors, '; '.join(p.errors[:5]))
			await ff.close()
			await browser.close()

		if want('mobile'):
			# Chrome on Android (device profile + mobile UA) <-> Firefox, then each side silently
			# loses its socket (screen off / network switch) and rejoins
			ff = await pw.firefox.launch(firefox_user_prefs={'media.navigator.streams.fake': True, 'media.navigator.permission.disabled': True})
			browser = await pw.chromium.launch(args=ARGS)
			mctx = await browser.new_context(**{**pw.devices['Pixel 7'], 'user_agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36'}, permissions=['microphone', 'camera'])
			phone = await new_client(browser, 'phone_t', ctx=mctx)
			fox = await new_client(ff, 'fox_t')
			await phone.evaluate('toggleCam()') # the users sidebar covers the controls on a phone after joining
			await fox.click('#cam-btn')
			both = lambda pid: f"(s['{pid}']||[]).some(t => t.source === 'camera' && t.framesDecoded > 5) && (s['{pid}']||[]).some(t => t.source === 'microphone' && t.energy > 0.01)"
			_, ok = await wait_stats(phone, both(fox.hc_id))
			check('mobile chrome hears + sees firefox', ok)
			_, ok = await wait_stats(fox, both(phone.hc_id))
			check('firefox hears + sees mobile chrome', ok)
			vis = await phone.evaluate("getComputedStyle(document.getElementById('flip-cam-btn')).display")
			check('mobile: flip camera button shown while the camera is on', vis != 'none', vis)
			for me, other in ((phone, fox), (fox, phone)):
				old = await me.evaluate('state.myId')
				await me.evaluate('() => { const old = state.ws; old.onclose = null; old.onmessage = null; disconnectLivekit(); connectWebSocket(state.username); }')
				await me.wait_for_function(f"state.myId !== '{old}' && state.room && state.room.state === 'connected' && state.micPub", timeout=20000)
				_, ok = await wait_stats(other, both(await me.evaluate('state.myId')))
				names = await other.evaluate("[...document.querySelectorAll('#users-list .user-name')].map(e => e.textContent)")
				check(f'{me.hc_name} silently drops + rejoins: {other.hc_name} hears/sees it again and lists it once', ok and sorted(names) == ['fox_t', 'phone_t'], json.dumps(names))
			for p in (phone, fox):
				check(f'{p.hc_name} has no JS errors', not p.errors, '; '.join(p.errors[:5]))
			await ff.close()
			await browser.close()

		if want('tcp'):
			# No UDP at all: ICE has to fall back to TCP 7881 (or TURN/TLS)
			browser = await pw.chromium.launch(args=ARGS + ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp'])
			p1 = await new_client(browser, 'tcp1_t')
			p2 = await new_client(browser, 'tcp2_t')
			s, ok = await wait_stats(p2, f"(s['{p1.hc_id}']||[]).some(t => t.source === 'microphone' && t.energy > 0.01 && !(t.route||'').includes('/udp'))")
			check('UDP-blocked clients still connect (TCP/TLS fallback)', ok, json.dumps(find(s, p1.hc_id, 'microphone')))
			await browser.close()

	failed = [name for name, ok in results if not ok]
	print(f'\n{len(results) - len(failed)}/{len(results)} passed')
	for name in failed:
		print(f'  FAILED: {name}')
	sys.exit(1 if failed else 0)



if __name__ == '__main__':
	if len(sys.argv) > 1:
		BASE = sys.argv[1]
	asyncio.run(main())
