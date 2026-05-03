// HardChats - *73# / *74# recording + RECORD CALL prank
// Requires: state, $, send, getAudioCtx (from webrtc.js)

const RECORDING_MAX_MS = 10000; // 10-second cap

const recordingMixer = {
	dest: null,                  // MediaStreamAudioDestinationNode (the mix bus)
	connections: new Map()       // peerId -> AudioNode tap (for cleanup if ever needed)
};

let mediaRecorder = null;
let recordedChunks = [];
let recordedBlob = null;
let recordedMime = 'audio/webm';
let recordTimerInterval = null;
let recordTimeoutId = null;
let recordStartedAt = 0;

// Lazily build the destination node - we need an AudioContext, which only exists
// after the user has connected. Returns null if the AudioContext isn't ready yet.
function getRecordingMixerDest() {
	if (recordingMixer.dest) return recordingMixer.dest;
	const ctx = (typeof getAudioCtx === 'function') ? getAudioCtx() : null;
	if (!ctx) return null;
	recordingMixer.dest = ctx.createMediaStreamDestination();
	return recordingMixer.dest;
}

// Called by webrtc.js whenever a peer's audioSource node has just been created.
// Connects that source into the recording mix so MediaRecorder picks it up.
function tapPeerToRecordingMixer(peerId, audioSource) {
	if (!audioSource) return;
	const dest = getRecordingMixerDest();
	if (!dest) return;
	try {
		audioSource.connect(dest);
		recordingMixer.connections.set(peerId, audioSource);
	} catch (e) {
		console.warn('[Record] tap failed for', peerId, e);
	}
}

// teardownPeerAudio in webrtc.js calls audioSource.disconnect() which removes
// every connection at once, so we just need to drop our bookkeeping here.
function untapPeerFromRecordingMixer(peerId) {
	recordingMixer.connections.delete(peerId);
}

// ---------- Record popup (*73#) ----------

function initRecordingListeners() {
	$('record-close')?.addEventListener('click', closeRecordModal);
	$('record-start')?.addEventListener('click', startRecording);
	$('record-stop')?.addEventListener('click', stopRecording);
	$('record-modal')?.addEventListener('click', (e) => {
		if (e.target.id === 'record-modal') closeRecordModal();
	});

	$('record-call-btn')?.addEventListener('click', triggerFedFakeRecording);
}

function openRecordModal() {
	$('record-modal')?.classList.remove('hidden');
	resetRecordUI();
}

function closeRecordModal() {
	if (mediaRecorder && mediaRecorder.state === 'recording') {
		try { mediaRecorder.stop(); } catch (e) {}
	}
	$('record-modal')?.classList.add('hidden');
}

function resetRecordUI() {
	const status = $('record-status');
	const fill = $('record-progress-fill');
	const startBtn = $('record-start');
	const stopBtn = $('record-stop');
	if (status) status.textContent = recordedBlob ? 'Recording saved. Dial *74# to play.' : 'Ready';
	if (fill) fill.style.width = '0%';
	startBtn?.classList.remove('hidden');
	stopBtn?.classList.add('hidden');
}

function pickRecorderMime() {
	const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
	for (const m of candidates) {
		if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) {
			return m;
		}
	}
	return '';
}

function startRecording() {
	const dest = getRecordingMixerDest();
	if (!dest) {
		setRecordStatus('Audio not ready - join the call first.');
		return;
	}
	if (recordingMixer.connections.size === 0) {
		setRecordStatus('Nobody else is in the call to record.');
		return;
	}

	recordedChunks = [];
	const mime = pickRecorderMime();
	try {
		mediaRecorder = mime
			? new MediaRecorder(dest.stream, { mimeType: mime })
			: new MediaRecorder(dest.stream);
		recordedMime = mediaRecorder.mimeType || mime || 'audio/webm';
	} catch (e) {
		console.error('[Record] MediaRecorder failed:', e);
		setRecordStatus('Recording not supported in this browser.');
		return;
	}

	mediaRecorder.ondataavailable = (e) => {
		if (e.data && e.data.size > 0) recordedChunks.push(e.data);
	};
	mediaRecorder.onstop = () => {
		clearInterval(recordTimerInterval);
		clearTimeout(recordTimeoutId);
		recordTimerInterval = null;
		recordTimeoutId = null;
		recordedBlob = recordedChunks.length ? new Blob(recordedChunks, { type: recordedMime }) : null;

		const startBtn = $('record-start');
		const stopBtn = $('record-stop');
		startBtn?.classList.remove('hidden');
		stopBtn?.classList.add('hidden');
		setRecordStatus(recordedBlob ? 'Saved. Dial *74# to play.' : 'No audio captured.');
		const fill = $('record-progress-fill');
		if (fill) fill.style.width = '100%';
	};

	mediaRecorder.start();
	recordStartedAt = performance.now();

	$('record-start')?.classList.add('hidden');
	$('record-stop')?.classList.remove('hidden');
	setRecordStatus('Recording...');

	// Drive the progress bar.
	recordTimerInterval = setInterval(() => {
		const elapsed = performance.now() - recordStartedAt;
		const pct = Math.min(100, (elapsed / RECORDING_MAX_MS) * 100);
		const fill = $('record-progress-fill');
		if (fill) fill.style.width = pct + '%';
	}, 50);

	// Auto-stop at 10s.
	recordTimeoutId = setTimeout(() => {
		if (mediaRecorder && mediaRecorder.state === 'recording') {
			try { mediaRecorder.stop(); } catch (e) {}
		}
	}, RECORDING_MAX_MS);
}

function stopRecording() {
	if (mediaRecorder && mediaRecorder.state === 'recording') {
		try { mediaRecorder.stop(); } catch (e) {}
	}
}

function setRecordStatus(text) {
	const el = $('record-status');
	if (el) el.textContent = text;
}

// Server asked us to upload our last recording so it can fan out via *74#.
async function uploadRecording() {
	if (!recordedBlob) return; // nothing to send; *74# is a no-op silently
	try {
		const buf = await recordedBlob.arrayBuffer();
		const b64 = arrayBufferToBase64(buf);
		send({ type: 'broadcast_recording', audio: b64, mime: recordedMime });
	} catch (e) {
		console.error('[Record] upload failed:', e);
	}
}

function arrayBufferToBase64(buf) {
	const bytes = new Uint8Array(buf);
	let bin = '';
	for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
	return btoa(bin);
}

function base64ToBlob(b64, mime) {
	const bin = atob(b64);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return new Blob([bytes], { type: mime || 'audio/webm' });
}

// Server broadcast - everyone (including the original recorder) hears it.
function playBroadcastRecording(audioB64, mime) {
	if (!audioB64) return;
	if (!state.settings.sounds) return; // respect the existing sound-effects gate
	try {
		const blob = base64ToBlob(audioB64, mime);
		const url = URL.createObjectURL(blob);
		const a = new Audio(url);
		a.onended = () => URL.revokeObjectURL(url);
		a.play().catch(e => console.warn('[Record] playback rejected:', e?.message || e));
	} catch (e) {
		console.error('[Record] playback failed:', e);
	}
}

// ---------- RECORD CALL prank button ----------
// Dialer thinks they're recording. They send fed_self_tag once; from then on
// every other client sees a FED tag next to their nick. Locally we show a fake
// "REC" indicator so they're convinced it's real.

// Indicator is independently toggleable, but state.fedFakeActive (the FED-blindness
// flag in the user list) sticks for the rest of the session - once you've ever hit
// this button you can never see anyone's FED tag again, including others who got
// tricked the same way.
let fedFakeIndicatorTimer = null;

function triggerFedFakeRecording() {
	const btn = $('record-call-btn');
	const overlay = $('fed-fake-rec');
	const showing = overlay && !overlay.classList.contains('hidden');

	if (showing) {
		// Toggle the indicator OFF for the dialer. FED tag stays visible to everyone
		// else (server already broadcast fed_status on the first click).
		overlay.classList.add('hidden');
		clearInterval(fedFakeIndicatorTimer);
		fedFakeIndicatorTimer = null;
		btn?.classList.remove('active');
		return;
	}

	// First-ever click: actually fire the prank. Subsequent toggles only show/hide.
	if (!state.fedFakeActive) {
		state.fedFakeActive = true;
		send({ type: 'fed_self_tag' });
		// Re-render: this user is now FED-blind to everyone (themselves included).
		updateUsersList();
	}
	startFedFakeIndicator();
	btn?.classList.add('active');
}

function startFedFakeIndicator() {
	const el = $('fed-fake-rec');
	if (!el) return;
	el.classList.remove('hidden');
	const start = performance.now();
	const tick = () => {
		const elapsed = Math.floor((performance.now() - start) / 1000);
		const m = String(Math.floor(elapsed / 60)).padStart(2, '0');
		const s = String(elapsed % 60).padStart(2, '0');
		const t = $('fed-fake-time');
		if (t) t.textContent = `${m}:${s}`;
	};
	tick();
	fedFakeIndicatorTimer = setInterval(tick, 1000);
}
