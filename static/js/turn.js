// HardChats TURN/STUN Server Configuration
// Config is loaded from /api/config

let TURN_CONFIG = null;
let turnTestResult = null;

// Load TURN config from server
async function loadTurnConfig(serverConfig) {
	TURN_CONFIG = {
		stun: { urls: serverConfig.turn.stun_url },
		turn: {
			host: serverConfig.turn.host,
			port: serverConfig.turn.port,
			username: serverConfig.turn.username,
			credential: serverConfig.turn.credential
		},
		iceTransportPolicy: serverConfig.turn.ice_transport_policy
	};
	console.log('[TURN] Config loaded:', TURN_CONFIG.turn.host + ':' + TURN_CONFIG.turn.port);
}

// Build ICE servers array for RTCPeerConnection
function getIceServers() {
	if (!TURN_CONFIG) {
		console.error('[TURN] Config not loaded!');
		return [];
	}
	const host = TURN_CONFIG.turn.host;
	const port = TURN_CONFIG.turn.port;
	const username = TURN_CONFIG.turn.username;
	const credential = TURN_CONFIG.turn.credential;

	return [
		// STUN server (for server-reflexive candidates)
		{ urls: TURN_CONFIG.stun.urls },
		// TURN over UDP (fastest relay)
		{
			urls: `turn:${host}:${port}`,
			username,
			credential
		},
		// TURN over TCP (fallback for UDP-blocked networks)
		{
			urls: `turn:${host}:${port}?transport=tcp`,
			username,
			credential
		}
	];
}

// Get RTCPeerConnection configuration
function getRtcConfig() {
	if (!TURN_CONFIG) {
		console.error('[TURN] Config not loaded!');
		return { iceServers: [] };
	}
	return {
		iceServers: getIceServers(),
		iceTransportPolicy: TURN_CONFIG.iceTransportPolicy,
		iceCandidatePoolSize: 4,   // Pre-allocate candidates for faster connection
		bundlePolicy: 'max-bundle' // Bundle all media into one transport
	};
}

// Test TURN server connectivity (called on join, results shown in debug panel)
async function testTurnServer() {
	console.log('[TURN] Testing TURN server connectivity...');
	const startTime = performance.now();

	const pc = new RTCPeerConnection(getRtcConfig());

	return new Promise((resolve) => {
		const candidates = [];
		let hasRelay = false;
		let firstCandidateTime = null;
		let relayCandidateTime = null;
		let resolved = false;

		function finish(timedOut = false) {
			if (resolved) return;
			resolved = true;
			const totalTime = Math.round(performance.now() - startTime);
			try { pc.close(); } catch (e) {}
			const result = {
				success: hasRelay,
				candidateCount: candidates.length,
				hasRelay,
				candidates,
				totalTime,
				firstCandidateTime,
				relayCandidateTime,
				timedOut
			};
			turnTestResult = result;
			if (hasRelay) {
				console.log(`[TURN] Test passed: relay in ${relayCandidateTime}ms, ${candidates.length} candidates`);
			} else if (timedOut) {
				console.error('[TURN] Test timed out with no relay candidates — TURN server may be unreachable');
			} else {
				console.error('[TURN] Test complete but no relay candidates found');
			}
			resolve(result);
		}

		pc.onicecandidate = (e) => {
			if (resolved) return;
			if (e.candidate) {
				const elapsed = Math.round(performance.now() - startTime);
				if (!firstCandidateTime) firstCandidateTime = elapsed;
				candidates.push({
					type: e.candidate.type,
					protocol: e.candidate.protocol,
					address: e.candidate.address,
					time: elapsed
				});
				console.log(`[TURN] Candidate: ${e.candidate.type} ${e.candidate.protocol} ${e.candidate.address} (${elapsed}ms)`);
				if (e.candidate.type === 'relay') {
					hasRelay = true;
					if (!relayCandidateTime) relayCandidateTime = elapsed;
					// Relay found — we're done, no need to wait for gathering to complete
					finish();
				}
			} else {
				// Gathering complete
				finish();
			}
		};

		// Create dummy data channel to trigger ICE gathering
		pc.createDataChannel('test');
		pc.createOffer()
			.then(offer => pc.setLocalDescription(offer))
			.catch(err => {
				console.error('[TURN] Test failed:', err?.message || err);
				if (!resolved) {
					resolved = true;
					try { pc.close(); } catch (e) {}
					const result = { success: false, error: err.message, totalTime: Math.round(performance.now() - startTime) };
					turnTestResult = result;
					resolve(result);
				}
			});

		// Timeout after 5 seconds if no relay found
		setTimeout(() => {
			if (!resolved) finish(true);
		}, 5000);
	});
}
