// HardChats - Media Controls (Mic, Camera, Screen, Volume, DEFCON)
// Requires: state, $, send from state.js
// Requires: updateUI from ui.js
// Requires: getVideoConstraints from settings.js (at runtime)

// Camera cooldown state
let cameraCooldown = false;
let cameraCooldownTimer = null;

function toggleMic() {
	state.micEnabled = !state.micEnabled;
	state.localStream?.getAudioTracks().forEach(t => t.enabled = state.micEnabled);
	$('mic-btn').classList.toggle('active', state.micEnabled);
	$('mic-btn').classList.toggle('muted', !state.micEnabled);

	// Broadcast mic status to other users
	state.users['local'].micOn = state.micEnabled;
	console.log('[Mic] Sending mic_status:', state.micEnabled, 'WebSocket state:', state.ws?.readyState);
	send({ type: 'mic_status', enabled: state.micEnabled });
	updateUI();
}

async function toggleCam() {
	// Check for cooldown when trying to turn ON camera
	if (!state.camEnabled && cameraCooldown) {
		console.log('[Camera] Cooldown active, please wait');
		return;
	}

	if (!state.camEnabled) {
		try {
			const videoStream = await navigator.mediaDevices.getUserMedia({
				video: getVideoConstraints()
			});
			const videoTrack = videoStream.getVideoTracks()[0];
			state.localStream.addTrack(videoTrack);

			for (const [peerId, peer] of Object.entries(state.peers)) {
				peer.pc.addTrack(videoTrack, state.localStream);
				await sendOffer(peerId);
			}

			state.camEnabled = true;
			state.users['local'].camOn = true;
			send({ type: 'camera_status', enabled: true });

		} catch (err) {
			console.error('Camera error:', err);
			alert('Could not access camera: ' + err.message);
			return;
		}
	} else {
		// Stop and remove video tracks
		state.localStream.getVideoTracks().forEach(track => {
			track.stop();
			state.localStream.removeTrack(track);
		});

		// Remove video senders and renegotiate with each peer
		for (const [peerId, peer] of Object.entries(state.peers)) {
			const videoSenders = peer.pc.getSenders().filter(s => s.track && s.track.kind === 'video');
			videoSenders.forEach(sender => peer.pc.removeTrack(sender));
			await sendOffer(peerId);
		}

		state.camEnabled = false;
		state.users['local'].camOn = false;
		send({ type: 'camera_status', enabled: false });

		if (state.maximizedPeer === 'local') state.maximizedPeer = null;

		// Start 5 second cooldown after turning camera off
		cameraCooldown = true;
		$('cam-btn').classList.add('cooldown');
		let cooldownSeconds = 5;
		$('cam-btn').setAttribute('data-cooldown', cooldownSeconds);

		cameraCooldownTimer = setInterval(() => {
			cooldownSeconds--;
			if (cooldownSeconds <= 0) {
				clearInterval(cameraCooldownTimer);
				cameraCooldown = false;
				$('cam-btn').classList.remove('cooldown');
				$('cam-btn').removeAttribute('data-cooldown');
			} else {
				$('cam-btn').setAttribute('data-cooldown', cooldownSeconds);
			}
		}, 1000);
	}

	$('cam-btn').classList.toggle('active', state.camEnabled);
	updateUI();
}

async function toggleScreen() {
	if (!state.screenEnabled) {
		try {
			// Request screen capture
			state.screenStream = await navigator.mediaDevices.getDisplayMedia({
				video: {
					cursor: 'always',
					displaySurface: 'monitor'
				},
				audio: false
			});

			const screenTrack = state.screenStream.getVideoTracks()[0];

			// Handle user stopping share via browser UI
			screenTrack.onended = () => {
				if (state.screenEnabled) {
					toggleScreen(); // Turn off screen share
				}
			};

			// Add screen track to all peer connections, save sender reference
			for (const [peerId, peer] of Object.entries(state.peers)) {
				if (!peer.pc || peer.pc.connectionState === 'closed') continue;
				peer.screenSender = peer.pc.addTrack(screenTrack, state.screenStream);
				await sendOffer(peerId);
			}

			state.screenEnabled = true;
			state.users['local'].screenOn = true;
			send({ type: 'screen_status', enabled: true });

		} catch (err) {
			console.error('Screen share error:', err);
			// User cancelled or error - don't show alert for user cancellation
			if (err.name !== 'NotAllowedError') {
				alert('Could not share screen: ' + err.message);
			}
			return;
		}
	} else {
		// Stop screen share
		if (state.screenStream) {
			// Remove screen senders from peer connections BEFORE stopping tracks
			for (const [peerId, peer] of Object.entries(state.peers)) {
				if (!peer.pc || peer.pc.connectionState === 'closed') continue;
				if (peer.screenSender) {
					try {
						peer.pc.removeTrack(peer.screenSender);
					} catch (e) {
						console.warn(`[Screen] Failed to remove screen sender for ${peerId}:`, e);
					}
					peer.screenSender = null;
				}

				await sendOffer(peerId);
			}

			// Now stop the tracks after they've been removed from connections
			state.screenStream.getTracks().forEach(track => track.stop());
			state.screenStream = null;
		}

		state.screenEnabled = false;
		state.users['local'].screenOn = false;
		send({ type: 'screen_status', enabled: false });
	}

	$('screen-btn').classList.toggle('active', state.screenEnabled);
	updateUI();
}

function toggleVolume() {
	state.volumeEnabled = !state.volumeEnabled;

	// Nudge the shared context (may have been backgrounded).
	if (state.audioCtx && state.audioCtx.state === 'suspended') {
		state.audioCtx.resume().catch(() => {});
	}

	// Global mute now lives on the <audio> elements - independent of per-peer gain so
	// unmuting restores each user's volume slider value instantly.
	Object.values(state.peers).forEach(peer => {
		if (peer.audioElement) peer.audioElement.muted = !state.volumeEnabled;
	});

	$('volume-btn').classList.toggle('active', state.volumeEnabled);
	$('volume-btn').classList.toggle('muted', !state.volumeEnabled);

	console.log(`[Audio] Global volume ${state.volumeEnabled ? 'enabled' : 'muted'}`);
}

function toggleDefcon() {
	state.defconMode = !state.defconMode;
	$('defcon-btn').classList.toggle('active', state.defconMode);

	console.log(`[DEFCON] Mode ${state.defconMode ? 'ENABLED - new users will be muted and video hidden' : 'disabled'}`);
}

