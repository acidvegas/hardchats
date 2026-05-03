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
			const w = t.offsetWidth || 240;
			const h = t.offsetHeight || 180;
			const angle = Math.random() * Math.PI * 2;
			const speed = 60 + Math.random() * 40; // px/sec — slow glide
			pong.state.set(t.id, {
				x: Math.random() * Math.max(1, cw - w),
				y: Math.random() * Math.max(1, ch - h),
				vx: Math.cos(angle) * speed,
				vy: Math.sin(angle) * speed,
				w, h
			});
		} else {
			const s = pong.state.get(t.id);
			s.w = t.offsetWidth || s.w;
			s.h = t.offsetHeight || s.h;
		}
	});

	for (const id of pong.state.keys()) {
		if (!seen.has(id)) pong.state.delete(id);
	}
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

		if (s.x <= 0)         { s.x = 0;       s.vx = Math.abs(s.vx); }
		if (s.x + s.w >= cw)  { s.x = cw-s.w;  s.vx = -Math.abs(s.vx); }
		if (s.y <= 0)         { s.y = 0;       s.vy = Math.abs(s.vy); }
		if (s.y + s.h >= ch)  { s.y = ch-s.h;  s.vy = -Math.abs(s.vy); }

		items.push({ id, s });
	});

	// Tile-vs-tile collisions (cheap O(n^2), fine for ~10 tiles).
	for (let i = 0; i < items.length; i++) {
		for (let j = i + 1; j < items.length; j++) {
			const a = items[i].s, b = items[j].s;
			if (a.x < b.x + b.w && a.x + a.w > b.x &&
			    a.y < b.y + b.h && a.y + a.h > b.y) {
				const overlapX = Math.min(a.x + a.w - b.x, b.x + b.w - a.x);
				const overlapY = Math.min(a.y + a.h - b.y, b.y + b.h - a.y);
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
			}
		}
	}

	items.forEach(({ id, s }) => {
		const el = document.getElementById(id);
		if (el) el.style.transform = `translate(${s.x}px, ${s.y}px)`;
	});

	pong.raf = requestAnimationFrame(pongTick);
}
