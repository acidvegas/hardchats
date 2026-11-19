// HardChats - Debug Panel & Logging
// Requires: state, $, escapeHtml from state.js
// Requires: livekitUrl from livekit.js, e2ee from e2ee.js (at runtime)

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

// Set from /api/config (diag_logs): mirror every debug log line to the server log
let diagLogs = false;

function addDebugLog(level, message) {
	if (diagLogs) send({ type: 'diag', line: `${level} ${message}` });
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
		const room = state.room;
		connInfo.innerHTML = `My ID: ${state.myId || 'N/A'}
Username: ${state.username || 'N/A'}
WebSocket: ${wsState}
WS Reconnect Attempts: ${state.wsReconnectAttempts}
Reconnect Token: ${state.reconnectToken ? 'Yes' : 'No'}
LiveKit: ${room?.state || 'N/A'} (${livekitUrl || 'N/A'})
E2EE: ${room?.isE2EEEnabled ? `enabled, sending with key #${e2ee.keyIndex}` : 'disabled'}
Mic Enabled: ${state.micEnabled}
Cam Enabled: ${state.camEnabled}
Screen Enabled: ${state.screenEnabled}
DEFCON Mode: ${state.defconMode}
Connected Peers: ${Object.keys(state.peers).length}`;
	}
	
	// Peers info - media room presence, subscriptions and encryption per track
	const peersInfo = $('debug-peers-info');
	if (peersInfo) {
		const peerDetailsPromises = Object.entries(state.peers).map(async ([id, peer]) => {
			const user = state.users[id];
			const participant = state.room?.remoteParticipants.get(id);
			const tracks = participant ? [...participant.trackPublications.values()].map(pub =>
				`${pub.source}${pub.isSubscribed ? ' (subscribed)' : ''}${pub.isEncrypted ? ' [encrypted]' : ' [NOT ENCRYPTED]'}`).join(', ') : '';

			return `${user?.username || id}:
  LiveKit: ${participant ? 'in media room' : 'not in media room'} | Quality: ${peer.networkQuality || 'unknown'}
  E2EE key exchanged: ${e2ee.wrapKeys.has(id) ? 'yes' : 'no'}
  Tracks: ${tracks || 'none'}
  Has Stream: ${!!peer.stream} | Audio Tracks: ${peer.stream?.getAudioTracks()?.length ?? 0}
  Mic: ${user?.micOn}, Cam: ${user?.camOn}, Screen: ${user?.screenOn}`;
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
	if (msg.includes('[WebRTC]') || msg.includes('[Signal]') || msg.includes('[Audio]') || msg.includes('[Mic]') || msg.includes('[WS]') || msg.includes('[LiveKit]') || msg.includes('[E2EE]') || msg.includes('[IRC]') || msg.includes('[Config]')) {
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

