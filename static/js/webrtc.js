// HardChats - Audio Playback, Sinks & Analysers (media transport lives in livekit.js)
// Requires: state from state.js
// Requires: updateSpeakingIndicator from ui.js

// Lazily create-and-resume the single shared AudioContext. Should be called from inside
// a user gesture (the Connect button click) on first invocation so the context starts in
// 'running' state on mobile. Returns null if AudioContext isn't available.
function getAudioCtx() {
	if (!state.audioCtx) {
		try {
			state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
		} catch (e) {
			console.error('[Audio] Failed to create AudioContext:', e);
			return null;
		}
	}
	if (state.audioCtx.state === 'suspended') {
		state.audioCtx.resume().catch(e => console.warn('[Audio] resume failed:', e?.message || e));
	}
	return state.audioCtx;
}

// Start a hidden <audio> element playing a silent stream from the audio context. This
// activates the page's audio session DURING the Connect tap (transient user activation
// is still valid synchronously), so by the time peer audio elements are created later
// from ontrack events - well outside any user gesture - audio playback Just Works. Without
// this primer, mobile browsers leave new audio elements silent until some other media
// event activates the session (e.g. a remote peer's camera coming on, which creates a
// muted <video> that activates audio playback).
//
// Idempotent. Must be called synchronously inside the user-gesture handler.
function startAudioPlaybackPrimer() {
	if (state.audioPrimer) return;
	const ctx = getAudioCtx();
	if (!ctx) return;

	try {
		// Silent buffer source piping into a MediaStreamDestination. We use a non-zero
		// gain (well below audible) so browsers don't optimize the path away as silent.
		const buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
		const source = ctx.createBufferSource();
		source.buffer = buffer;
		source.loop = true;
		const gain = ctx.createGain();
		gain.gain.value = 0.0001;
		const dest = ctx.createMediaStreamDestination();
		source.connect(gain);
		gain.connect(dest);
		source.start();

		// Tag matches the per-peer sink (see setupPeerAudio). Using <video> here too
		// keeps the entire audio session in the same iOS category so the first peer
		// audio element doesn't accidentally re-classify it.
		const useVideo = state.settings?.speakerMode !== false;
		const primer = document.createElement(useVideo ? 'video' : 'audio');
		primer.autoplay = true;
		primer.playsInline = true;
		primer.muted = false;
		primer.id = 'audio-playback-primer';
		primer.dataset.audioMode = useVideo ? 'video' : 'audio';
		primer.srcObject = dest.stream;
		const container = document.getElementById('peer-audio-container') || document.body;
		container.appendChild(primer);
		primer.play().catch(e => console.warn('[Audio] primer play() rejected:', e?.message || e));

		state.audioPrimer = primer;
		state.audioPrimerSource = source;
		console.log('[Audio] Playback primer started (ctx state:', ctx.state, ')');
	} catch (e) {
		console.warn('[Audio] startAudioPlaybackPrimer failed:', e?.message || e);
	}
}

// Defensive recovery for the case where a peer's <audio>.play() rejected (e.g. the
// primer didn't take, or this device's mobile browser is stricter than expected). On
// the next user tap anywhere in the page, retry play() on every peer audio element.
let pendingAudioPlayRetry = false;
function schedulePeerAudioPlayRetry() {
	if (pendingAudioPlayRetry) return;
	pendingAudioPlayRetry = true;
	const retry = () => {
		pendingAudioPlayRetry = false;
		document.removeEventListener('click', retry);
		document.removeEventListener('touchend', retry);
		Object.values(state.peers).forEach(peer => {
			if (peer.audioElement && peer.audioElement.paused) {
				peer.audioElement.play().catch(() => {});
			}
		});
		if (state.audioPrimer && state.audioPrimer.paused) {
			state.audioPrimer.play().catch(() => {});
		}
	};
	document.addEventListener('click', retry, { once: true });
	document.addEventListener('touchend', retry, { once: true });
}

function setupLocalAudioAnalyser() {
	if (!state.localStream) return;
	const ctx = getAudioCtx();
	if (!ctx) return;

	try {
		// Tear down any existing local source (e.g. mic device switch).
		if (state.localAudioSource) {
			try { state.localAudioSource.disconnect(); } catch (e) {}
			state.localAudioSource = null;
		}
		if (state.localAnalyser) {
			try { state.localAnalyser.disconnect(); } catch (e) {}
		}

		const analyser = ctx.createAnalyser();
		analyser.fftSize = 256;
		const source = ctx.createMediaStreamSource(state.localStream);
		// Local analyser is for speaking detection only. NEVER connect to destination
		// (would cause feedback - hearing yourself with delay).
		source.connect(analyser);

		state.localAnalyser = analyser;
		state.localAudioSource = source;

		const dataArray = new Uint8Array(analyser.frequencyBinCount);
		const checkAudio = () => {
			if (state.localAnalyser !== analyser) return; // replaced
			analyser.getByteFrequencyData(dataArray);
			const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
			const speaking = avg > 20;
			if (state.users['local'] && state.users['local'].speaking !== speaking) {
				state.users['local'].speaking = speaking;
				updateSpeakingIndicator('local', speaking);
			}
			requestAnimationFrame(checkAudio);
		};
		checkAudio();
	} catch (e) {
		console.error('[Audio] Local analyser error:', e);
	}
}

// Build (or rebuild) the audio path for a peer:
//
//   stream  ->  <video|audio autoplay playsinline>.srcObject   (output: speaker/earpiece)
//   stream  ->  MediaStreamSource -> AnalyserNode              (speaking indicator only)
//
// Audio output is the canonical WebRTC pattern: media-element.srcObject = remoteStream
// directly. Mobile browsers (Android Chrome, iOS Safari) treat WebRTC remote streams
// as real network media for autoplay and audio-session purposes, so playback starts
// reliably as long as the page has had any prior user activation (the Connect tap).
//
// Tag depends on settings.speakerMode (default true). On iOS, a <video> element
// playing a WebRTC stream gets the media audio-session category (loudspeaker), while
// <audio> playing the same stream while a mic capture is active gets the communication
// category (earpiece - quiet). Toggling speakerMode tears down each peer's element
// and recreates it with the new tag.
//
// The previous attempt routed audio through a Web Audio GainNode + MediaStreamDestination
// to support a 0-150% volume slider. That Web-Audio-derived stream is not classified as
// "real" media on mobile - the audio session never activated, and audio stayed silent
// until some unrelated media event (a remote peer's camera turning on, which mounts a
// muted <video> with the WebRTC stream) accidentally activated it. Going direct fixes
// that. Volume slider now caps at 100% (audio.volume is 0..1) - the >100% boost is gone.
function setupPeerAudio(peerId, stream) {
	const peer = state.peers[peerId];
	if (!peer) return;
	if (!stream || stream.getAudioTracks().length === 0) return;

	const ctx = getAudioCtx();
	if (!ctx) return;

	try {
		// Analyser is for speaking detection only. Not connected to any output.
		if (peer.audioSource) {
			try { peer.audioSource.disconnect(); } catch (e) {}
		}
		if (!peer.analyser) {
			peer.analyser = ctx.createAnalyser();
			peer.analyser.fftSize = 256;
		}
		peer.audioSource = ctx.createMediaStreamSource(stream);
		peer.audioSource.connect(peer.analyser);

		// Tap into the recording mix bus (*73#). Same source feeds analyser AND mixer.
		if (typeof tapPeerToRecordingMixer === 'function') {
			tapPeerToRecordingMixer(peerId, peer.audioSource);
		}

		// Per-peer hidden sink element. Created once, reused across renegotiations.
		// Tag depends on speakerMode: <video> routes through media category on iOS
		// (loudspeaker), <audio> routes through communication category (earpiece).
		// If the mode flipped at runtime, the old element is recreated with the new tag.
		const desiredMode = state.settings?.speakerMode !== false ? 'video' : 'audio';
		if (peer.audioElement && peer.audioElement.dataset.audioMode !== desiredMode) {
			try { peer.audioElement.srcObject = null; } catch (e) {}
			try { peer.audioElement.remove(); } catch (e) {}
			peer.audioElement = null;
		}
		if (!peer.audioElement) {
			const sinkEl = document.createElement(desiredMode);
			sinkEl.autoplay = true;
			sinkEl.playsInline = true;
			sinkEl.muted = false;
			sinkEl.dataset.audioMode = desiredMode;
			sinkEl.id = `peer-audio-${peerId}`;
			const container = document.getElementById('peer-audio-container') || document.body;
			container.appendChild(sinkEl);
			peer.audioElement = sinkEl;
		}
		// Update srcObject if the stream identity changed (renegotiation can hand us a
		// fresh MediaStream). Calling .play() again is harmless on the same stream.
		if (peer.audioElement.srcObject !== stream) {
			peer.audioElement.srcObject = stream;
			peer.audioElement.play().catch(e => {
				console.warn(`[Audio] play() rejected for ${peerId}:`, e?.message || e);
				schedulePeerAudioPlayRetry();
			});
		}

		// Apply current volume + global mute state.
		peer.audioElement.volume = Math.min(1.0, (peer.volume ?? 100) / 100);
		peer.audioElement.muted = !state.volumeEnabled;

		// Reapply breakout-room gating - if this peer is in a different room than us,
		// their audio element gets muted on top of the regular volume rules.
		if (typeof applyBreakoutGatingForPeer === 'function') {
			applyBreakoutGatingForPeer(peerId);
		}

		// Speaking-indicator loop. Started once, kept alive until teardownPeerAudio.
		if (!peer.speakingLoopActive) {
			peer.speakingLoopActive = true;
			const dataArray = new Uint8Array(peer.analyser.frequencyBinCount);
			const tick = () => {
				const p = state.peers[peerId];
				if (!p || !p.speakingLoopActive || !p.analyser) return;
				p.analyser.getByteFrequencyData(dataArray);
				const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
				const speaking = avg > 20;
				if (state.users[peerId] && state.users[peerId].speaking !== speaking) {
					state.users[peerId].speaking = speaking;
					updateSpeakingIndicator(peerId, speaking);
				}
				requestAnimationFrame(tick);
			};
			tick();
		}

		console.log(`[Audio] setup for ${peerId}, ctx state: ${ctx.state}`);
	} catch (e) {
		console.error(`[Audio] setupPeerAudio failed for ${peerId}:`, e);
	}
}

// Hidden sink for a peer's shared tab/system audio. Same tag rules as the mic sink
// (speakerMode), and the same mute/volume rules (applied via breakout gating, which
// combines global mute, per-user volume 0 and breakout state).
function setupPeerScreenAudio(peerId, stream) {
	const peer = state.peers[peerId];
	if (!peer) return;

	const desiredMode = state.settings?.speakerMode !== false ? 'video' : 'audio';
	if (peer.screenAudioElement && peer.screenAudioElement.dataset.audioMode !== desiredMode) {
		try { peer.screenAudioElement.srcObject = null; } catch (e) {}
		try { peer.screenAudioElement.remove(); } catch (e) {}
		peer.screenAudioElement = null;
	}
	if (!peer.screenAudioElement) {
		const sinkEl = document.createElement(desiredMode);
		sinkEl.autoplay = true;
		sinkEl.playsInline = true;
		sinkEl.dataset.audioMode = desiredMode;
		sinkEl.id = `peer-screen-audio-${peerId}`;
		const container = document.getElementById('peer-audio-container') || document.body;
		container.appendChild(sinkEl);
		peer.screenAudioElement = sinkEl;
	}
	if (peer.screenAudioElement.srcObject !== stream) {
		peer.screenAudioElement.srcObject = stream;
		peer.screenAudioElement.play().catch(e => {
			console.warn(`[Audio] screen audio play() rejected for ${peerId}:`, e?.message || e);
			schedulePeerAudioPlayRetry();
		});
	}
	peer.screenAudioElement.volume = Math.min(1.0, (peer.volume ?? 100) / 100);
	if (typeof applyBreakoutGatingForPeer === 'function') applyBreakoutGatingForPeer(peerId);
	console.log(`[Audio] screen audio setup for ${peerId}`);
}

// Recreate the playback primer + every peer's audio sink so the new speakerMode
// (audio vs video tag) takes effect. Called from the settings toggle handler.
function rebuildAudioSinksForSpeakerMode() {
	if (state.audioPrimer) {
		try { state.audioPrimer.srcObject = null; } catch (e) {}
		try { state.audioPrimer.remove(); } catch (e) {}
		state.audioPrimer = null;
	}
	if (state.audioPrimerSource) {
		try { state.audioPrimerSource.stop(); } catch (e) {}
		state.audioPrimerSource = null;
	}
	startAudioPlaybackPrimer();

	for (const [peerId, peer] of Object.entries(state.peers)) {
		const stream = peer.audioElement?.srcObject || peer.stream;
		if (stream && stream.getAudioTracks && stream.getAudioTracks().length > 0) {
			setupPeerAudio(peerId, stream);
		}
		if (peer.screenAudioElement?.srcObject) setupPeerScreenAudio(peerId, peer.screenAudioElement.srcObject);
	}
}

// Tear down a peer's audio path and remove its <audio> element. Safe to call multiple
// times; safe to call on partially-constructed peers.
function teardownPeerAudio(peerId) {
	const peer = state.peers[peerId];
	if (!peer) return;

	peer.speakingLoopActive = false;

	if (peer.audioSource) {
		try { peer.audioSource.disconnect(); } catch (e) {}
		peer.audioSource = null;
	}
	if (typeof untapPeerFromRecordingMixer === 'function') {
		untapPeerFromRecordingMixer(peerId);
	}
	if (peer.analyser) {
		try { peer.analyser.disconnect(); } catch (e) {}
		peer.analyser = null;
	}
	if (peer.audioElement) {
		peer.audioElement.srcObject = null;
		peer.audioElement.remove();
		peer.audioElement = null;
	}
	if (peer.screenAudioElement) {
		peer.screenAudioElement.srcObject = null;
		peer.screenAudioElement.remove();
		peer.screenAudioElement = null;
	}
}

