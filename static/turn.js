// HardChats TURN/STUN Server Configuration
// Config is loaded from /api/config

let TURN_CONFIG = null;

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
	return [
		{ urls: TURN_CONFIG.stun.urls },
		{
			urls: `turns:${TURN_CONFIG.turn.host}:${TURN_CONFIG.turn.port}`,
			username: TURN_CONFIG.turn.username,
			credential: TURN_CONFIG.turn.credential
		},
		{
			urls: `turns:${TURN_CONFIG.turn.host}:${TURN_CONFIG.turn.port}?transport=tcp`,
			username: TURN_CONFIG.turn.username,
			credential: TURN_CONFIG.turn.credential
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
		iceTransportPolicy: TURN_CONFIG.iceTransportPolicy
	};
}

// Test TURN server connectivity (for debugging)
async function testTurnServer() {
	console.log('[TURN] Testing TURN server connectivity...');

	const pc = new RTCPeerConnection(getRtcConfig());

	return new Promise((resolve) => {
		const candidates = [];
		let hasRelay = false;

		pc.onicecandidate = (e) => {
			if (e.candidate) {
				candidates.push(e.candidate);
				console.log('[TURN] Candidate:', e.candidate.type, e.candidate.address);
				if (e.candidate.type === 'relay') {
					hasRelay = true;
				}
			} else {
				// Gathering complete
				pc.close();
				console.log('[TURN] Total candidates:', candidates.length);
				console.log('[TURN] Has relay candidate:', hasRelay);
				resolve({
					success: hasRelay,
					candidates: candidates.length,
					hasRelay
				});
			}
		};

		pc.onicegatheringstatechange = () => {
			console.log('[TURN] ICE gathering state:', pc.iceGatheringState);
		};

		// Create dummy data channel to trigger ICE gathering
		pc.createDataChannel('test');
		pc.createOffer()
			.then(offer => pc.setLocalDescription(offer))
			.catch(err => {
				console.error('[TURN] Test failed:', err);
				pc.close();
				resolve({ success: false, error: err.message });
			});

		// Timeout after 10 seconds
		setTimeout(() => {
			if (pc.iceGatheringState !== 'complete') {
				console.log('[TURN] Test timed out');
				pc.close();
				resolve({
					success: hasRelay,
					candidates: candidates.length,
					hasRelay,
					timedOut: true
				});
			}
		}, 10000);
	});
}
