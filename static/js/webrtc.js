// HardChats - WebRTC Peer Connections, ICE, Audio Analysers
// Requires: state, pendingCandidates, send from state.js
// Requires: getRtcConfig from turn.js
// Requires: updateUI, updateSpeakingIndicator, updateUsersList from ui.js

function setupLocalAudioAnalyser() {
	try {
		const audioContext = new (window.AudioContext || window.webkitAudioContext)();
		const analyser = audioContext.createAnalyser();
		analyser.fftSize = 256;
		const source = audioContext.createMediaStreamSource(state.localStream);
		source.connect(analyser);

		state.localAudioContext = audioContext;
		state.localAnalyser = analyser;

		const dataArray = new Uint8Array(analyser.frequencyBinCount);

		const checkAudio = () => {
			if (!state.localAnalyser) return;
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
		console.error('Local audio analyser error:', e);
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
		if (state.peers[peerId].connectionTimeout) clearTimeout(state.peers[peerId].connectionTimeout);
		if (state.peers[peerId].statsInterval) clearInterval(state.peers[peerId].statsInterval);
		state.peers[peerId].pc.close();
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
		audioContext: null,
		analyser: null,
		gainNode: null,
		networkQuality: 'unknown',
		networkBars: 0,
		statsInterval: null,
		iceRestartCount: 0,
		connectionTimeout: null,
		screenSender: null,
		initiator
	};

	state.localStream.getTracks().forEach(track => pc.addTrack(track, state.localStream));

	// If screen is currently being shared, add the screen track for this new peer
	if (state.screenEnabled && state.screenStream) {
		const screenTrack = state.screenStream.getVideoTracks()[0];
		if (screenTrack && screenTrack.readyState === 'live') {
			state.peers[peerId].screenSender = pc.addTrack(screenTrack, state.screenStream);
		}
	}

	pc.ontrack = (e) => {
		const stream = e.streams[0];
		if (stream) {
			const elapsed = Math.round(performance.now() - peerStartTime);
			console.log(`[WebRTC] Got remote track from ${peerId} (${e.track.kind}) after ${elapsed}ms`);
			state.peers[peerId].stream = stream;
			stream.getAudioTracks().forEach(t => t.enabled = state.volumeEnabled && !state.peers[peerId].muted);
			setupAudioAnalyser(peerId, stream);

			const hasVideo = stream.getVideoTracks().length > 0;
			if (hasVideo) {
				state.peers[peerId].camOn = true;
				if (state.users[peerId]) state.users[peerId].camOn = true;
			}

			updateUI();

			stream.onaddtrack = (e) => {
				if (e.track.kind === 'video') {
					state.peers[peerId].camOn = true;
					if (state.users[peerId]) state.users[peerId].camOn = true;
					updateUI();
				}
			};

			stream.onremovetrack = (e) => {
				if (e.track.kind === 'video') {
					state.peers[peerId].camOn = false;
					if (state.users[peerId]) state.users[peerId].camOn = false;
					updateUI();
				}
			};
		}
	};

	pc.onicecandidate = (e) => {
		if (e.candidate) {
			send({ type: 'candidate', target: peerId, candidate: e.candidate });
		}
	};

	pc.onicegatheringstatechange = () => {
		const elapsed = Math.round(performance.now() - peerStartTime);
		console.log(`[WebRTC] Peer ${peerId} ICE gathering: ${pc.iceGatheringState} (${elapsed}ms)`);
	};

	pc.oniceconnectionstatechange = () => {
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
		const offer = await pc.createOffer();
		await pc.setLocalDescription(offer);
		send({ type: 'offer', target: peerId, sdp: offer.sdp });
	}

	return pc;
}

async function attemptIceRestart(peerId, pc) {
	const restartCount = state.peers[peerId]?.iceRestartCount || 0;
	if (restartCount < 3 && state.ws?.readyState === WebSocket.OPEN) {
		if (state.peers[peerId]) state.peers[peerId].iceRestartCount = restartCount + 1;
		console.log(`[WebRTC] Attempting ICE restart for ${peerId} (attempt ${restartCount + 1}/3)`);
		try {
			const offer = await pc.createOffer({ iceRestart: true });
			await pc.setLocalDescription(offer);
			send({ type: 'offer', target: peerId, sdp: offer.sdp });
			return;
		} catch (e) {
			console.error(`[WebRTC] ICE restart failed for ${peerId}:`, e?.message || e);
		}
	}

	// ICE restart exhausted or failed - clean up after delay
	console.error(`[WebRTC] Peer ${peerId} connection failed (ICE restarts exhausted)`);
	if (state.peers[peerId]?.statsInterval) {
		clearInterval(state.peers[peerId].statsInterval);
	}
	setTimeout(() => {
		if (state.peers[peerId] &&
			(state.peers[peerId].pc.connectionState === 'failed' ||
				state.peers[peerId].pc.connectionState === 'closed')) {
			console.log(`[WebRTC] Cleaning up failed peer ${peerId}`);
			if (state.peers[peerId].audioContext) state.peers[peerId].audioContext.close();
			state.peers[peerId].pc.close();
			delete state.peers[peerId];
			delete state.users[peerId];
			delete pendingCandidates[peerId];
			if (state.maximizedPeer === peerId) {
				state.maximizedPeer = null;
			}
			updateUI();
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
		if (state.peers[peerId].connectionTimeout) clearTimeout(state.peers[peerId].connectionTimeout);
		if (state.peers[peerId].statsInterval) clearInterval(state.peers[peerId].statsInterval);
		if (state.peers[peerId].audioContext) state.peers[peerId].audioContext.close();
		state.peers[peerId].pc.close();
		delete state.peers[peerId];
		delete pendingCandidates[peerId];
	}

	// Create a fresh connection as initiator
	await createPeerConnection(peerId, username, true);
}

async function handleOffer(peerId, username, sdp) {
	let pc;

	// Check if peer connection already exists (renegotiation)
	if (state.peers[peerId] && state.peers[peerId].pc &&
		state.peers[peerId].pc.connectionState !== 'closed' &&
		state.peers[peerId].pc.connectionState !== 'failed') {
		// Reuse existing connection for renegotiation
		pc = state.peers[peerId].pc;
		console.log(`[WebRTC] Renegotiating with ${peerId}`);
	} else {
		// Create new connection for new peer
		pc = await createPeerConnection(peerId, username, false);
	}

	await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp }));

	// Flush any ICE candidates that arrived before remote description was set
	await flushPendingCandidates(peerId);

	const answer = await pc.createAnswer();
	await pc.setLocalDescription(answer);
	send({ type: 'answer', target: peerId, sdp: answer.sdp });
}

async function handleAnswer(peerId, sdp) {
	const peer = state.peers[peerId];
	if (peer) {
		await peer.pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp }));

		// Flush any ICE candidates that arrived before remote description was set
		await flushPendingCandidates(peerId);
	}
}

async function handleCandidate(peerId, candidate) {
	const peer = state.peers[peerId];
	if (peer && peer.pc.remoteDescription) {
		// Peer connection ready - add candidate directly
		try {
			await peer.pc.addIceCandidate(new RTCIceCandidate(candidate));
		} catch (e) {
			console.error(`[WebRTC] Failed to add ICE candidate for ${peerId}:`, e);
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

function setupAudioAnalyser(peerId, stream) {
	try {
		// Close existing audio context if any
		if (state.peers[peerId]?.audioContext) {
			state.peers[peerId].audioContext.close();
		}

		const audioContext = new (window.AudioContext || window.webkitAudioContext)();

		// Resume audio context if suspended (browser autoplay policy)
		if (audioContext.state === 'suspended') {
			audioContext.resume();
		}

		const analyser = audioContext.createAnalyser();
		analyser.fftSize = 256;
		const source = audioContext.createMediaStreamSource(stream);

		// Create gain node for volume control
		const gainNode = audioContext.createGain();
		// Respect both global mute (volumeEnabled) and individual volume setting
		const peerVolume = (state.peers[peerId]?.volume ?? 100) / 100;
		gainNode.gain.value = state.volumeEnabled ? peerVolume : 0;

		// Connect: source -> analyser (for speaking detection)
		// Also: source -> gain -> destination (for playback with volume control)
		source.connect(analyser);
		source.connect(gainNode);
		gainNode.connect(audioContext.destination);

		state.peers[peerId].audioContext = audioContext;
		state.peers[peerId].analyser = analyser;
		state.peers[peerId].gainNode = gainNode;
		state.peers[peerId].audioSource = source;

		const dataArray = new Uint8Array(analyser.frequencyBinCount);

		const checkAudio = () => {
			if (!state.peers[peerId]) return;
			analyser.getByteFrequencyData(dataArray);
			const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
			const speaking = avg > 20;

			if (state.users[peerId] && state.users[peerId].speaking !== speaking) {
				state.users[peerId].speaking = speaking;
				updateSpeakingIndicator(peerId, speaking);
			}
			requestAnimationFrame(checkAudio);
		};
		checkAudio();

		console.log(`[Audio] Setup analyser for ${peerId}, context state: ${audioContext.state}`);
	} catch (e) {
		console.error('Audio analyser error:', e);
	}
}

