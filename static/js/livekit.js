// HardChats - LiveKit SFU Transport (publishing, subscriptions, remote track mapping)
// Requires: state from state.js
// Requires: LivekitClient (vendor/livekit-client.umd.js)
// Requires: e2ee, initE2EE, announceE2EE from e2ee.js
// Requires: setupPeerAudio, setupPeerScreenAudio, teardownPeerAudio from webrtc.js
// Requires: updateUI, updateUsersList from ui.js
// Requires: getOutgoingAudioTrack from audiofx.js, LOWBW_VIDEO_BITRATE from settings.js (at runtime)
//
// Every client uploads each of its tracks once to the SFU, which forwards them to the
// other participants. The app WebSocket (client.js) stays the source of truth for who is
// in the room and their mic/cam/screen state; LiveKit only carries the media. A
// participant's LiveKit identity is their server client id, so it keys straight into
// state.peers / state.users.

const CARMODE_AUDIO_BITRATE = 24000; // ~24 kbps opus - plenty for intelligible speech

const QUALITY_BARS = { excellent: 4, good: 3, poor: 1, lost: 1 };

// LiveKit always advertises its TURN/TLS listener as port 443 (it expects a TLS load
// balancer there). Ours listens on 5349 since nginx owns 443, so the advertised URL is
// rewritten before any peer connection uses it.
const TURN_TLS_PORT = 5349;
const NativeRTCPeerConnection = window.RTCPeerConnection;

function fixTurnPort(config) {
	config?.iceServers?.forEach(server => {
		server.urls = [].concat(server.urls).map(url => url.replace(/^turns:([^:?]+):443\b/, `turns:$1:${TURN_TLS_PORT}`));
	});
	return config;
}

window.RTCPeerConnection = class extends NativeRTCPeerConnection {
	constructor(config, ...rest) { super(fixTurnPort(config), ...rest); }
	setConfiguration(config) { return super.setConfiguration(fixTurnPort(config)); }
};

let livekitUrl = null;

function loadLivekitConfig(config) {
	livekitUrl = config.livekit_url;
}

// Peer record for a user known from the app WebSocket. Media fields fill in as their
// LiveKit tracks get subscribed (see attachRemoteTrack).
function ensurePeer(peerId, username) {
	if (!state.peers[peerId]) {
		// Apply DEFCON mode if enabled - auto-mute and hide video for new peers
		const applyDefcon = state.defconMode;
		state.peers[peerId] = {
			username,
			stream: new MediaStream(), // their mic + camera tracks (video tiles)
			screenStream: null,        // their screen share (video + optional audio)
			muted: applyDefcon,
			videoOff: applyDefcon,
			volume: applyDefcon ? 0 : 100,
			// Audio path fields - populated lazily by setupPeerAudio / setupPeerScreenAudio.
			audioSource: null,
			analyser: null,
			audioElement: null,
			speakingLoopActive: false,
			screenAudioElement: null,
			networkQuality: 'unknown',
			networkBars: 0
		};
	}
	return state.peers[peerId];
}

function removePeer(peerId) {
	teardownPeerAudio(peerId);
	delete state.peers[peerId];
}

// Join the media room. Runs on every 'users' message: a WebSocket reconnect hands us a
// new client id (= new identity), so any previous session is torn down first.
async function connectLivekit(token) {
	await disconnectLivekit();

	const provider = await initE2EE();
	const room = new LivekitClient.Room({
		dynacast: true,
		// Our tiles don't use track.attach(), so adaptive stream would think every video
		// is invisible and pause it.
		adaptiveStream: false,
		// We own the mic/cam/screen tracks. Without this LiveKit stops them whenever the
		// session ends (e.g. the server removes our old identity on a WebSocket reconnect).
		stopLocalTrackOnUnpublish: false,
		encryption: { keyProvider: provider, worker: new Worker('static/js/vendor/livekit-client.e2ee.worker.js') }
	});
	state.room = room;
	await room.setE2EEEnabled(true);

	const { RoomEvent } = LivekitClient;
	room
		.on(RoomEvent.TrackPublished, (pub, participant) => applySubscription(participant.identity, pub))
		.on(RoomEvent.TrackSubscribed, (track, pub, participant) => attachRemoteTrack(participant.identity, participant.name, pub, track))
		.on(RoomEvent.TrackUnsubscribed, (track, pub, participant) => detachRemoteTrack(participant.identity, pub, track))
		.on(RoomEvent.ConnectionQualityChanged, (quality, participant) => {
			const peer = state.peers[participant.identity];
			if (!peer || participant === room.localParticipant) return;
			peer.networkQuality = quality === 'lost' ? 'poor' : quality;
			peer.networkBars = QUALITY_BARS[quality] || 0;
			updateUsersList();
		})
		.on(RoomEvent.ParticipantEncryptionStatusChanged, (encrypted, participant) => {
			console.log(`[E2EE] ${participant.identity} encrypted: ${encrypted}`);
		})
		.on(RoomEvent.EncryptionError, (error, participantIdentity) => {
			console.error(`[E2EE] Encryption error${participantIdentity ? ` (${participantIdentity})` : ''}:`, error?.message || error);
		})
		.on(RoomEvent.Reconnecting, () => console.warn('[LiveKit] Reconnecting'))
		.on(RoomEvent.Reconnected, () => console.log('[LiveKit] Reconnected'))
		.on(RoomEvent.Disconnected, (reason) => console.warn('[LiveKit] Disconnected:', reason));

	await room.connect(livekitUrl, token, { autoSubscribe: false });
	if (state.room !== room) return; // superseded by a newer session while connecting
	console.log(`[LiveKit] Connected as ${room.localParticipant.identity}`);

	announceE2EE();
	applySubscriptionsAll();

	await publishMic();
	// Re-publish whatever was live in the previous session (WebSocket reconnect).
	const camTrack = state.localStream?.getVideoTracks()[0];
	if (state.camEnabled && camTrack) await publishCamera(camTrack);
	if (state.screenEnabled && state.screenStream) await publishScreen(state.screenStream);
}

async function disconnectLivekit() {
	const room = state.room;
	if (!room) return;
	state.room = null;
	state.micPub = state.camPub = state.screenPub = state.screenAudioPub = null;
	// false = leave our own MediaStreamTracks running (mic/cam survive a reconnect).
	await room.disconnect(false).catch(() => {});
}

// ========== SUBSCRIPTIONS ==========
//
// Subscriptions are manual (autoSubscribe: false) so the SFU only forwards what we want:
//  - nothing from a user until we hold their E2EE sender key (their frames would be
//    undecryptable until then)
//  - nothing from users in a different breakout state than ours (*87#)
//  - no video at all in car mode, and no video from a user whose video we've hidden

function applySubscription(peerId, pub) {
	const peer = state.peers[peerId];
	const sameRoom = !!state.users['local']?.breakout === !!state.users[peerId]?.breakout;
	const isVideo = pub.kind === LivekitClient.Track.Kind.Video;
	const want = e2ee.haveKey.has(peerId) && sameRoom && (!isVideo || (!state.settings.carMode && !peer?.videoOff));
	if (pub.isSubscribed !== want) pub.setSubscribed(want);
}

function applySubscriptionsFor(peerId) {
	const participant = state.room?.remoteParticipants.get(peerId);
	participant?.trackPublications.forEach(pub => applySubscription(peerId, pub));
}

function applySubscriptionsAll() {
	state.room?.remoteParticipants.forEach(participant => {
		participant.trackPublications.forEach(pub => applySubscription(participant.identity, pub));
	});
}

// ========== REMOTE TRACKS ==========

function replaceTracks(stream, mediaTrack) {
	stream.getTracks().filter(t => t.kind === mediaTrack.kind).forEach(t => stream.removeTrack(t));
	stream.addTrack(mediaTrack);
}

function attachRemoteTrack(peerId, username, pub, track) {
	const peer = ensurePeer(peerId, state.users[peerId]?.username || username);
	const mediaTrack = track.mediaStreamTrack;
	const { Source } = LivekitClient.Track;

	switch (pub.source) {
		case Source.Microphone:
			replaceTracks(peer.stream, mediaTrack);
			setupPeerAudio(peerId, new MediaStream([mediaTrack]));
			break;
		case Source.Camera:
			replaceTracks(peer.stream, mediaTrack);
			break;
		case Source.ScreenShare:
			peer.screenStream = peer.screenStream || new MediaStream();
			replaceTracks(peer.screenStream, mediaTrack);
			break;
		case Source.ScreenShareAudio:
			peer.screenStream = peer.screenStream || new MediaStream();
			replaceTracks(peer.screenStream, mediaTrack);
			setupPeerScreenAudio(peerId, new MediaStream([mediaTrack]));
			break;
	}
	console.log(`[LiveKit] Subscribed to ${peerId} ${pub.source} (encrypted: ${pub.isEncrypted})`);
	updateUI();
}

function detachRemoteTrack(peerId, pub, track) {
	const peer = state.peers[peerId];
	if (!peer) return;
	const mediaTrack = track.mediaStreamTrack;
	peer.stream.removeTrack(mediaTrack);
	peer.screenStream?.removeTrack(mediaTrack);
	const { Source } = LivekitClient.Track;
	if (pub.source === Source.Microphone && peer.audioElement) peer.audioElement.srcObject = null;
	if (pub.source === Source.ScreenShareAudio && peer.screenAudioElement) peer.screenAudioElement.srcObject = null;
	updateUI();
}

// ========== LOCAL PUBLISHING ==========

async function publishMic() {
	const track = getOutgoingAudioTrack();
	if (!state.room || !track) return;
	state.micPub = await state.room.localParticipant.publishTrack(track, {
		source: LivekitClient.Track.Source.Microphone,
		dtx: true,
		// Car mode caps our outgoing audio bitrate low.
		audioPreset: state.settings.carMode ? { maxBitrate: CARMODE_AUDIO_BITRATE } : undefined
	});
}

// Re-publish the mic so a changed car-mode bitrate takes effect.
async function republishMic() {
	if (!state.room) return;
	if (state.micPub?.track) await state.room.localParticipant.unpublishTrack(state.micPub.track, false);
	state.micPub = null;
	await publishMic();
}

// Point the published mic at whatever getOutgoingAudioTrack() says we should send: the
// voice-changer output when active, else the raw mic (which changes on a device switch).
function syncOutgoingAudio() {
	const target = getOutgoingAudioTrack();
	const localTrack = state.micPub?.track;
	if (!localTrack || !target || localTrack.mediaStreamTrack === target) return;
	localTrack.replaceTrack(target, true).catch(e => console.warn('[LiveKit] Mic track swap failed:', e?.message || e));
}

async function publishCamera(track) {
	if (!state.room) return;
	const lowBandwidth = state.settings.lowBandwidth;
	state.camPub = await state.room.localParticipant.publishTrack(track, {
		source: LivekitClient.Track.Source.Camera,
		simulcast: !lowBandwidth,
		videoEncoding: lowBandwidth ? { maxBitrate: LOWBW_VIDEO_BITRATE, maxFramerate: 15 } : undefined
	});
}

async function unpublishCamera() {
	if (state.room && state.camPub?.track) await state.room.localParticipant.unpublishTrack(state.camPub.track, false);
	state.camPub = null;
}

// Swap the camera feed in place (device switch / flip), publishing it if it isn't yet.
async function replaceCamera(track) {
	if (state.camPub?.track) await state.camPub.track.replaceTrack(track, true);
	else await publishCamera(track);
}

// Re-publish the camera so a changed low-bandwidth setting takes effect.
async function republishCamera() {
	const track = state.camPub?.track?.mediaStreamTrack;
	if (!track) return;
	await unpublishCamera();
	await publishCamera(track);
}

async function publishScreen(stream) {
	if (!state.room) return;
	const { Source } = LivekitClient.Track;
	const videoTrack = stream.getVideoTracks()[0];
	const audioTrack = stream.getAudioTracks()[0];
	state.screenPub = await state.room.localParticipant.publishTrack(videoTrack, { source: Source.ScreenShare, simulcast: false });
	if (audioTrack) state.screenAudioPub = await state.room.localParticipant.publishTrack(audioTrack, { source: Source.ScreenShareAudio, dtx: false });
}

async function unpublishScreen() {
	for (const pub of [state.screenPub, state.screenAudioPub]) {
		if (state.room && pub?.track) await state.room.localParticipant.unpublishTrack(pub.track, false);
	}
	state.screenPub = state.screenAudioPub = null;
}
