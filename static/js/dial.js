// HardChats - Dial keypad
// Requires: state, $, send from state.js

let dialSequence = '';
const DIAL_MAX_LEN = 32; // matches server-side cap

function initDialListeners() {
	const dialBtn = $('dial-btn');
	if (dialBtn) {
		dialBtn.addEventListener('click', openDial);
		dialBtn.addEventListener('touchend', (e) => { e.preventDefault(); openDial(); });
	}

	$('dial-close')?.addEventListener('click', closeDial);
	$('dial-clear')?.addEventListener('click', clearDial);
	$('dial-submit')?.addEventListener('click', submitDial);

	$('dial-codes-close')?.addEventListener('click', closeDialCodes);
	$('dial-codes-modal')?.addEventListener('click', (e) => {
		if (e.target.id === 'dial-codes-modal') closeDialCodes();
	});

	document.querySelectorAll('.dial-key').forEach(btn => {
		btn.addEventListener('click', () => pressDialKey(btn.dataset.key));
	});

	// Click outside the modal content to close.
	$('dial-modal')?.addEventListener('click', (e) => {
		if (e.target.id === 'dial-modal') closeDial();
	});
}

function openDial() {
	$('dial-modal').classList.remove('hidden');
	dialSequence = '';
	updateDialDisplay();
}

function closeDial() {
	$('dial-modal').classList.add('hidden');
	dialSequence = '';
	updateDialDisplay();
}

function pressDialKey(key) {
	if (!key) return;
	if (dialSequence.length >= DIAL_MAX_LEN) return;
	dialSequence += key;
	updateDialDisplay();
}

function clearDial() {
	dialSequence = '';
	updateDialDisplay();
}

function updateDialDisplay() {
	const display = $('dial-display');
	if (display) display.textContent = dialSequence || ' ';
}

function submitDial() {
	if (!dialSequence) return;
	send({ type: 'dial', sequence: dialSequence });
	// We never tell the user whether the code was valid - server stays opaque.
	closeDial();
}

// Server reply to *#06# - private to the dialer. Renders the codes into the modal.
function showDialCodes(codes) {
	const list = $('dial-codes-list');
	if (!list) return;
	list.innerHTML = '';
	codes.forEach(({ code, desc }) => {
		const li = document.createElement('li');
		const codeEl = document.createElement('code');
		codeEl.textContent = code;
		const descEl = document.createElement('span');
		descEl.textContent = desc;
		li.appendChild(codeEl);
		li.appendChild(descEl);
		list.appendChild(li);
	});
	$('dial-codes-modal')?.classList.remove('hidden');
}

function closeDialCodes() {
	$('dial-codes-modal')?.classList.add('hidden');
}

// Apply or remove the trippy-mode class on <body>. Server tells us when to flip via
// 'trippy_status' broadcasts; new joiners get the current value in the 'users' message.
function setTrippyMode(enabled) {
	state.trippyMode = !!enabled;
	document.body.classList.toggle('trippy-mode', state.trippyMode);
}

function setSchizoMode(enabled) {
	state.schizoMode = !!enabled;
	document.body.classList.toggle('schizo-mode', state.schizoMode);
}

function setPongMode(enabled) {
	state.pongMode = !!enabled;
	document.body.classList.toggle('pong-mode', state.pongMode);
	if (state.pongMode) startPong();
	else stopPong();
}

// ---------- Pong mode: webcam tiles bounce around ----------
// Tracks each .video-tile's position+velocity and runs an rAF loop.
// Tiles get position:absolute via CSS; we update transform each frame.

const pong = {
	raf: null,
	state: new Map(), // tileId -> { x, y, vx, vy, w, h }
	container: null
};

function startPong() {
	pong.container = document.getElementById('video-grid');
	if (!pong.container) return;
	pongRefreshTiles();
	if (!pong.raf) pong.raf = requestAnimationFrame(pongTick);
}

function stopPong() {
	if (pong.raf) cancelAnimationFrame(pong.raf);
	pong.raf = null;
	document.querySelectorAll('#video-grid .video-tile').forEach(t => {
		t.style.transform = '';
		t.style.left = '';
		t.style.top = '';
	});
	pong.state.clear();
	pong.container = null;
}

// Sizes are tracked as a `scale` factor over a baseW/baseH. Hitting an edge
// grows the tile; hitting another tile shrinks the smaller one (or both if equal).
const PONG_GROW       = 1.08;
const PONG_SHRINK     = 0.88;
const PONG_MIN_SCALE  = 0.35;
const PONG_MAX_SCALE  = 2.2;
const PONG_EQUAL_EPS  = 0.001;

// Re-sync the tile map with what's actually in the DOM. Called whenever
// updateVideoGrid rebuilds tiles while pong mode is active.
function pongRefreshTiles() {
	if (!pong.container) return;
	const tiles = pong.container.querySelectorAll('.video-tile');
	const seen = new Set();
	const cw = pong.container.clientWidth;
	const ch = pong.container.clientHeight;

	tiles.forEach(t => {
		seen.add(t.id);
		if (!pong.state.has(t.id)) {
			const baseW = t.offsetWidth || 240;
			const baseH = t.offsetHeight || 180;
			const angle = Math.random() * Math.PI * 2;
			const speed = 60 + Math.random() * 40; // px/sec — slow glide
			pong.state.set(t.id, {
				x: Math.random() * Math.max(1, cw - baseW),
				y: Math.random() * Math.max(1, ch - baseH),
				vx: Math.cos(angle) * speed,
				vy: Math.sin(angle) * speed,
				baseW, baseH,
				scale: 1
			});
		} else {
			const s = pong.state.get(t.id);
			s.baseW = t.offsetWidth || s.baseW;
			s.baseH = t.offsetHeight || s.baseH;
		}
	});

	for (const id of pong.state.keys()) {
		if (!seen.has(id)) pong.state.delete(id);
	}
}

function pongClampScale(s) {
	if (s.scale < PONG_MIN_SCALE) s.scale = PONG_MIN_SCALE;
	if (s.scale > PONG_MAX_SCALE) s.scale = PONG_MAX_SCALE;
}

let pongLastT = 0;
function pongTick(now) {
	if (!state.pongMode || !pong.container) {
		pong.raf = null;
		return;
	}

	const dt = pongLastT ? Math.min(0.05, (now - pongLastT) / 1000) : 0.016;
	pongLastT = now;

	const cw = pong.container.clientWidth;
	const ch = pong.container.clientHeight;

	const items = [];
	pong.state.forEach((s, id) => {
		s.x += s.vx * dt;
		s.y += s.vy * dt;

		const w = s.baseW * s.scale;
		const h = s.baseH * s.scale;

		// Edge bounce: each hit grows the tile a little (clamped).
		let hitEdge = false;
		if (s.x <= 0)        { s.x = 0;      s.vx = Math.abs(s.vx);  hitEdge = true; }
		if (s.x + w >= cw)   { s.x = cw-w;   s.vx = -Math.abs(s.vx); hitEdge = true; }
		if (s.y <= 0)        { s.y = 0;      s.vy = Math.abs(s.vy);  hitEdge = true; }
		if (s.y + h >= ch)   { s.y = ch-h;   s.vy = -Math.abs(s.vy); hitEdge = true; }

		if (hitEdge) {
			s.scale *= PONG_GROW;
			pongClampScale(s);
			// After growing we may now stick out past the edge - reclamp position.
			const w2 = s.baseW * s.scale, h2 = s.baseH * s.scale;
			if (s.x + w2 > cw) s.x = Math.max(0, cw - w2);
			if (s.y + h2 > ch) s.y = Math.max(0, ch - h2);
		}

		items.push({ id, s });
	});

	// Tile-vs-tile collisions: smaller shrinks, equal -> both shrink.
	for (let i = 0; i < items.length; i++) {
		for (let j = i + 1; j < items.length; j++) {
			const a = items[i].s, b = items[j].s;
			const aw = a.baseW * a.scale, ah = a.baseH * a.scale;
			const bw = b.baseW * b.scale, bh = b.baseH * b.scale;

			if (a.x < b.x + bw && a.x + aw > b.x &&
			    a.y < b.y + bh && a.y + ah > b.y) {
				const overlapX = Math.min(a.x + aw - b.x, b.x + bw - a.x);
				const overlapY = Math.min(a.y + ah - b.y, b.y + bh - a.y);
				if (overlapX < overlapY) {
					const push = overlapX / 2;
					if (a.x < b.x) { a.x -= push; b.x += push; }
					else           { a.x += push; b.x -= push; }
					const tmp = a.vx; a.vx = b.vx; b.vx = tmp;
				} else {
					const push = overlapY / 2;
					if (a.y < b.y) { a.y -= push; b.y += push; }
					else           { a.y += push; b.y -= push; }
					const tmp = a.vy; a.vy = b.vy; b.vy = tmp;
				}

				// Size changes: smaller one shrinks; if equal, both shrink.
				if (Math.abs(a.scale - b.scale) < PONG_EQUAL_EPS) {
					a.scale *= PONG_SHRINK;
					b.scale *= PONG_SHRINK;
				} else if (a.scale < b.scale) {
					a.scale *= PONG_SHRINK;
				} else {
					b.scale *= PONG_SHRINK;
				}
				pongClampScale(a);
				pongClampScale(b);
			}
		}
	}

	items.forEach(({ id, s }) => {
		const el = document.getElementById(id);
		if (el) el.style.transform = `translate(${s.x}px, ${s.y}px) scale(${s.scale})`;
	});

	pong.raf = requestAnimationFrame(pongTick);
}
