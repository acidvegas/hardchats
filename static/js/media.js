// HardChats - Media Controls (Mic, Camera, Screen, Volume, DEFCON)
// Requires: state, $, send from state.js
// Requires: updateUI from ui.js
// Requires: publishCamera, unpublishCamera, replaceCamera, publishScreen, unpublishScreen from livekit.js
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
	if (typeof updateMediaSessionState === 'function') updateMediaSessionState();

	// Re-apply breakout gating - the per-sender track flips above might not match
	// breakout state (we may have just enabled the local audio track for peers we
	// shouldn't be transmitting to).
	if (typeof applyBreakoutGatingAll === 'function') applyBreakoutGatingAll();

	updateUI();
}

async function toggleCam() {
	// Check for cooldown when trying to turn ON camera
	if (!state.camEnabled && cameraCooldown) {
		console.log('[Camera] Cooldown active, please wait');
		return;
	}

	// Breakout room is voice-only - block enabling cam.
	if (!state.camEnabled && state.users['local']?.breakout) {
		console.log('[Camera] Disabled in breakout room');
		return;
	}

	if (!state.camEnabled) {
		try {
			const videoStream = await navigator.mediaDevices.getUserMedia({
				video: { ...getVideoConstraints(), facingMode: { ideal: state.facingMode || 'user' } }
			});
			const videoTrack = videoStream.getVideoTracks()[0];
			state.localStream.addTrack(videoTrack);
			await publishCamera(videoTrack);

			state.camEnabled = true;
			state.users['local'].camOn = true;
			send({ type: 'camera_status', enabled: true });

		} catch (err) {
			console.error('Camera error:', err);
			alert('Could not access camera: ' + err.message);
			return;
		}
	} else {
		// Unpublish the camera (never the screen share), then stop and remove video tracks
		await unpublishCamera();
		state.localStream.getVideoTracks().forEach(track => {
			track.stop();
			state.localStream.removeTrack(track);
		});

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
	if (typeof updateMediaSessionState === 'function') updateMediaSessionState();
	// Flip-camera button is only useful when the camera is on (mobile shows it via CSS).
	$('flip-cam-btn')?.classList.toggle('hidden', !state.camEnabled);
	updateUI();
}

// Acquire a camera track for the given facing and wire it into the local stream + the
// published camera. Removes any leftover camera track first (screen-share lives on a
// separate stream, so it's untouched).
async function swapCameraTrack(facing) {
	const stream = await navigator.mediaDevices.getUserMedia({
		video: { ...getVideoConstraints(), facingMode: { ideal: facing } }
	});
	const track = stream.getVideoTracks()[0];

	state.localStream.getVideoTracks().forEach(t => {
		t.stop();
		state.localStream.removeTrack(t);
	});
	state.localStream.addTrack(track);
	await replaceCamera(track);
}

// Mobile flip-camera button: switch between front ('user') and back ('environment').
// The button is only shown while the camera is on (see toggleCam), so there's always a
// camera to flip.
async function flipCamera() {
	if (!state.camEnabled) return;

	const prev = state.facingMode;
	const next = (prev === 'environment') ? 'user' : 'environment';

	// Release the current camera BEFORE opening the other one - many phones can't hold
	// both cameras at once, which would make getUserMedia throw and the flip silently fail.
	state.localStream.getVideoTracks().forEach(t => {
		t.stop();
		state.localStream.removeTrack(t);
	});

	try {
		state.facingMode = next;
		await swapCameraTrack(next);
		console.log('[Camera] Flipped to', next);
	} catch (e) {
		console.error('[Camera] Flip failed, restoring previous camera:', e);
		state.facingMode = prev;
		try { await swapCameraTrack(prev); } catch (e2) { console.error('[Camera] Restore failed:', e2); }
	}

	updateVideoGrid();
}

async function toggleScreen() {
	// Breakout room is voice-only - block enabling screen share.
	if (!state.screenEnabled && state.users['local']?.breakout) {
		console.log('[Screen] Disabled in breakout room');
		return;
	}

	if (!state.screenEnabled) {
		try {
			// Request screen capture
			state.screenStream = await navigator.mediaDevices.getDisplayMedia({
				video: {
					cursor: 'always',
					displaySurface: 'monitor'
				},
				// Tab/system audio is offered by the browser's share picker (Chromium only);
				// if the user ticks it we get an audio track, toggled via screen-audio-btn.
				audio: true
			});

			const screenTrack = state.screenStream.getVideoTracks()[0];
			const screenAudioTrack = state.screenStream.getAudioTracks()[0] || null;
			state.screenAudioEnabled = !!screenAudioTrack;

			// Handle user stopping share via browser UI
			screenTrack.onended = () => {
				if (state.screenEnabled) {
					toggleScreen(); // Turn off screen share
				}
			};

			await publishScreen(state.screenStream);

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
			// Unpublish the screen tracks BEFORE stopping them
			try {
				await unpublishScreen();
			} catch (e) {
				console.warn('[Screen] Failed to unpublish screen share:', e);
			}

			// Now stop the tracks after they've been unpublished
			state.screenStream.getTracks().forEach(track => track.stop());
			state.screenStream = null;
		}

		state.screenEnabled = false;
		state.users['local'].screenOn = false;
		send({ type: 'screen_status', enabled: false });
	}

	$('screen-btn').classList.toggle('active', state.screenEnabled);
	updateScreenAudioBtn();
	updateUI();
}

// Mute/unmute the shared tab/system audio while screen sharing. track.enabled=false
// sends silence on the same sender, so no renegotiation is needed.
function toggleScreenAudio() {
	const track = state.screenStream?.getAudioTracks()[0];
	if (!track) return;
	state.screenAudioEnabled = !state.screenAudioEnabled;
	track.enabled = state.screenAudioEnabled;
	updateScreenAudioBtn();
}

// The screen-audio button only exists while sharing a screen that has an audio track.
function updateScreenAudioBtn() {
	const hasAudio = !!(state.screenEnabled && state.screenStream?.getAudioTracks().length);
	$('screen-audio-btn').classList.toggle('hidden', !hasAudio);
	$('screen-audio-btn').classList.toggle('active', hasAudio && state.screenAudioEnabled);
	$('screen-audio-btn').classList.toggle('muted', hasAudio && !state.screenAudioEnabled);
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
		if (peer.screenAudioElement) peer.screenAudioElement.muted = !state.volumeEnabled;
	});

	// Don't undo breakout-room muting when global unmute is hit.
	if (typeof applyBreakoutGatingAll === 'function') applyBreakoutGatingAll();

	$('volume-btn').classList.toggle('active', state.volumeEnabled);
	$('volume-btn').classList.toggle('muted', !state.volumeEnabled);

	console.log(`[Audio] Global volume ${state.volumeEnabled ? 'enabled' : 'muted'}`);
}

function toggleDefcon() {
	state.defconMode = !state.defconMode;
	$('defcon-btn').classList.toggle('active', state.defconMode);

	console.log(`[DEFCON] Mode ${state.defconMode ? 'ENABLED - new users will be muted and video hidden' : 'disabled'}`);
}

