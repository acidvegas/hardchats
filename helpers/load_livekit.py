#!/usr/bin/env python3
# HARDCHATS WebRTC Voice/Video Server - Developed by acidvegas (https://github.com/acidvegas/hardchats)
# hardchats/helpers/load_livekit.py
#
# Load check: N headless clients with mic + camera on, then reports what every client
# receives/decodes and the SFU container's CPU and memory.
# Usage: python3 helpers/load_livekit.py [clients] [seconds]

import asyncio
import json
import sys

import test_livekit as t


async def sfu_usage() -> str:
	proc = await asyncio.create_subprocess_exec('ssh', t.SSH_HOST, f'docker stats --no-stream --format "{{{{.CPUPerc}}}} cpu, {{{{.MemUsage}}}}" {t.CONTAINER}-livekit', stdout=asyncio.subprocess.PIPE)
	out, _ = await proc.communicate()
	return out.decode().strip()


async def main(count: int, seconds: int):
	async with t.async_playwright() as pw:
		browser = await pw.chromium.launch(args=t.ARGS)
		clients = []
		for i in range(count):
			page = await t.new_client(browser, f'load{i}_t')
			await page.click('#cam-btn')
			clients.append(page)
		print(f'{count} clients joined with mic + camera, settling {seconds}s', flush=True)
		await asyncio.sleep(seconds)
		print('SFU:', await sfu_usage())

		ok = 0
		for page in clients:
			s = await t.stats(page)
			peers = [p.hc_id for p in clients if p is not page]
			audio = sum(1 for pid in peers if (t.find(s, pid, 'microphone').get('energy') or 0) > 0.01)
			video = sum(1 for pid in peers if (t.find(s, pid, 'camera').get('framesDecoded') or 0) > 30)
			enc = all(row['encrypted'] for pid in peers for row in s.get(pid, []))
			ok += audio == video == len(peers) and enc
			print(f'{page.hc_name}: hears {audio}/{len(peers)}, decodes video {video}/{len(peers)}, all encrypted: {enc}, errors: {len(page.errors)}')
		print(f'\n{ok}/{count} clients receive every other client')
		await browser.close()



if __name__ == '__main__':
	asyncio.run(main(int(sys.argv[1]) if len(sys.argv) > 1 else 8, int(sys.argv[2]) if len(sys.argv) > 2 else 20))
