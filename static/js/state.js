// HardChats - Shared State & Utilities
// This file must be loaded first - provides globals used by all other modules.

const state = {
	ws: null,
	myId: null,
	username: null,
	localStream: null,
	localAudioContext: null,
	localAnalyser: null,
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

