// HardChats - WebRTC Peer Connections, ICE, Audio Analysers
// Requires: state, pendingCandidates, send from state.js
// Requires: getRtcConfig from turn.js
// Requires: updateUI, updateSpeakingIndicator, updateUsersList from ui.js

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

		const primer = document.createElement('audio');
		primer.autoplay = true;
		primer.playsInline = true;
		primer.id = 'audio-playback-primer';
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

// Network quality monitoring
function startNetworkMonitoring(peerId) {
	const peer = state.peers[peerId];
	if (!peer) return;

	// Clear existing interval if any
	if (peer.statsInterval) {
		clearInterval(peer.statsInterval);
	}

	peer.prevStats = null;

	peer.statsInterval = setInterval(async () => {
		if (!peer.pc || peer.pc.connectionState === 'closed') {
			clearInterval(peer.statsInterval);
			return;
		}

		try {
			const stats = await peer.pc.getStats();
			let packetsLost = 0;
			let packetsReceived = 0;
			let jitter = 0;
			let roundTripTime = 0;
			let hasAudioStats = false;

			stats.forEach(report => {
				// Look for inbound-rtp stats for audio
				if (report.type === 'inbound-rtp' && report.kind === 'audio') {
					packetsReceived = report.packetsReceived || 0;
					packetsLost = report.packetsLost || 0;
					jitter = report.jitter || 0;
					hasAudioStats = true;
				}

				// Look for candidate-pair stats for RTT
				if (report.type === 'candidate-pair' && report.state === 'succeeded') {
					roundTripTime = report.currentRoundTripTime || 0;
				}
			});

			if (!hasAudioStats) return;

			// Calculate packet loss percentage
			const totalPackets = packetsReceived + packetsLost;
			const lossPercent = totalPackets > 0 ? (packetsLost / totalPackets) * 100 : 0;

			// Determine quality based on metrics
			// Packet loss: <1% excellent, 1-3% good, 3-8% fair, >8% poor
			// Jitter: <30ms excellent, 30-50ms good, 50-100ms fair, >100ms poor
			// RTT: <100ms excellent, 100-200ms good, 200-400ms fair, >400ms poor

			let quality, bars;

			if (lossPercent < 1 && jitter < 0.03 && roundTripTime < 0.1) {
				quality = 'excellent';
				bars = 4;
			} else if (lossPercent < 3 && jitter < 0.05 && roundTripTime < 0.2) {
				quality = 'good';
				bars = 3;
			} else if (lossPercent < 8 && jitter < 0.1 && roundTripTime < 0.4) {
				quality = 'fair';
				bars = 2;
			} else {
				quality = 'poor';
				bars = 1;
			}

			peer.networkQuality = quality;
			peer.networkBars = bars;
			peer.packetLoss = lossPercent.toFixed(1);
			peer.jitter = (jitter * 1000).toFixed(0);
			peer.rtt = (roundTripTime * 1000).toFixed(0);

			updateUsersList();

		} catch (e) {
			console.error('[Stats] Error getting peer stats:', e);
		}
	}, 3000); // Check every 3 seconds
}

async function createPeerConnection(peerId, username, initiator) {
	if (state.peers[peerId]) {
		teardownPeerAudio(peerId);
		if (state.peers[peerId].connectionTimeout) clearTimeout(state.peers[peerId].connectionTimeout);
		if (state.peers[peerId].statsInterval) clearInterval(state.peers[peerId].statsInterval);
		try { state.peers[peerId].pc.close(); } catch (e) {}
	}

	const peerStartTime = performance.now();

	// Use TURN config from turn.js
	const pc = new RTCPeerConnection(getRtcConfig());

	// Apply DEFCON mode if enabled - auto-mute and hide video for new peers
	const applyDefcon = state.defconMode;

	state.peers[peerId] = {
		pc,
		stream: null,
		username,
		camOn: state.users[peerId]?.camOn || false,
		muted: applyDefcon, // Mute if DEFCON mode
		videoOff: applyDefcon, // Hide video if DEFCON mode
		volume: applyDefcon ? 0 : 100, // Set volume to 0 if DEFCON mode
		// Audio path fields - populated lazily by setupPeerAudio. Listed here for
		// shape documentation; setupPeerAudio is the only thing that creates them.
		// Output goes through audioElement (srcObject = WebRTC stream); analyser is
		// for speaking detection only.
		audioSource: null,
		analyser: null,
		audioElement: null,
		speakingLoopActive: false,
		networkQuality: 'unknown',
		networkBars: 0,
		statsInterval: null,
		iceRestartCount: 0,
		connectionTimeout: null,
		screenSender: null,
		initiator,
		// Perfect negotiation state. Polite peer (deterministic by peer-id compare)
		// rolls back its own offer when an offer collision happens; impolite peer
		// ignores the incoming offer. This keeps both sides from wedging each other.
		polite: state.myId > peerId,
		makingOffer: false,
		ignoreOffer: false
	};

	state.localStream.getTracks().forEach(track => {
		const sender = pc.addTrack(track, state.localStream);
		// Stash the audio sender so breakout gating can call replaceTrack(null) on
		// just this peer when we shouldn't be transmitting to them. track.enabled
		// would mute for everyone (shared track ref).
		if (track.kind === 'audio') state.peers[peerId].audioSender = sender;
	});

	// If screen is currently being shared, add the screen track for this new peer
	if (state.screenEnabled && state.screenStream) {
		const screenTrack = state.screenStream.getVideoTracks()[0];
		if (screenTrack && screenTrack.readyState === 'live') {
			state.peers[peerId].screenSender = pc.addTrack(screenTrack, state.screenStream);
		}
	}

	pc.ontrack = (e) => {
		const stream = e.streams[0];
		if (!stream) return;

		const elapsed = Math.round(performance.now() - peerStartTime);
		console.log(`[WebRTC] Got remote track from ${peerId} (${e.track.kind}) after ${elapsed}ms`);

		const hasAudio = stream.getAudioTracks().length > 0;
		const hasVideo = stream.getVideoTracks().length > 0;

		// Audio playback is now wholly owned by setupPeerAudio (Web Audio graph + hidden
		// <audio>). Track-level .enabled flips are not needed - global mute and per-peer
		// volume are handled at the audio element / GainNode.
		if (hasAudio) {
			setupPeerAudio(peerId, stream);
			// Use this as the display stream only if we don't already have one - keeps
			// a later screen-share video-only stream from displacing audio+camera here.
			if (!state.peers[peerId].stream) {
				state.peers[peerId].stream = stream;
			}
		}
		if (hasVideo) {
			// Latest video stream wins for the visible tile (current behavior preserved).
			state.peers[peerId].stream = stream;
			state.peers[peerId].camOn = true;
			if (state.users[peerId]) state.users[peerId].camOn = true;
		}

		updateUI();

		stream.onaddtrack = (ev) => {
			if (ev.track.kind === 'video') {
				state.peers[peerId].camOn = true;
				if (state.users[peerId]) state.users[peerId].camOn = true;
				updateUI();
			}
		};

		stream.onremovetrack = (ev) => {
			if (ev.track.kind === 'video') {
				state.peers[peerId].camOn = false;
				if (state.users[peerId]) state.users[peerId].camOn = false;
				updateUI();
			}
		};
	};

	pc.onicecandidate = (e) => {
		if (e.candidate) {
			send({ type: 'candidate', target: peerId, candidate: e.candidate });
		}
	};

	pc.onicegatheringstatechange = () => {
		if (state.peers[peerId]?.pc !== pc) return; // stale listener from a replaced pc
		const elapsed = Math.round(performance.now() - peerStartTime);
		console.log(`[WebRTC] Peer ${peerId} ICE gathering: ${pc.iceGatheringState} (${elapsed}ms)`);
	};

	pc.oniceconnectionstatechange = () => {
		if (state.peers[peerId]?.pc !== pc) return; // stale listener from a replaced pc
		const elapsed = Math.round(performance.now() - peerStartTime);
		console.log(`[WebRTC] Peer ${peerId} ICE connection: ${pc.iceConnectionState} (${elapsed}ms)`);

		if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
			// ICE is connected — clear timeout
			if (state.peers[peerId]?.connectionTimeout) {
				clearTimeout(state.peers[peerId].connectionTimeout);
				state.peers[peerId].connectionTimeout = null;
			}
		} else if (pc.iceConnectionState === 'disconnected') {
			// ICE disconnected — wait 5s, then attempt ICE restart if still disconnected
			console.warn(`[WebRTC] Peer ${peerId} ICE disconnected, will retry in 5s if not recovered`);
			setTimeout(() => {
				if (state.peers[peerId] && state.peers[peerId].pc === pc &&
					pc.iceConnectionState === 'disconnected' &&
					state.ws?.readyState === WebSocket.OPEN) {
					console.log(`[WebRTC] Peer ${peerId} still disconnected, attempting ICE restart`);
					attemptIceRestart(peerId, pc);
				}
			}, 5000);
		}
	};

	pc.onconnectionstatechange = async () => {
		if (state.peers[peerId]?.pc !== pc) return; // stale listener from a replaced pc
		const elapsed = Math.round(performance.now() - peerStartTime);
		console.log(`[WebRTC] Peer ${peerId} connection: ${pc.connectionState} (${elapsed}ms)`);

		if (pc.connectionState === 'connected') {
			// Clear connection timeout
			if (state.peers[peerId]?.connectionTimeout) {
				clearTimeout(state.peers[peerId].connectionTimeout);
				state.peers[peerId].connectionTimeout = null;
			}
			// Reset ICE restart counter on successful connection
			if (state.peers[peerId]) state.peers[peerId].iceRestartCount = 0;
			startNetworkMonitoring(peerId);
			updateUI();

		} else if (pc.connectionState === 'failed') {
			attemptIceRestart(peerId, pc);

		} else if (pc.connectionState === 'closed') {
			if (state.peers[peerId]?.connectionTimeout) {
				clearTimeout(state.peers[peerId].connectionTimeout);
			}
			if (state.peers[peerId]?.statsInterval) {
				clearInterval(state.peers[peerId].statsInterval);
			}

		} else if (pc.connectionState === 'disconnected') {
			console.log(`[WebRTC] Peer ${peerId} disconnected (may reconnect via ICE)`);
			if (state.peers[peerId]?.statsInterval) {
				clearInterval(state.peers[peerId].statsInterval);
			}
		}
	};

	// Connection timeout: if not connected within 15s, tear down and renegotiate
	state.peers[peerId].connectionTimeout = setTimeout(() => {
		if (!state.peers[peerId]) return;
		const connState = state.peers[peerId].pc.connectionState;
		if (connState !== 'connected') {
			console.warn(`[WebRTC] Peer ${peerId} connection timed out (state: ${connState}), renegotiating...`);
			renegotiatePeer(peerId, username);
		}
	}, 15000);

	if (initiator) {
		pc.addTransceiver('video', { direction: 'recvonly' });
		await sendOffer(peerId);
	}

	return pc;
}

// Centralized offer creation. Sets makingOffer so handleOffer can detect collisions
// (a remote offer arriving while we're mid-offer = glare).
async function sendOffer(peerId, options = {}) {
	const peer = state.peers[peerId];
	if (!peer || !peer.pc || peer.pc.connectionState === 'closed') return;
	if (state.ws?.readyState !== WebSocket.OPEN) return;

	try {
		peer.makingOffer = true;
		const offer = await peer.pc.createOffer(options);
		// If a remote offer was applied during createOffer (rollback path), bail.
		if (peer.pc.signalingState !== 'stable') {
			console.log(`[WebRTC] sendOffer aborted for ${peerId} (signalingState=${peer.pc.signalingState})`);
			return;
		}
		await peer.pc.setLocalDescription(offer);
		send({ type: 'offer', target: peerId, sdp: peer.pc.localDescription.sdp });
	} catch (e) {
		console.error(`[WebRTC] sendOffer failed for ${peerId}:`, e?.message || e);
	} finally {
		if (state.peers[peerId]) state.peers[peerId].makingOffer = false;
	}
}

async function attemptIceRestart(peerId, pc) {
	const restartCount = state.peers[peerId]?.iceRestartCount || 0;
	if (restartCount < 3 && state.ws?.readyState === WebSocket.OPEN) {
		if (state.peers[peerId]) state.peers[peerId].iceRestartCount = restartCount + 1;
		console.log(`[WebRTC] Attempting ICE restart for ${peerId} (attempt ${restartCount + 1}/3)`);
		try {
			await sendOffer(peerId, { iceRestart: true });
			return;
		} catch (e) {
			console.error(`[WebRTC] ICE restart failed for ${peerId}:`, e?.message || e);
		}
	}

	// ICE restarts exhausted. Tear down this peer connection, but keep the user in the
	// roster - vanishing the user with no recovery path was the source of the "person
	// disappears and never comes back" bug. After a short delay, rebuild the connection
	// from scratch as initiator. Server-driven user_left is the only thing that should
	// remove a user.
	console.error(`[WebRTC] Peer ${peerId} ICE restarts exhausted - rebuilding connection`);

	const username = state.peers[peerId]?.username || state.users[peerId]?.username;

	if (state.peers[peerId]) {
		teardownPeerAudio(peerId);
		if (state.peers[peerId].connectionTimeout) clearTimeout(state.peers[peerId].connectionTimeout);
		if (state.peers[peerId].statsInterval) clearInterval(state.peers[peerId].statsInterval);
		try { state.peers[peerId].pc.close(); } catch (e) {}
		delete state.peers[peerId];
	}
	delete pendingCandidates[peerId];
	if (state.maximizedPeer === peerId) state.maximizedPeer = null;
	updateUI();

	// Rebuild after a brief delay. If both sides hit this simultaneously they'll both
	// initiate; perfect-negotiation in handleOffer resolves the resulting collision.
	setTimeout(() => {
		if (state.users[peerId] && !state.peers[peerId] &&
			state.ws?.readyState === WebSocket.OPEN && username) {
			console.log(`[WebRTC] Rebuilding peer connection with ${peerId}`);
			createPeerConnection(peerId, username, true);
		}
	}, 3000);
}

async function renegotiatePeer(peerId, username) {
	// Tear down old connection and create a fresh one
	if (!state.users[peerId]) return;
	if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;

	console.log(`[WebRTC] Renegotiating connection with ${peerId}`);

	// Clean up old peer
	if (state.peers[peerId]) {
		teardownPeerAudio(peerId);
		if (state.peers[peerId].connectionTimeout) clearTimeout(state.peers[peerId].connectionTimeout);
		if (state.peers[peerId].statsInterval) clearInterval(state.peers[peerId].statsInterval);
		try { state.peers[peerId].pc.close(); } catch (e) {}
		delete state.peers[peerId];
		delete pendingCandidates[peerId];
	}

	// Create a fresh connection as initiator
	await createPeerConnection(peerId, username, true);
}

async function handleOffer(peerId, username, sdp) {
	let pc;
	let peer = state.peers[peerId];

	// Check if peer connection already exists (renegotiation)
	if (peer && peer.pc &&
		peer.pc.connectionState !== 'closed' &&
		peer.pc.connectionState !== 'failed') {
		pc = peer.pc;
		console.log(`[WebRTC] Renegotiating with ${peerId}`);
	} else {
		pc = await createPeerConnection(peerId, username, false);
		peer = state.peers[peerId];
	}

	if (!peer) return;

	// Perfect negotiation: detect glare (remote offer arrived while we're mid-offer
	// or have a pending local offer). Impolite peer ignores; polite peer rolls back
	// its own offer and accepts the remote one.
	const offerCollision = peer.makingOffer || pc.signalingState !== 'stable';
	peer.ignoreOffer = !peer.polite && offerCollision;

	if (peer.ignoreOffer) {
		console.log(`[WebRTC] Ignoring colliding offer from ${peerId} (impolite side)`);
		return;
	}

	try {
		if (offerCollision) {
			console.log(`[WebRTC] Rolling back for offer collision with ${peerId} (polite side)`);
			await pc.setLocalDescription({ type: 'rollback' });
		}
		await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp }));

		// Flush any ICE candidates that arrived before remote description was set
		await flushPendingCandidates(peerId);

		const answer = await pc.createAnswer();
		await pc.setLocalDescription(answer);
		send({ type: 'answer', target: peerId, sdp: answer.sdp });
	} catch (e) {
		console.error(`[WebRTC] handleOffer failed for ${peerId}:`, e?.message || e);
	}
}

async function handleAnswer(peerId, sdp) {
	const peer = state.peers[peerId];
	if (!peer) return;
	// Only valid in have-local-offer. After perfect-negotiation rollback, or if the answer
	// is for a discarded offer, signalingState will be something else and setRemoteDescription
	// would throw. Quietly drop late/orphan answers.
	if (peer.pc.signalingState !== 'have-local-offer') {
		console.log(`[WebRTC] Ignoring answer from ${peerId} (signalingState=${peer.pc.signalingState})`);
		return;
	}
	try {
		await peer.pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp }));
		await flushPendingCandidates(peerId);
	} catch (e) {
		console.error(`[WebRTC] handleAnswer failed for ${peerId}:`, e?.message || e);
	}
}

async function handleCandidate(peerId, candidate) {
	const peer = state.peers[peerId];
	if (!peer) return;

	if (peer.pc.remoteDescription) {
		// Peer connection ready - add candidate directly
		try {
			await peer.pc.addIceCandidate(new RTCIceCandidate(candidate));
		} catch (e) {
			// Suppress errors when we deliberately ignored the offer this candidate belongs to
			if (!peer.ignoreOffer) {
				console.error(`[WebRTC] Failed to add ICE candidate for ${peerId}:`, e);
			}
		}
	} else {
		// Buffer candidate until peer connection and remote description are ready
		if (!pendingCandidates[peerId]) pendingCandidates[peerId] = [];
		pendingCandidates[peerId].push(candidate);
		console.log(`[WebRTC] Buffered ICE candidate for ${peerId} (${pendingCandidates[peerId].length} pending)`);
	}
}

async function flushPendingCandidates(peerId) {
	if (!pendingCandidates[peerId] || pendingCandidates[peerId].length === 0) return;

	const peer = state.peers[peerId];
	if (!peer || !peer.pc.remoteDescription) return;

	console.log(`[WebRTC] Flushing ${pendingCandidates[peerId].length} buffered candidates for ${peerId}`);
	for (const candidate of pendingCandidates[peerId]) {
		try {
			await peer.pc.addIceCandidate(new RTCIceCandidate(candidate));
		} catch (e) {
			console.error(`[WebRTC] Failed to add buffered candidate:`, e);
		}
	}
	delete pendingCandidates[peerId];
}

// Build (or rebuild) the audio path for a peer:
//
//   stream  ->  <audio autoplay playsinline>.srcObject   (output: speakers)
//   stream  ->  MediaStreamSource -> AnalyserNode        (speaking indicator only)
//
// Audio output is the canonical WebRTC pattern: <audio>.srcObject = remoteStream
// directly. Mobile browsers (Android Chrome, iOS Safari) treat WebRTC remote streams
// as real network media for autoplay and audio-session purposes, so playback starts
// reliably as long as the page has had any prior user activation (the Connect tap).
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

		// Per-peer hidden <audio> element. Created once, reused across renegotiations.
		if (!peer.audioElement) {
			const audioEl = document.createElement('audio');
			audioEl.autoplay = true;
			audioEl.playsInline = true;
			audioEl.id = `peer-audio-${peerId}`;
			const container = document.getElementById('peer-audio-container') || document.body;
			container.appendChild(audioEl);
			peer.audioElement = audioEl;
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
}

