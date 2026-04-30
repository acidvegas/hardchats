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

// Apply or remove the trippy-mode class on <body>. Server tells us when to flip via
// 'trippy_status' broadcasts; new joiners get the current value in the 'users' message.
function setTrippyMode(enabled) {
	state.trippyMode = !!enabled;
	document.body.classList.toggle('trippy-mode', state.trippyMode);
}
