// HardChats - Outgoing audio FX (voice changer)
// Requires: state, $ from state.js; getAudioCtx from webrtc.js; applyBreakoutGatingAll from client.js
//
// The FX graph sits between the raw mic and every peer's audio sender:
//   raw mic track -> MediaStreamAudioSourceNode -> [fx chain] -> MediaStreamAudioDestination
//   -> processedTrack   (what every sender transmits while the changer is ON)
//
// getOutgoingAudioTrack() is the single source of truth every sender assignment uses
// (breakout gating calls it). When the changer is OFF it returns the raw mic track, so
// nothing about normal operation changes for users who never open the popup.
//
// NOTE: the pitch shifter (createPitchShifter) uses the well-known "Jungle" delay-line
// technique. It must be ear-verified in a real browser via /static/audiofx-test.html
// (there is no headless WebAudio in the build environment).

// ---------- Pure DSP building blocks (no app state; reused by the test harness) ----------

// Waveshaper distortion curve. amount 0 -> caller should bypass (curve=null).
function makeDistortionCurve(amount) {
	const k = amount * 100;
	const n = 8192;
	const curve = new Float32Array(n);
	for (let i = 0; i < n; i++) {
		const x = (i * 2) / n - 1;
		curve[i] = ((3 + k) * x * 20 * (Math.PI / 180)) / (Math.PI + k * Math.abs(x));
	}
	return curve;
}

// Synthetic reverb impulse response (decaying white noise). No asset file needed.
function makeImpulseResponse(ctx, seconds, decay) {
	const rate = ctx.sampleRate;
	const len = Math.max(1, Math.floor(rate * seconds));
	const impulse = ctx.createBuffer(2, len, rate);
	for (let ch = 0; ch < 2; ch++) {
		const data = impulse.getChannelData(ch);
		for (let i = 0; i < len; i++) {
			data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
		}
	}
	return impulse;
}

// Ring modulator (robot voice). depth 0 = clean passthrough, 1 = full ring mod.
function createRingMod(ctx) {
	const input = ctx.createGain();
	const output = ctx.createGain();
	const dry = ctx.createGain();
	const ring = ctx.createGain();
	const osc = ctx.createOscillator();
	const depthGain = ctx.createGain();

	dry.gain.value = 1;   // 1 - depth
	ring.gain.value = 0;  // base 0; carrier drives it
	depthGain.gain.value = 0;
	osc.frequency.value = 50;

	osc.connect(depthGain);
	depthGain.connect(ring.gain);
	input.connect(dry); dry.connect(output);
	input.connect(ring); ring.connect(output);
	osc.start();

	return {
		input, output, osc,
		setDepth(d) { dry.gain.value = 1 - d; depthGain.gain.value = d; },
		setFreq(f) { osc.frequency.value = f; }
	};
}

// Jungle pitch shifter (Chris Wilson, WebAudio). Real-time granular pitch shift via two
// crossfaded, ramp-modulated delay lines. setPitchOffset(mult): >0 up, <0 down, 0 flat.
function createPitchShifter(ctx) {
	const delayTime = 0.100;
	const fadeTime = 0.050;
	const bufferTime = 0.100;

	function createFadeBuffer(activeTime, fadeT) {
		const length1 = activeTime * ctx.sampleRate;
		const length2 = (activeTime - 2 * fadeT) * ctx.sampleRate;
		const length = length1 + length2;
		const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
		const p = buffer.getChannelData(0);
		const fadeLength = fadeT * ctx.sampleRate;
		const fadeIndex1 = fadeLength;
		const fadeIndex2 = length1 - fadeLength;
		let i;
		for (i = 0; i < length1; ++i) {
			let value;
			if (i < fadeIndex1) value = Math.sqrt(i / fadeLength);
			else if (i >= fadeIndex2) value = Math.sqrt(1 - (i - fadeIndex2) / fadeLength);
			else value = 1;
			p[i] = value;
		}
		for (; i < length; ++i) p[i] = 0;
		return buffer;
	}

	function createDelayTimeBuffer(activeTime, fadeT, shiftUp) {
		const length1 = activeTime * ctx.sampleRate;
		const length2 = (activeTime - 2 * fadeT) * ctx.sampleRate;
		const length = length1 + length2;
		const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
		const p = buffer.getChannelData(0);
		let i;
		for (i = 0; i < length1; ++i) {
			if (shiftUp) p[i] = (length1 - i) / length;
			else p[i] = i / length1;
		}
		for (; i < length; ++i) p[i] = 0;
		return buffer;
	}

	const input = ctx.createGain();
	const output = ctx.createGain();

	const mod1 = ctx.createBufferSource();
	const mod2 = ctx.createBufferSource();
	const mod3 = ctx.createBufferSource();
	const mod4 = ctx.createBufferSource();
	const shiftDownBuffer = createDelayTimeBuffer(bufferTime, fadeTime, false);
	const shiftUpBuffer = createDelayTimeBuffer(bufferTime, fadeTime, true);
	mod1.buffer = shiftDownBuffer;
	mod2.buffer = shiftDownBuffer;
	mod3.buffer = shiftUpBuffer;
	mod4.buffer = shiftUpBuffer;
	mod1.loop = mod2.loop = mod3.loop = mod4.loop = true;

	const mod1Gain = ctx.createGain();
	const mod2Gain = ctx.createGain();
	const mod3Gain = ctx.createGain();
	const mod4Gain = ctx.createGain();
	mod3Gain.gain.value = 0;
	mod4Gain.gain.value = 0;

	const modGain1 = ctx.createGain();
	const modGain2 = ctx.createGain();
	const delay1 = ctx.createDelay();
	const delay2 = ctx.createDelay();
	mod1.connect(mod1Gain);
	mod2.connect(mod2Gain);
	mod3.connect(mod3Gain);
	mod4.connect(mod4Gain);
	mod1Gain.connect(modGain1);
	mod2Gain.connect(modGain2);
	mod3Gain.connect(modGain1);
	mod4Gain.connect(modGain2);
	modGain1.connect(delay1.delayTime);
	modGain2.connect(delay2.delayTime);

	const fade1 = ctx.createBufferSource();
	const fade2 = ctx.createBufferSource();
	const fadeBuffer = createFadeBuffer(bufferTime, fadeTime);
	fade1.buffer = fadeBuffer;
	fade2.buffer = fadeBuffer;
	fade1.loop = fade2.loop = true;

	const mix1 = ctx.createGain();
	const mix2 = ctx.createGain();
	mix1.gain.value = 0;
	mix2.gain.value = 0;
	fade1.connect(mix1.gain);
	fade2.connect(mix2.gain);

	input.connect(delay1);
	input.connect(delay2);
	delay1.connect(mix1);
	delay2.connect(mix2);
	mix1.connect(output);
	mix2.connect(output);

	const t = ctx.currentTime + 0.050;
	const interval = bufferTime - fadeTime;
	mod1.start(t);
	mod2.start(t + interval);
	fade1.start(t);
	fade2.start(t + interval);
	mod3.start(t);
	mod4.start(t + interval);

	function setDelay(d) {
		modGain1.gain.setTargetAtTime(0.5 * d, ctx.currentTime, 0.010);
		modGain2.gain.setTargetAtTime(0.5 * d, ctx.currentTime, 0.010);
	}

	// mult is in octaves-ish: +1 ~ up an octave, -1 ~ down an octave, 0 = flat.
	function setPitchOffset(mult) {
		if (mult > 0) {
			mod1Gain.gain.value = 0; mod2Gain.gain.value = 0;
			mod3Gain.gain.value = 1; mod4Gain.gain.value = 1;
		} else {
			mod1Gain.gain.value = 1; mod2Gain.gain.value = 1;
			mod3Gain.gain.value = 0; mod4Gain.gain.value = 0;
		}
		setDelay(delayTime * Math.abs(mult));
	}

	setPitchOffset(0);
	return { input, output, setPitchOffset };
}

// Build the full voice FX chain on ctx. Returns { input, output, set* } with all effects
// live-adjustable (no rebuild needed for parameter changes).
function buildVoiceGraph(ctx) {
	const input = ctx.createGain();
	const output = ctx.createGain();

	const pitch = createPitchShifter(ctx);
	const ringMod = createRingMod(ctx);
	const shaper = ctx.createWaveShaper();
	const filter = ctx.createBiquadFilter();
	filter.type = 'allpass'; // flat until telephone enabled

	const convolver = ctx.createConvolver();
	convolver.buffer = makeImpulseResponse(ctx, 2.0, 3.0);
	const wetGain = ctx.createGain();
	const dryGain = ctx.createGain();
	wetGain.gain.value = 0;
	dryGain.gain.value = 1;

	// input -> pitch -> ringMod -> shaper -> filter -> [dry + reverb] -> output
	input.connect(pitch.input);
	pitch.output.connect(ringMod.input);
	ringMod.output.connect(shaper);
	shaper.connect(filter);
	filter.connect(dryGain);
	dryGain.connect(output);
	filter.connect(convolver);
	convolver.connect(wetGain);
	wetGain.connect(output);

	return {
		input,
		output,
		// pitch in semitones (-12..+12). Convert to Jungle octave multiplier.
		setPitch(semitones) { pitch.setPitchOffset((semitones || 0) / 12); },
		setRobot(depth) { ringMod.setDepth(Math.max(0, Math.min(1, depth || 0))); },
		setRobotFreq(f) { ringMod.setFreq(f); },
		setDistortion(amount) { shaper.curve = amount > 0 ? makeDistortionCurve(amount) : null; },
		setTelephone(on) {
			if (on) { filter.type = 'bandpass'; filter.frequency.value = 1700; filter.Q.value = 0.7; }
			else { filter.type = 'allpass'; }
		},
		setReverb(amount) {
			const a = Math.max(0, Math.min(1, amount || 0));
			wetGain.gain.value = a;
			dryGain.gain.value = 1 - 0.5 * a; // keep some dry so voice stays intelligible
		}
	};
}

// Expose the pure DSP for the standalone test harness.
window.HardChatsAudioFX = { buildVoiceGraph, createPitchShifter, createRingMod, makeDistortionCurve, makeImpulseResponse };

// ---------- App integration (voice changer state + wiring) ----------

let fxActive = false;   // voice changer engaged
let fxGraph = null;     // buildVoiceGraph() result
let fxSource = null;    // MediaStreamAudioSourceNode reading the raw mic
let fxDest = null;      // MediaStreamAudioDestinationNode -> processed track
let fxMonitorEl = null; // optional self-monitor <audio>

// Default params. Presets and sliders mutate this; applyFxParams pushes to the graph.
const fxParams = {
	pitch: 0,        // semitones
	reverb: 0,       // 0..1
	distortion: 0,   // 0..1
	robot: 0,        // 0..1
	telephone: false
};

// The one track every audio sender should carry. Falls back to the raw mic when the
// changer is off. Breakout gating calls this exclusively.
function getOutgoingAudioTrack() {
	if (fxActive && fxDest) {
		const t = fxDest.stream.getAudioTracks()[0];
		if (t) return t;
	}
	return state.localStream?.getAudioTracks()[0] || null;
}

function ensureFxGraph() {
	const ctx = getAudioCtx();
	if (!ctx) return false;
	if (!fxGraph) fxGraph = buildVoiceGraph(ctx);
	if (!fxDest) {
		fxDest = ctx.createMediaStreamDestination();
		fxGraph.output.connect(fxDest);
	}
	buildFxSource(ctx);
	applyFxParams();
	return true;
}

// (Re)create the source node from the current raw mic and connect it to the graph head.
function buildFxSource(ctx) {
	if (!ctx || !state.localStream) return;
	if (fxSource) { try { fxSource.disconnect(); } catch (e) {} fxSource = null; }
	try {
		fxSource = ctx.createMediaStreamSource(state.localStream);
		fxSource.connect(fxGraph.input);
	} catch (e) {
		console.warn('[FX] buildFxSource failed:', e?.message || e);
	}
}

// Called on mic-device switch (from settings.js) to re-point the graph at the new mic.
function rebuildVoiceFxSource() {
	if (!fxActive || !fxGraph) return;
	const ctx = getAudioCtx();
	buildFxSource(ctx);
}

function applyFxParams() {
	if (!fxGraph) return;
	fxGraph.setPitch(fxParams.pitch);
	fxGraph.setReverb(fxParams.reverb);
	fxGraph.setDistortion(fxParams.distortion);
	fxGraph.setRobot(fxParams.robot);
	fxGraph.setTelephone(fxParams.telephone);
}

// Turn the changer on/off. Pushing the correct outgoing track to every peer is done via
// the existing breakout-gating path (which reads getOutgoingAudioTrack()).
function setVoiceChangerActive(on) {
	if (on) {
		if (!ensureFxGraph()) return;
		fxActive = true;
	} else {
		fxActive = false;
	}
	if (typeof applyBreakoutGatingAll === 'function') applyBreakoutGatingAll();
	updateMonitor();
}

// Optional self-monitor: hear your own processed voice locally. Off by default (speaker
// output risks echo). Routed through a dedicated element, muted unless enabled.
function updateMonitor() {
	const wantMonitor = fxActive && $('vc-monitor')?.dataset.enabled === 'true';
	if (wantMonitor) {
		if (!fxMonitorEl) {
			fxMonitorEl = document.createElement('audio');
			fxMonitorEl.autoplay = true;
			fxMonitorEl.id = 'vc-monitor-audio';
			(document.getElementById('peer-audio-container') || document.body).appendChild(fxMonitorEl);
		}
		if (fxDest && fxMonitorEl.srcObject !== fxDest.stream) fxMonitorEl.srcObject = fxDest.stream;
		fxMonitorEl.muted = false;
		fxMonitorEl.play?.().catch(() => {});
	} else if (fxMonitorEl) {
		fxMonitorEl.muted = true;
	}
}

// ---------- Popup UI ----------

const VC_PRESETS = {
	none:      { pitch: 0,   reverb: 0,    distortion: 0,    robot: 0,   telephone: false },
	chipmunk:  { pitch: 7,   reverb: 0,    distortion: 0,    robot: 0,   telephone: false },
	demon:     { pitch: -7,  reverb: 0.25, distortion: 0.15, robot: 0,   telephone: false },
	robot:     { pitch: 0,   reverb: 0,    distortion: 0,    robot: 0.9, telephone: false },
	telephone: { pitch: 0,   reverb: 0,    distortion: 0.1,  robot: 0,   telephone: true  },
	alien:     { pitch: 4,   reverb: 0.5,  distortion: 0,    robot: 0.4, telephone: false }
};

function openVoiceChanger() {
	$('voice-changer-modal')?.classList.remove('hidden');
	syncVcControls();
}

function closeVoiceChanger() {
	$('voice-changer-modal')?.classList.add('hidden');
}

// Reflect fxParams into the sliders/labels.
function syncVcControls() {
	const p = $('vc-pitch'); if (p) p.value = fxParams.pitch;
	const r = $('vc-reverb'); if (r) r.value = Math.round(fxParams.reverb * 100);
	const d = $('vc-distortion'); if (d) d.value = Math.round(fxParams.distortion * 100);
	const rb = $('vc-robot'); if (rb) rb.value = Math.round(fxParams.robot * 100);
	const tel = $('vc-telephone'); if (tel) tel.dataset.enabled = String(fxParams.telephone);
	const en = $('vc-enable'); if (en) en.dataset.enabled = String(fxActive);
	updateVcLabels();
}

function updateVcLabels() {
	const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
	set('vc-pitch-val', (fxParams.pitch > 0 ? '+' : '') + fxParams.pitch);
	set('vc-reverb-val', Math.round(fxParams.reverb * 100) + '%');
	set('vc-distortion-val', Math.round(fxParams.distortion * 100) + '%');
	set('vc-robot-val', Math.round(fxParams.robot * 100) + '%');
}

function applyPreset(name) {
	const preset = VC_PRESETS[name];
	if (!preset) return;
	Object.assign(fxParams, preset);
	applyFxParams();
	syncVcControls();
	if (!fxActive) { setVoiceChangerActive(true); const en = $('vc-enable'); if (en) en.dataset.enabled = 'true'; }
}

function initVoiceChangerListeners() {
	$('voice-changer-close')?.addEventListener('click', closeVoiceChanger);
	$('voice-changer-modal')?.addEventListener('click', (e) => {
		if (e.target.id === 'voice-changer-modal') closeVoiceChanger();
	});

	$('vc-enable')?.addEventListener('click', () => {
		const on = $('vc-enable').dataset.enabled !== 'true';
		$('vc-enable').dataset.enabled = String(on);
		setVoiceChangerActive(on);
	});

	$('vc-monitor')?.addEventListener('click', () => {
		const on = $('vc-monitor').dataset.enabled !== 'true';
		$('vc-monitor').dataset.enabled = String(on);
		updateMonitor();
	});

	$('vc-telephone')?.addEventListener('click', () => {
		fxParams.telephone = $('vc-telephone').dataset.enabled !== 'true';
		$('vc-telephone').dataset.enabled = String(fxParams.telephone);
		applyFxParams();
	});

	const bindSlider = (id, key, scale) => {
		$(id)?.addEventListener('input', (e) => {
			fxParams[key] = scale ? Number(e.target.value) / 100 : Number(e.target.value);
			applyFxParams();
			updateVcLabels();
		});
	};
	bindSlider('vc-pitch', 'pitch', false);
	bindSlider('vc-reverb', 'reverb', true);
	bindSlider('vc-distortion', 'distortion', true);
	bindSlider('vc-robot', 'robot', true);

	document.querySelectorAll('.vc-preset').forEach(btn => {
		btn.addEventListener('click', () => applyPreset(btn.dataset.preset));
	});
}
