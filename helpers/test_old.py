#!/usr/bin/env python3
# HARDCHATS WebRTC Voice/Video Server - Developed by acidvegas (https://github.com/acidvegas/hardchats)
# hardchats/helpers/test_old.py
#
# Smoke test of the old mesh build served at /old: two headless clients hear + see each
# other through the coturn relay, the IRC chat is gone, and the notice links to v2.
# Usage: python3 helpers/test_old.py [base_url]

import asyncio
import json
import re
import sys

import test_livekit as t


OLD = 'https://hardchats.com/old/'

# Per peer: relay route + inbound audio energy / decoded video frames from the mesh connection
MESH_JS = '''async () => {
	const out = {};
	for (const [id, peer] of Object.entries(state.peers)) {
		const row = {};
		(await peer.pc.getStats()).forEach(r => {
			if (r.type === 'inbound-rtp' && r.kind === 'audio') row.energy = r.totalAudioEnergy;
			if (r.type === 'inbound-rtp' && r.kind === 'video') row.frames = r.framesDecoded;
			if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') row.pair = r.localCandidateId;
		});
		const stats = await peer.pc.getStats();
		if (row.pair) row.local = stats.get(row.pair)?.candidateType;
		out[id] = row;
	}
	return out;
}'''


async def join(browser, name):
	ctx = await browser.new_context(user_agent=t.USER_AGENT, permissions=['microphone', 'camera'])
	page = await ctx.new_page()
	page.errors = []
	page.on('pageerror', lambda e: page.errors.append(str(e)))
	page.on('console', lambda m: page.errors.append(m.text) if m.type == 'error' else None)
	await page.goto(OLD)
	await page.fill('#username', name)
	await page.wait_for_function("document.getElementById('captcha-question').textContent.includes('=')")
	a, op, b = re.match(r'(\d+) (\S) (\d+)', await page.text_content('#captcha-question')).groups()
	await page.fill('#captcha-answer', str({'+': int(a) + int(b), '-': int(a) - int(b), '×': int(a) * int(b)}[op]))
	await page.click('#connect-btn')
	await page.wait_for_function('state.myId', timeout=20000)
	page.hc_name, page.hc_id = name, await page.evaluate('state.myId')
	return page


async def main():
	async with t.async_playwright() as pw:
		browser = await pw.chromium.launch(args=t.ARGS)
		alice, bob = await join(browser, 'oldalice_t'), await join(browser, 'oldbob_t')
		await alice.click('#cam-btn')
		for me, other in ((bob, alice), (alice, bob)):
			ok, s = False, {}
			for _ in range(20):
				s = (await me.evaluate(MESH_JS)).get(other.hc_id, {})
				if (s.get('energy') or 0) > 0.01 and (other is not alice or (s.get('frames') or 0) > 5):
					ok = True
					break
				await asyncio.sleep(1)
			t.check(f'/old: {me.hc_name} hears{" + sees" if other is alice else ""} {other.hc_name} over the mesh', ok, json.dumps(s))
			t.check(f'/old: {me.hc_name} -> {other.hc_name} goes through the TURN relay (IPs stay hidden)', s.get('local') == 'relay', s.get('local'))
		hidden = await alice.evaluate("[getComputedStyle(document.getElementById('irc-toggle')).display, getComputedStyle(document.getElementById('irc-sidebar')).display]")
		t.check('/old: IRC chat is removed', hidden == ['none', 'none'], json.dumps(hidden))
		link = await alice.evaluate("document.querySelector('.footer-notice a').href")
		t.check('/old: notice links to v2', link == OLD.replace('old/', ''), link)
		for p in (alice, bob):
			t.check(f'/old: {p.hc_name} has no JS errors', not p.errors, '; '.join(p.errors[:4]))
		await browser.close()

	failed = [name for name, ok in t.results if not ok]
	print(f'\n{len(t.results) - len(failed)}/{len(t.results)} passed')
	sys.exit(1 if failed else 0)



if __name__ == '__main__':
	if len(sys.argv) > 1:
		OLD = sys.argv[1]
	asyncio.run(main())
