// HardChats - Shared State & Utilities
// This file must be loaded first - provides globals used by all other modules.

const state = {
	ws: null,
	myId: null,
	username: null,
	localStream: null,
	// Shared AudioContext for the whole page. Created during the Connect button click
	// (a guaranteed user gesture) so it stays in 'running' state on mobile. Used for the
	// local mic analyser AND every peer's analyser+gain graph. AudioContext.destination is
	// NOT used for output - peer audio plays via per-peer hidden <audio> elements (see
	// setupPeerAudio in webrtc.js) for reliable mobile autoplay.
	audioCtx: null,
	// Hidden <audio> element kept playing a silent stream for the entire session. Started
	// synchronously during the Connect tap so the page's audio session is active when
	// peer audio elements get created later. Without this, mobile browsers leave new
	// audio elements silent until some other media event activates the session.
	audioPrimer: null,
	audioPrimerSource: null,
	localAnalyser: null,
	localAudioSource: null,
	screenStream: null,
	peers: {},
	users: {},
	micEnabled: true,
	camEnabled: false,
	screenEnabled: false,
	volumeEnabled: true,
	maximizedPeer: null,
	sidebarOpen: true,
	captchaId: null,
	sessionStart: null,
	maxCameras: 10,
	configLoaded: false,
	defconMode: false, // Auto-mute and hide video for new users
	trippyMode: false, // UI hue-shift animation - toggled via server-side dial codes
	// Reconnection state
	reconnectToken: null,
	wsReconnectAttempts: 0,
	wsReconnectTimer: null,
	intentionalDisconnect: false,
	timerStarted: false,
	// Settings
	settings: {
		notifications: true,
		sounds: true,
		lowBandwidth: false
	},
	// IRC state
	irc: {
		ws: null,
		connected: false,
		nick: null,
		unreadCount: 0,
		sidebarOpen: false,
		intentionalDisconnect: false
	}
};

// Buffer for ICE candidates that arrive before peer connection is ready
const pendingCandidates = {};

const USERNAME_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]{0,19}$/;

const $ = (id) => document.getElementById(id);

function escapeHtml(text) {
	const d = document.createElement('div');
	d.textContent = text;
	return d.innerHTML;
}

function send(data) {
	if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(data));
}

function validateUsername(name) {
	return USERNAME_REGEX.test(name);
}

