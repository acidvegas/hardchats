// HardChats - Debug Panel & Logging
// Requires: state, $, escapeHtml, pendingCandidates from state.js
// Requires: TURN_CONFIG, turnTestResult from turn.js (at runtime)

const debugLogs = [];
const MAX_DEBUG_LOGS = 500;
let debugModalOpen = false;
let debugUpdateInterval = null;

function toggleDebugModal() {
	if (debugModalOpen) {
		closeDebugModal();
	} else {
		openDebugModal();
	}
}

function openDebugModal() {
	debugModalOpen = true;
	$('debug-modal')?.classList.remove('hidden');
	$('debug-btn')?.classList.add('active');
	updateDebugInfo();
	// Update every second while open
	debugUpdateInterval = setInterval(updateDebugInfo, 1000);
}

function closeDebugModal() {
	debugModalOpen = false;
	$('debug-modal')?.classList.add('hidden');
	$('debug-btn')?.classList.remove('active');
	if (debugUpdateInterval) {
		clearInterval(debugUpdateInterval);
		debugUpdateInterval = null;
	}
}

function addDebugLog(level, message) {
	const timestamp = new Date().toLocaleTimeString();
	debugLogs.push({ level, message, timestamp });
	if (debugLogs.length > MAX_DEBUG_LOGS) {
		debugLogs.shift();
	}
	if (debugModalOpen) {
		renderDebugLogs();
	}
}

function renderDebugLogs() {
	const container = $('debug-logs');
	if (!container) return;
	
	container.innerHTML = debugLogs.map(log => 
		`<div class="debug-log-entry ${log.level}"><span class="debug-log-time">${log.timestamp}</span>${escapeHtml(log.message)}</div>`
	).join('');
	container.scrollTop = container.scrollHeight;
}

function clearDebugLogs() {
	debugLogs.length = 0;
	renderDebugLogs();
}

function copyDebugLogs() {
	const text = debugLogs.map(l => `[${l.timestamp}] [${l.level.toUpperCase()}] ${l.message}`).join('\n');
	navigator.clipboard.writeText(text).then(() => {
		addDebugLog('success', 'Logs copied to clipboard');
	}).catch(e => {
		addDebugLog('error', 'Failed to copy: ' + e.message);
	});
}

function updateDebugInfo() {
	// Connection info
	const connInfo = $('debug-connection-info');
	if (connInfo) {
		const wsState = ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'][state.ws?.readyState ?? 3];
		const turnHost = TURN_CONFIG?.turn?.host || 'N/A';
		const turnPort = TURN_CONFIG?.turn?.port || 'N/A';

		// TURN test status
		let turnStatus = 'Not tested';
		if (typeof turnTestResult !== 'undefined' && turnTestResult) {
			if (turnTestResult.success) {
				turnStatus = `OK (relay in ${turnTestResult.relayCandidateTime}ms, ${turnTestResult.candidateCount} candidates, total ${turnTestResult.totalTime}ms)`;
			} else if (turnTestResult.timedOut) {
				turnStatus = `TIMEOUT (${turnTestResult.candidateCount} candidates, no relay after ${turnTestResult.totalTime}ms)`;
			} else if (turnTestResult.error) {
				turnStatus = `FAILED: ${turnTestResult.error}`;
			} else {
				turnStatus = `NO RELAY (${turnTestResult.candidateCount} candidates in ${turnTestResult.totalTime}ms)`;
			}
		}

		connInfo.innerHTML = `My ID: ${state.myId || 'N/A'}
Username: ${state.username || 'N/A'}
WebSocket: ${wsState}
WS Reconnect Attempts: ${state.wsReconnectAttempts}
Reconnect Token: ${state.reconnectToken ? 'Yes' : 'No'}
TURN Server: ${turnHost}:${turnPort}
ICE Transport Policy: ${TURN_CONFIG?.iceTransportPolicy || 'N/A'}
TURN Test: ${turnStatus}
Mic Enabled: ${state.micEnabled}
Cam Enabled: ${state.camEnabled}
Screen Enabled: ${state.screenEnabled}
DEFCON Mode: ${state.defconMode}
Connected Peers: ${Object.keys(state.peers).length}`;
	}
	
	// Peers info - enhanced with ICE candidate types and route info
	const peersInfo = $('debug-peers-info');
	if (peersInfo) {
		const peerDetailsPromises = Object.entries(state.peers).map(async ([id, peer]) => {
			const iceState = peer.pc?.iceConnectionState || 'N/A';
			const iceGatherState = peer.pc?.iceGatheringState || 'N/A';
			const sigState = peer.pc?.signalingState || 'N/A';
			const connState = peer.pc?.connectionState || 'N/A';
			const user = state.users[id];

			// Get ICE candidate pair info (shows if using TURN relay, direct, etc.)
			let routeInfo = 'N/A';
			let localAddr = '', remoteAddr = '';
			try {
				if (peer.pc && (connState === 'connected' || iceState === 'connected' || iceState === 'completed')) {
					const stats = await peer.pc.getStats();
					stats.forEach(report => {
						if (report.type === 'candidate-pair' && report.state === 'succeeded') {
							let localType = '?', remoteType = '?', protocol = '?';
							stats.forEach(s => {
								if (s.id === report.localCandidateId) {
									localType = s.candidateType || '?';
									protocol = s.protocol || '?';
									localAddr = `${s.address || '?'}:${s.port || '?'}`;
								}
								if (s.id === report.remoteCandidateId) {
									remoteType = s.candidateType || '?';
									remoteAddr = `${s.address || '?'}:${s.port || '?'}`;
								}
							});
							routeInfo = `${localType} ↔ ${remoteType} (${protocol})`;
						}
					});
				}
			} catch (e) { /* stats unavailable */ }

			return `${user?.username || id} [${peer.initiator ? 'initiator' : 'responder'}]:
  Connection: ${connState}
  ICE: ${iceState} | Gathering: ${iceGatherState} | Signaling: ${sigState}
  Route: ${routeInfo}${localAddr ? `\n  Local: ${localAddr} → Remote: ${remoteAddr}` : ''}
  ICE Restarts: ${peer.iceRestartCount || 0}
  Buffered Candidates: ${pendingCandidates[id]?.length || 0}
  Has Stream: ${!!peer.stream} | Audio Tracks: ${peer.stream?.getAudioTracks()?.length ?? 0}
  Mic: ${user?.micOn}, Cam: ${user?.camOn}, Screen: ${user?.screenOn}
  RTT: ${peer.rtt ?? 'N/A'}ms, Loss: ${peer.packetLoss ?? 'N/A'}%, Jitter: ${peer.jitter ?? 'N/A'}ms`;
		});

		Promise.all(peerDetailsPromises).then(details => {
			peersInfo.textContent = details.join('\n\n') || 'No peers connected';
		});
	}
	
	// Render logs
	renderDebugLogs();
}

// Override console methods to capture WebRTC logs
const originalConsoleLog = console.log;
const originalConsoleWarn = console.warn;
const originalConsoleError = console.error;

console.log = function(...args) {
	const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
	if (msg.includes('[WebRTC]') || msg.includes('[Signal]') || msg.includes('[Audio]') || msg.includes('[Mic]') || msg.includes('[WS]') || msg.includes('[TURN]') || msg.includes('[IRC]') || msg.includes('[Config]')) {
		addDebugLog('info', msg);
	}
	originalConsoleLog.apply(console, args);
};

console.warn = function(...args) {
	const msg = args.map(a => {
		if (a instanceof Error) return `${a.name}: ${a.message}`;
		if (typeof a === 'object') return JSON.stringify(a);
		return String(a);
	}).join(' ');
	addDebugLog('warn', msg);
	originalConsoleWarn.apply(console, args);
};

console.error = function(...args) {
	const msg = args.map(a => {
		if (a instanceof Error) return `${a.name}: ${a.message}`;
		if (typeof a === 'object') return JSON.stringify(a);
		return String(a);
	}).join(' ');
	addDebugLog('error', msg);
	originalConsoleError.apply(console, args);
};

