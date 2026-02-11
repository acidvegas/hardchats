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
				const offer = await peer.pc.createOffer();
				await peer.pc.setLocalDescription(offer);
				send({ type: 'offer', target: peerId, sdp: offer.sdp });
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

			// Renegotiate to inform peer that video is gone
			try {
				const offer = await peer.pc.createOffer();
				await peer.pc.setLocalDescription(offer);
				send({ type: 'offer', target: peerId, sdp: offer.sdp });
			} catch (e) {
				console.error(`[WebRTC] Failed to renegotiate with ${peerId}:`, e);
			}
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
				const offer = await peer.pc.createOffer();
				await peer.pc.setLocalDescription(offer);
				send({ type: 'offer', target: peerId, sdp: offer.sdp });
			}

			// Verify audio tracks are still intact after renegotiation
			ensureAudioTrack();

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

				// Renegotiate
				try {
					const offer = await peer.pc.createOffer();
					await peer.pc.setLocalDescription(offer);
					send({ type: 'offer', target: peerId, sdp: offer.sdp });
				} catch (e) {
					console.error(`[WebRTC] Failed to renegotiate with ${peerId}:`, e);
				}
			}

			// Now stop the tracks after they've been removed from connections
			state.screenStream.getTracks().forEach(track => track.stop());
			state.screenStream = null;
		}

		// Verify audio tracks are still intact after renegotiation
		ensureAudioTrack();

		state.screenEnabled = false;
		state.users['local'].screenOn = false;
		send({ type: 'screen_status', enabled: false });
	}

	$('screen-btn').classList.toggle('active', state.screenEnabled);
	updateUI();
}

// Ensure audio track is still active and properly connected after screen share renegotiation
function ensureAudioTrack() {
	const audioTrack = state.localStream?.getAudioTracks()[0];
	if (!audioTrack) return;

	// Re-enable audio track if mic should be on
	audioTrack.enabled = state.micEnabled;

	// Verify each peer has the audio sender with the correct track
	for (const [peerId, peer] of Object.entries(state.peers)) {
		if (!peer.pc || peer.pc.connectionState === 'closed') continue;

		const audioSender = peer.pc.getSenders().find(s => s.track?.kind === 'audio');
		if (audioSender) {
			// If the sender's track doesn't match our current audio track, replace it
			if (audioSender.track !== audioTrack) {
				audioSender.replaceTrack(audioTrack).catch(e => {
					console.error(`[WebRTC] Failed to restore audio track for ${peerId}:`, e);
				});
			}
		} else {
			// No audio sender found — re-add one
			try {
				peer.pc.addTrack(audioTrack, state.localStream);
				console.warn(`[WebRTC] Re-added missing audio track for ${peerId}`);
			} catch (e) {
				console.error(`[WebRTC] Failed to re-add audio track for ${peerId}:`, e);
			}
		}
	}
	console.log('[Screen] Audio track verified after screen share toggle');
}

function toggleVolume() {
	state.volumeEnabled = !state.volumeEnabled;

	// Use GainNode for global mute/unmute
	Object.entries(state.peers).forEach(([peerId, peer]) => {
		// Resume audio context if suspended
		if (peer.audioContext && peer.audioContext.state === 'suspended') {
			peer.audioContext.resume();
		}

		if (peer.gainNode) {
			if (state.volumeEnabled) {
				// Restore to user's set volume
				peer.gainNode.gain.value = (peer.volume ?? 100) / 100;
			} else {
				// Mute
				peer.gainNode.gain.value = 0;
			}
		}
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

