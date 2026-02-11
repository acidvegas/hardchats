// HardChats - Settings Modal & Device Management
// Requires: state, $, send from state.js
// Requires: setupLocalAudioAnalyser from webrtc.js (at runtime)
// Requires: updateUI from ui.js (at runtime)
// Requires: syncNotificationPermission, requestNotificationPermission from notifications.js (at runtime)

// ========== LOCAL STORAGE ==========

// Load settings from localStorage
function loadSettings() {
	try {
		const saved = localStorage.getItem('hardchats_settings');
		if (saved) {
			const parsed = JSON.parse(saved);
			Object.assign(state.settings, parsed);
		}
	} catch (e) {
		console.error('[Settings] Failed to load:', e);
	}
}

// Save settings to localStorage
function saveSettings() {
	try {
		localStorage.setItem('hardchats_settings', JSON.stringify(state.settings));
	} catch (e) {
		console.error('[Settings] Failed to save:', e);
	}
}

// Load saved username from localStorage
function loadSavedUsername() {
	try {
		const saved = localStorage.getItem('hardchats_username');
		if (saved) {
			$('username').value = saved;
		}
	} catch (e) {
		console.error('[Settings] Failed to load username:', e);
	}
}

// Save username to localStorage
function saveUsername(username) {
	try {
		localStorage.setItem('hardchats_username', username);
	} catch (e) {
		console.error('[Settings] Failed to save username:', e);
	}
}

// Load saved device preferences
function loadSavedDevices() {
	try {
		const saved = localStorage.getItem('hardchats_devices');
		if (saved) {
			return JSON.parse(saved);
		}
	} catch (e) {
		console.error('[Settings] Failed to load devices:', e);
	}
	return null;
}

// Save device preferences
function saveDevices(micId, camId, speakerId) {
	try {
		localStorage.setItem('hardchats_devices', JSON.stringify({ micId, camId, speakerId }));
		// Also save speaker ID separately for easy access
		if (speakerId) {
			localStorage.setItem('hardchats_speaker_id', speakerId);
		}
	} catch (e) {
		console.error('[Settings] Failed to save devices:', e);
	}
}

// Apply speaker device to all audio/video elements
async function applySpeakerDevice(deviceId) {
	if (!deviceId) return;
	
	// Find all audio and video elements that play remote audio
	const mediaElements = document.querySelectorAll('audio, video');
	for (const el of mediaElements) {
		if (typeof el.setSinkId === 'function') {
			try {
				await el.setSinkId(deviceId);
				console.log('[Settings] Applied speaker device to element');
			} catch (e) {
				console.error('[Settings] Failed to set sink ID:', e);
			}
		}
	}
}

// ========== SETTINGS MODAL ==========

let settingsPreviewStream = null;
let selectedMicId = null;
let selectedCamId = null;
let selectedSpeakerId = null;
let settingsMicAnalyser = null;
let settingsMicAnimationFrame = null;

window.openSettings = async function (event) {
	event.stopPropagation();

	const modal = $('settings-modal');
	const micSelect = $('mic-select');
	const camSelect = $('cam-select');
	const speakerSelect = $('speaker-select');

	// Update toggle states from saved settings
	updateSettingsToggles();

	// Get current device IDs
	const currentAudioTrack = state.localStream?.getAudioTracks()[0];
	const currentVideoTrack = state.localStream?.getVideoTracks()[0];

	selectedMicId = currentAudioTrack?.getSettings()?.deviceId || localStorage.getItem('hardchats_mic_id') || null;
	selectedCamId = currentVideoTrack?.getSettings()?.deviceId || localStorage.getItem('hardchats_cam_id') || null;
	selectedSpeakerId = localStorage.getItem('hardchats_speaker_id') || null;

	// Enumerate devices
	try {
		const devices = await navigator.mediaDevices.enumerateDevices();

		// Populate microphone select
		micSelect.innerHTML = '';
		const audioInputDevices = devices.filter(d => d.kind === 'audioinput');
		audioInputDevices.forEach(device => {
			const option = document.createElement('option');
			option.value = device.deviceId;
			option.textContent = device.label || `Microphone ${micSelect.options.length + 1}`;
			if (device.deviceId === selectedMicId) option.selected = true;
			micSelect.appendChild(option);
		});

		// Populate speaker select
		if (speakerSelect) {
			speakerSelect.innerHTML = '';
			const audioOutputDevices = devices.filter(d => d.kind === 'audiooutput');
			if (audioOutputDevices.length === 0) {
				const option = document.createElement('option');
				option.value = '';
				option.textContent = 'Default Speaker';
				speakerSelect.appendChild(option);
			} else {
				audioOutputDevices.forEach(device => {
					const option = document.createElement('option');
					option.value = device.deviceId;
					option.textContent = device.label || `Speaker ${speakerSelect.options.length + 1}`;
					if (device.deviceId === selectedSpeakerId) option.selected = true;
					speakerSelect.appendChild(option);
				});
			}
		}

		// Populate camera select
		camSelect.innerHTML = '<option value="">No camera</option>';
		const videoDevices = devices.filter(d => d.kind === 'videoinput');
		videoDevices.forEach(device => {
			const option = document.createElement('option');
			option.value = device.deviceId;
			option.textContent = device.label || `Camera ${camSelect.options.length}`;
			if (device.deviceId === selectedCamId) option.selected = true;
			camSelect.appendChild(option);
		});

		// Update preview when camera selection changes
		camSelect.onchange = () => updateSettingsPreview();
		
		// Update mic level meter when mic selection changes
		micSelect.onchange = () => startMicLevelMeter(micSelect.value);

		// Show preview for current camera
		await updateSettingsPreview();
		
		// Start mic level meter
		startMicLevelMeter(micSelect.value);

	} catch (e) {
		console.error('[Settings] Failed to enumerate devices:', e);
	}

	modal.classList.remove('hidden');
};

function startMicLevelMeter(deviceId) {
	// Stop existing
	stopMicLevelMeter();
	
	if (!deviceId) return;
	
	navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: deviceId } } })
		.then(stream => {
			const audioContext = new (window.AudioContext || window.webkitAudioContext)();
			const source = audioContext.createMediaStreamSource(stream);
			const analyser = audioContext.createAnalyser();
			analyser.fftSize = 256;
			source.connect(analyser);
			
			settingsMicAnalyser = { stream, audioContext, analyser };
			
			const dataArray = new Uint8Array(analyser.frequencyBinCount);
			const levelFill = $('mic-level-fill');
			
			function updateLevel() {
				if (!settingsMicAnalyser) return;
				
				analyser.getByteFrequencyData(dataArray);
				const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
				const level = Math.min(100, (avg / 128) * 100);
				
				levelFill.style.width = level + '%';
				levelFill.classList.toggle('high', level > 80);
				
				settingsMicAnimationFrame = requestAnimationFrame(updateLevel);
			}
			
			updateLevel();
		})
		.catch(e => {
			console.error('[Settings] Failed to start mic level meter:', e);
		});
}

function stopMicLevelMeter() {
	if (settingsMicAnimationFrame) {
		cancelAnimationFrame(settingsMicAnimationFrame);
		settingsMicAnimationFrame = null;
	}
	if (settingsMicAnalyser) {
		settingsMicAnalyser.stream.getTracks().forEach(t => t.stop());
		settingsMicAnalyser.audioContext.close();
		settingsMicAnalyser = null;
	}
	const levelFill = $('mic-level-fill');
	if (levelFill) levelFill.style.width = '0%';
}

async function updateSettingsPreview() {
	const camSelect = $('cam-select');
	const previewVideo = $('settings-preview-video');
	const placeholder = $('settings-preview-placeholder');

	// Stop existing preview stream
	if (settingsPreviewStream) {
		settingsPreviewStream.getTracks().forEach(t => t.stop());
		settingsPreviewStream = null;
	}

	const deviceId = camSelect.value;

	if (!deviceId) {
		previewVideo.classList.add('hidden');
		placeholder.classList.remove('hidden');
		placeholder.textContent = 'No camera selected';
		return;
	}

	try {
		settingsPreviewStream = await navigator.mediaDevices.getUserMedia({
			video: { deviceId: { exact: deviceId }, width: { ideal: 640 }, height: { ideal: 360 } }
		});

		previewVideo.srcObject = settingsPreviewStream;
		previewVideo.classList.remove('hidden');
		placeholder.classList.add('hidden');

	} catch (e) {
		console.error('[Settings] Preview failed:', e);
		previewVideo.classList.add('hidden');
		placeholder.classList.remove('hidden');
		placeholder.textContent = 'Camera unavailable';
	}
}

function closeSettings() {
	const modal = $('settings-modal');
	modal.classList.add('hidden');

	// Stop preview stream
	if (settingsPreviewStream) {
		settingsPreviewStream.getTracks().forEach(t => t.stop());
		settingsPreviewStream = null;
	}
	
	// Stop mic level meter
	stopMicLevelMeter();
}

async function applySettings() {
	const micSelect = $('mic-select');
	const camSelect = $('cam-select');

	const newMicId = micSelect.value;
	const newCamId = camSelect.value;

	// Switch microphone if changed
	if (newMicId && newMicId !== selectedMicId) {
		try {
			const newAudioStream = await navigator.mediaDevices.getUserMedia({
				audio: { deviceId: { exact: newMicId } }
			});
			const newAudioTrack = newAudioStream.getAudioTracks()[0];

			// Replace in local stream
			const oldAudioTrack = state.localStream.getAudioTracks()[0];
			if (oldAudioTrack) {
				oldAudioTrack.stop();
				state.localStream.removeTrack(oldAudioTrack);
			}
			state.localStream.addTrack(newAudioTrack);

			// Apply mute state
			newAudioTrack.enabled = state.micEnabled;

			// Replace in all peer connections
			for (const peer of Object.values(state.peers)) {
				const sender = peer.pc.getSenders().find(s => s.track && s.track.kind === 'audio');
				if (sender) {
					await sender.replaceTrack(newAudioTrack);
				}
			}

			// Recreate local audio analyser
			if (state.localAudioContext) {
				state.localAudioContext.close();
			}
			setupLocalAudioAnalyser();

			console.log('[Settings] Microphone switched');
		} catch (e) {
			console.error('[Settings] Failed to switch microphone:', e);
			alert('Failed to switch microphone: ' + e.message);
		}
	}

	// Switch camera if changed
	const currentVideoTrack = state.localStream?.getVideoTracks()[0];
	const currentCamId = currentVideoTrack?.getSettings()?.deviceId || '';

	if (newCamId !== currentCamId) {
		if (newCamId) {
			// Want camera on with new device
			try {
				// Stop old video track if any
				if (currentVideoTrack) {
					currentVideoTrack.stop();
					state.localStream.removeTrack(currentVideoTrack);
				}

				const constraints = getVideoConstraints();
				constraints.deviceId = { exact: newCamId };
				const newVideoStream = await navigator.mediaDevices.getUserMedia({
					video: constraints
				});
				const newVideoTrack = newVideoStream.getVideoTracks()[0];
				state.localStream.addTrack(newVideoTrack);

				// Replace or add in all peer connections
				for (const [peerId, peer] of Object.entries(state.peers)) {
					const sender = peer.pc.getSenders().find(s => s.track && s.track.kind === 'video');
					if (sender) {
						await sender.replaceTrack(newVideoTrack);
					} else {
						peer.pc.addTrack(newVideoTrack, state.localStream);
						// Renegotiate
						const offer = await peer.pc.createOffer();
						await peer.pc.setLocalDescription(offer);
						send({ type: 'offer', target: peerId, sdp: offer.sdp });
					}
				}

				if (!state.camEnabled) {
					state.camEnabled = true;
					state.users['local'].camOn = true;
					send({ type: 'camera_status', enabled: true });
					$('cam-btn').classList.add('active');
				}

				console.log('[Settings] Camera switched');
			} catch (e) {
				console.error('[Settings] Failed to switch camera:', e);
				alert('Failed to switch camera: ' + e.message);
			}
		} else if (currentVideoTrack) {
			// Want camera off
			currentVideoTrack.stop();
			state.localStream.removeTrack(currentVideoTrack);

			for (const [peerId, peer] of Object.entries(state.peers)) {
				const sender = peer.pc.getSenders().find(s => s.track && s.track.kind === 'video');
				if (sender) {
					peer.pc.removeTrack(sender);
					// Renegotiate
					const offer = await peer.pc.createOffer();
					await peer.pc.setLocalDescription(offer);
					send({ type: 'offer', target: peerId, sdp: offer.sdp });
				}
			}

			state.camEnabled = false;
			state.users['local'].camOn = false;
			send({ type: 'camera_status', enabled: false });
			$('cam-btn').classList.remove('active');
		}
	}

	// Save device preferences to localStorage
	const finalMicId = $('mic-select').value;
	const finalCamId = $('cam-select').value;
	const finalSpeakerId = $('speaker-select')?.value || '';
	saveDevices(finalMicId, finalCamId, finalSpeakerId);
	
	// Apply speaker device
	if (finalSpeakerId) {
		applySpeakerDevice(finalSpeakerId);
	}

	updateUI();
	closeSettings();
}

// Update settings toggle UI
function updateSettingsToggles() {
	// Sync with browser permission first
	syncNotificationPermission();

	const notifToggle = $('toggle-notifications');
	const soundToggle = $('toggle-sounds');
	const lowBwToggle = $('toggle-lowbandwidth');

	if (notifToggle) notifToggle.dataset.enabled = state.settings.notifications;
	if (soundToggle) soundToggle.dataset.enabled = state.settings.sounds;
	if (lowBwToggle) lowBwToggle.dataset.enabled = state.settings.lowBandwidth;
}

// Toggle button click handler
function handleToggleClick(toggleId, settingKey) {
	const toggle = $(toggleId);
	if (!toggle) return;

	const newValue = toggle.dataset.enabled !== 'true';

	// Request notification permission if enabling notifications
	if (settingKey === 'notifications' && newValue) {
		requestNotificationPermission().then(granted => {
			toggle.dataset.enabled = granted;
			state.settings.notifications = granted;
			saveSettings();
		});
		return;
	}

	toggle.dataset.enabled = newValue;
	state.settings[settingKey] = newValue;
	saveSettings();
}

// Get video constraints based on low bandwidth mode
function getVideoConstraints() {
	if (state.settings.lowBandwidth) {
		return {
			width: { ideal: 640 },
			height: { ideal: 360 },
			frameRate: { ideal: 15, max: 15 }
		};
	}
	return {
		width: { ideal: 1280 },
		height: { ideal: 720 }
	};
}

// Settings modal event listeners
document.addEventListener('DOMContentLoaded', () => {
	$('settings-close')?.addEventListener('click', closeSettings);
	$('settings-apply')?.addEventListener('click', applySettings);

	// Toggle button listeners
	$('toggle-notifications')?.addEventListener('click', () => handleToggleClick('toggle-notifications', 'notifications'));
	$('toggle-sounds')?.addEventListener('click', () => handleToggleClick('toggle-sounds', 'sounds'));
	$('toggle-lowbandwidth')?.addEventListener('click', () => handleToggleClick('toggle-lowbandwidth', 'lowBandwidth'));

	// Close modal when clicking outside
	$('settings-modal')?.addEventListener('click', (e) => {
		if (e.target.id === 'settings-modal') closeSettings();
	});
});

