#!/usr/bin/env python3
# HARDCHATS WebRTC Voice/Video Server - Developed by acidvegas (https://github.com/acidvegas/hardchats)
# hardchats/helpers/test_pbx_bridge.py
#
# End-to-end test of the PBX bridge (phreak.ing hcbridge) against hardchats v2: fake
# Asterisk AudioSocket legs dial the bridge, headless browsers sit in the room, and both
# sides check they hear each other through the end-to-end encrypted LiveKit room.
# Usage: python3 helpers/test_pbx_bridge.py [bridge_host] [prefix]   (bridge must already be running)

import asyncio
import json
import struct
import sys
import time
import uuid

import numpy

import test_livekit as t


BRIDGE = '127.0.0.1'
PREFIX = 'PHREAKTEST'


class Caller:
	'''Fake Asterisk AudioSocket leg: sends a tone, records what the bridge plays back'''

	def __init__(self, ext: int, freq: int):
		self.ext, self.freq, self.received, self.writer, self.task = ext, freq, bytearray(), None, None

	async def dial(self):
		reader, self.writer = await asyncio.open_connection(BRIDGE, 9093)
		self.writer.write(struct.pack('>BH', 0x01, 16) + uuid.UUID(f'12345678-1234-4123-8123-{self.ext:012d}').bytes)
		self.task = asyncio.gather(self.send(), self.recv(reader))

	async def send(self):
		t0, n, ts = time.monotonic(), 0, numpy.arange(320) / 16000
		while True:
			frame = (numpy.sin(2 * numpy.pi * self.freq * (ts + n * 0.02)) * 8000).astype(numpy.int16).tobytes()
			self.writer.write(struct.pack('>BH', 0x12, 640) + frame)
			n += 1
			await asyncio.sleep(max(0, t0 + n * 0.02 - time.monotonic()))

	async def recv(self, reader):
		while True:
			kind, length = struct.unpack('>BH', await reader.readexactly(3))
			data = await reader.readexactly(length) if length else b''
			if kind == 0x12:
				self.received.extend(data)

	def heard(self, seconds: float = 2) -> tuple:
		'''(rms, peak/mean) of the last `seconds` of audio the bridge played to this caller'''
		pcm = numpy.frombuffer(bytes(self.received[-int(16000 * 2 * seconds):]), dtype=numpy.int16).astype(float)
		if not len(pcm):
			return 0, 0
		spec = numpy.abs(numpy.fft.rfft(pcm))
		return float(numpy.sqrt((pcm ** 2).mean())), float(spec.max() / (spec.mean() + 1e-9))

	async def hangup(self):
		self.writer.write(struct.pack('>BH', 0x00, 0))
		await self.writer.drain()
		self.task.cancel()


async def caller_id(page, name: str, timeout: int = 20):
	for _ in range(timeout):
		pid = await page.evaluate(f"Object.entries(state.users).find(([id, u]) => u.username === '{name}')?.[0] || null")
		if pid:
			return pid
		await asyncio.sleep(1)


async def main():
	async with t.async_playwright() as pw:
		browser = await pw.chromium.launch(args=t.ARGS)
		web = await t.new_client(browser, 'pbxweb_t')
		c1, c2 = Caller(901, 600), Caller(902, 900)
		await c1.dial()
		await c2.dial()
		n1, n2 = f'{PREFIX}-901', f'{PREFIX}-902'
		p1, p2 = await caller_id(web, n1), await caller_id(web, n2)
		t.check('both callers join the room under their PHREAK names', bool(p1 and p2), f'{p1} {p2}')

		for pid, name in ((p1, n1), (p2, n2)):
			s, ok = await t.wait_stats(web, f"(s['{pid}']||[]).some(t => t.source === 'microphone' && t.subscribed && t.encrypted && t.energy > 0.005)")
			ratio = await web.evaluate(t.SPECTRUM_JS, [None, pid]) if ok else 0
			t.check(f'browser hears {name} (encrypted, clean tone)', ok and ratio > 20, f'peak/mean {ratio:.0f} {json.dumps(t.find(s, pid, "microphone"))}')

		await asyncio.sleep(3)
		for c in (c1, c2):
			rms, ratio = c.heard()
			t.check(f'caller {c.ext} hears the browser (and the other caller)', rms > 200, f'rms {rms:.0f} peak/mean {ratio:.0f}')

		tracks = [(p['identity'], t2.get('encryption')) for p in await t.list_participants() for t2 in p.get('tracks', []) if p['identity'] in (p1, p2)]
		t.check('SFU reports the callers\' tracks as GCM-encrypted', len(tracks) == 2 and all(e == 'GCM' for _, e in tracks), json.dumps(tracks))

		# Key rotation: a second browser joins and leaves; the callers and browser keep hearing each other
		extra = await t.new_client(browser, 'pbxextra_t')
		await t.wait_stats(extra, f"(s['{p1}']||[]).some(t => t.source === 'microphone' && t.energy > 0.005)")
		await extra.context.close()
		await asyncio.sleep(5)
		d = await t.energy_delta(web, p1, 3)
		rms, _ = c1.heard()
		t.check('after a key rotation the browser still hears caller 901 and the caller still hears the room', d > 0.005 and rms > 200, f'energy delta {d:.4f}, caller rms {rms:.0f}')

		# Breakout: the browser goes into the breakout room, the callers stop hearing it
		await web.evaluate("send({ type: 'dial', sequence: '*87#' })")
		await asyncio.sleep(4)
		rms_breakout, ratio_breakout = c1.heard(1.5)
		await web.evaluate("send({ type: 'dial', sequence: '*87#' })")
		await asyncio.sleep(4)
		rms_back, _ = c1.heard(1.5)
		t.check('breakout: caller 901 no longer gets the browser (only caller 902), and does again after', ratio_breakout > 20 and rms_back > 200, f'in breakout rms {rms_breakout:.0f} peak/mean {ratio_breakout:.0f}, back rms {rms_back:.0f}')

		await c1.hangup()
		await asyncio.sleep(3)
		names = await web.evaluate("Object.values(state.users).map(u => u.username)")
		t.check('hanging up removes caller 901 from the room', n1 not in names and n2 in names, json.dumps(names))
		await c2.hangup()
		t.check('browser has no JS errors', not web.errors, '; '.join(web.errors[:4]))
		await browser.close()

	failed = [name for name, ok in t.results if not ok]
	print(f'\n{len(t.results) - len(failed)}/{len(t.results)} passed')
	sys.exit(1 if failed else 0)



if __name__ == '__main__':
	if len(sys.argv) > 1:
		BRIDGE = sys.argv[1]
	if len(sys.argv) > 2:
		PREFIX = sys.argv[2]
	asyncio.run(main())
