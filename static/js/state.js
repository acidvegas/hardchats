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
	screenAudioEnabled: false, // shared tab/system audio on/off while screen sharing
	// Which camera to capture: 'user' (front, default) or 'environment' (back). Flipped
	// via the mobile flip-camera button.
	facingMode: 'user',
	volumeEnabled: true,
	maximizedPeer: null,
	sidebarOpen: true,
	captchaId: null,
	sessionStart: null,
	maxCameras: 10,
	configLoaded: false,
	defconMode: false, // Auto-mute and hide video for new users
	trippyMode: false, // UI hue-shift animation - toggled via server-side dial codes
	schizoMode: false, // Subtle UI shake/wiggle - toggled via *666#
	pongMode:   false, // Webcam tiles bounce around - toggled via *9059#
	fedFakeActive: false, // RECORD CALL prank button was pressed (locally only)
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
		lowBandwidth: false,
		// Browser-native mic noise suppression + echo cancel + auto-gain. Applied as
		// getUserMedia constraints and live via track.applyConstraints when toggled.
		noiseSuppression: true,
		// Car mode: audio-only. Hides all video/screen locally, tells peers to stop
		// sending us video, suppresses visual dial effects + their sounds, and drops
		// our outgoing audio to a low bitrate. For driving / very constrained links.
		carMode: false,
		// Mobile audio routing. true = remote audio plays through a hidden <video>
		// element, which iOS classifies as media playback (loudspeaker). false = plays
		// through <audio>, which under an active mic becomes communication category
		// (earpiece). Desktop browsers route the same regardless of element tag.
		speakerMode: true
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

// Serialized RTCRtpSender parameter updates. Chrome rejects a setParameters() when another
// getParameters()/setParameters() pair ran on the same sender in the same task (bitrate cap
// + car-mode gating both touch video senders), so each sender's updates run one at a time,
// each with a fresh getParameters(). mutate() edits encodings[0].
const senderParamQueues = new WeakMap();

function updateSenderParams(sender, mutate, tag) {
	const next = (senderParamQueues.get(sender) || Promise.resolve()).then(() => {
		const params = sender.getParameters();
		if (!params.encodings || !params.encodings.length) params.encodings = [{}];
		mutate(params.encodings[0]);
		return sender.setParameters(params);
	}).catch(e => console.warn(`[${tag}] setParameters failed:`, e?.message || e));
	senderParamQueues.set(sender, next);
	return next;
}
