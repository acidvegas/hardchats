// HardChats Client - Main Entry Point, Signaling & WebSocket
// Requires: state, $, send, validateUsername, pendingCandidates from state.js
// Requires: debug.js (console overrides loaded early)
// Requires: turn.js (loadTurnConfig, getRtcConfig, testTurnServer)
// Requires: notifications.js (showNotification, playSound, requestNotificationPermission)
// Requires: settings.js (loadSettings, loadSavedUsername, saveUsername, loadSavedDevices)
// Requires: ui.js (updateUI)
// Requires: webrtc.js (createPeerConnection, handleOffer, handleAnswer, handleCandidate, setupLocalAudioAnalyser)
// Requires: media.js (toggleMic, toggleCam, toggleScreen, toggleVolume, toggleDefcon)
// Requires: irc.js (initIrcListeners, toggleIrcSidebar, disconnectIrc)

document.addEventListener('DOMContentLoaded', async () => {
	// Load saved settings
	loadSettings();

	// Load saved username
	loadSavedUsername();

	// Load configuration from server first
	await loadConfig();

	$('connect-btn').addEventListener('click', connect);
	$('username').addEventListener('keypress', (e) => e.key === 'Enter' && $('captcha-answer').focus());
	$('captcha-answer').addEventListener('keypress', (e) => e.key === 'Enter' && connect());
	$('refresh-captcha').addEventListener('click', loadCaptcha);
	$('mic-btn').addEventListener('click', toggleMic);
	$('cam-btn').addEventListener('click', toggleCam);
	$('screen-btn').addEventListener('click', toggleScreen);
	$('volume-btn').addEventListener('click', toggleVolume);
	$('users-btn').addEventListener('click', toggleSidebar);
	$('close-sidebar').addEventListener('click', toggleSidebar);
	$('sidebar-overlay').addEventListener('click', closeSidebars);

	// IRC event listeners (from irc.js)
	initIrcListeners();

	window.addEventListener('resize', () => {
		if (!state.maximizedPeer) updateVideoGrid();
	});

	// Keyboard shortcuts (ignore when typing in inputs)
	document.addEventListener('keydown', (e) => {
		// Don't trigger hotkeys when typing in input fields
		const tag = e.target.tagName.toLowerCase();
		if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;

		// Don't trigger hotkeys when modifier keys are held (allow Ctrl+C copy, etc.)
		if (e.ctrlKey || e.metaKey || e.altKey) return;

		const key = e.key.toLowerCase();
		if (key === 'm' && e.shiftKey) {
			toggleMic();
			toggleVolume();
		} else switch (key) {
			case 'm':
				toggleMic();
				break;
			case 's':
				toggleVolume();
				break;
			case 'u':
				toggleSidebar();
				break;
		}
	});

	// DEFCON mode button - support both click and touch for mobile
	const defconBtn = $('defcon-btn');
	defconBtn.addEventListener('click', toggleDefcon);
	defconBtn.addEventListener('touchend', (e) => {
		e.preventDefault();
		toggleDefcon();
	});
	
	// Debug button
	const debugBtn = $('debug-btn');
	if (debugBtn) {
		debugBtn.addEventListener('click', toggleDebugModal);
		debugBtn.addEventListener('touchend', (e) => {
			e.preventDefault();
			toggleDebugModal();
		});
	}
	
	// Debug modal close button
	$('debug-close')?.addEventListener('click', closeDebugModal);
	$('debug-clear-logs')?.addEventListener('click', clearDebugLogs);
	$('debug-copy-logs')?.addEventListener('click', copyDebugLogs);
	$('debug-modal')?.addEventListener('click', (e) => {
		if (e.target.id === 'debug-modal') closeDebugModal();
	});

	// Resizable sidebars
	initSidebarResize();

	loadCaptcha();
	loadUserCount();

	// Refresh user count every 10 seconds while on login screen
	setInterval(() => {
		if (!$('login-screen').classList.contains('hidden')) {
			loadUserCount();
		}
	}, 10000);
});

// ========== CONFIG & LOGIN ==========

async function loadConfig() {
	try {
		const res = await fetch('/api/config');
		const config = await res.json();

		// Load TURN config (from turn.js)
		loadTurnConfig(config);

		// Load IRC config (from irc.js)
		loadIrcConfig(config);

		// Store max values
		state.maxCameras = config.max_cameras;
		state.configLoaded = true;

		// Update footer with version and year
		if (config.version) {
			const footerVersion = $('footer-version');
			if (footerVersion) footerVersion.textContent = `v${config.version}`;
		}
		const footerYear = $('footer-year');
		if (footerYear) footerYear.textContent = new Date().getFullYear();

		console.log('[Config] Loaded successfully');
	} catch (e) {
		console.error('[Config] Failed to load:', e?.message || e);
	}
}

async function loadCaptcha() {
	try {
		const res = await fetch('/api/captcha');
		const data = await res.json();
		state.captchaId = data.id;
		$('captcha-question').textContent = data.question + ' = ?';
		$('captcha-answer').value = '';
	} catch (e) {
		console.error('Captcha error:', e);
	}
}

async function loadUserCount() {
	try {
		const res = await fetch('/api/users/count');
		const data = await res.json();
		const count = data.count || 0;
		const el = $('user-count-home');
		if (el) {
			if (count === 0) {
				el.textContent = 'No one is yapping yet. Be the first!';
			} else if (count === 1) {
				el.textContent = '1 person is yapping';
			} else {
				el.textContent = `${count} people are yapping`;
			}
		}
	} catch (e) {
		console.error('User count error:', e);
		const el = $('user-count-home');
		if (el) el.textContent = '';
	}
}

function showError(msg) {
	const el = $('login-error');
	el.textContent = msg;
	el.classList.remove('hidden');
	loadCaptcha();
}

// ========== CONNECTION ==========

async function connect() {
	const username = $('username').value.trim();
	const captchaAnswer = $('captcha-answer').value.trim();

	if (!username) return $('username').focus();
	if (!validateUsername(username)) {
		showError('Invalid username. Must start with a letter, 1-20 characters (letters, numbers, underscore).');
		return;
	}
	if (!captchaAnswer) return $('captcha-answer').focus();

	state.username = username;
	$('login-error').classList.add('hidden');

	try {
		// Check for saved device preferences
		const savedDevices = loadSavedDevices();
		const audioConstraints = savedDevices?.micId
			? { deviceId: { ideal: savedDevices.micId } }
			: true;

		state.localStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: false });

		// Setup local audio analyser for speaking detection
		setupLocalAudioAnalyser();

		connectWebSocket(username, state.captchaId, captchaAnswer);

	} catch (err) {
		console.error('Media error:', err);
		showError(location.protocol === 'http:' ? 'HTTPS required!' : `Microphone error: ${err.message}`);
	}
}

function connectWebSocket(username, captchaId, captchaAnswer) {
	const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
	state.ws = new WebSocket(`${protocol}//${location.host}/ws`);

	state.ws.onopen = () => {
		state.wsReconnectAttempts = 0; // Reset on successful connection

		if (state.reconnectToken) {
			// Reconnecting with token (no captcha needed)
			state.ws.send(JSON.stringify({
				type: 'reconnect',
				token: state.reconnectToken,
				username: state.username
			}));
			console.log('[WS] Reconnecting with token');
		} else {
			// Initial connection with captcha
			state.ws.send(JSON.stringify({
				type: 'join',
				username,
				captcha_id: captchaId,
				captcha_answer: captchaAnswer
			}));
		}
	};

	state.ws.onmessage = (e) => {
		const data = JSON.parse(e.data);
		if (data.type === 'mic_status' || data.type === 'screen_status') {
			console.log('[WS] Received status message:', data.type, data);
		}
		handleSignal(data);
	};

	state.ws.onclose = (e) => {
		console.log(`[WS] Disconnected (code: ${e.code}, reason: ${e.reason || 'none'})`);

		// Don't reconnect if intentional (page leave, etc.)
		if (state.intentionalDisconnect) return;

		// Don't reconnect if we don't have a reconnect token (never joined successfully)
		if (!state.reconnectToken) return;

		// Don't reconnect if we're on the login screen
		if (!$('login-screen').classList.contains('hidden')) return;

		attemptReconnect();
	};

	state.ws.onerror = (e) => console.error('[WS] Error:', e);
}

function attemptReconnect() {
	const maxAttempts = 10;
	if (state.wsReconnectAttempts >= maxAttempts) {
		console.log('[WS] Max reconnect attempts reached, giving up');
		return;
	}

	// Exponential backoff: 1s, 2s, 4s, 8s, ... capped at 30s
	const delay = Math.min(1000 * Math.pow(2, state.wsReconnectAttempts), 30000);
	state.wsReconnectAttempts++;

	console.log(`[WS] Reconnecting in ${delay / 1000}s (attempt ${state.wsReconnectAttempts}/${maxAttempts})`);

	state.wsReconnectTimer = setTimeout(() => {
		if (state.intentionalDisconnect) return;
		connectWebSocket(state.username, null, null);
	}, delay);
}

// ========== SIGNALING ==========

function handleSignal(data) {
	switch (data.type) {
		case 'error':
			showError(data.message);
			break;

		case 'users':
			// If reconnecting, clean up existing peers first
			if (state.myId) {
				console.log('[WS] Reconnected - cleaning up old peer connections');
				Object.entries(state.peers).forEach(([id, peer]) => {
					if (peer.connectionTimeout) clearTimeout(peer.connectionTimeout);
					if (peer.audioContext) peer.audioContext.close();
					if (peer.statsInterval) clearInterval(peer.statsInterval);
					peer.pc.close();
				});
				state.peers = {};
				// Clear remote users but preserve local
				const localUser = state.users['local'];
				state.users = {};
				if (localUser) state.users['local'] = localUser;
				// Clear pending candidates
				Object.keys(pendingCandidates).forEach(k => delete pendingCandidates[k]);
			}

			state.myId = data.you;
			state.sessionStart = data.session_start;
			state.maxCameras = data.max_cameras;
			state.reconnectToken = data.reconnect_token || null;

			// Save username on successful login
			saveUsername(state.username);

			$('login-screen').classList.add('hidden');
			$('chat-screen').classList.remove('hidden');

			$('sidebar').classList.remove('hidden');
			$('users-btn').classList.add('active');

			// Preserve local state on reconnect, or initialize
			if (!state.users['local']) {
				state.users['local'] = { username: state.username, camOn: state.camEnabled, micOn: state.micEnabled, screenOn: state.screenEnabled, speaking: false };
			}

			data.users.forEach(user => {
				state.users[user.id] = { username: user.username, camOn: user.cam_on, micOn: user.mic_on !== false, screenOn: user.screen_on || false, speaking: false };
				createPeerConnection(user.id, user.username, true);
			});

			updateUI();
			if (!state.timerStarted) {
				startTimer();
				state.timerStarted = true;
			}

			// Request notification permission on join if enabled in settings
			if (state.settings.notifications) {
				requestNotificationPermission();
			}

			// Run TURN connectivity test in background (results shown in debug panel)
			if (typeof testTurnServer === 'function') {
				testTurnServer().then(result => {
					if (!result.success) {
						console.error('[TURN] TURN server test failed - connections may not work properly');
					} else {
						console.log(`[TURN] Server OK: relay in ${result.relayCandidateTime}ms, ${result.candidateCount} candidates`);
					}
				}).catch(e => {
					console.error('[TURN] TURN test error:', e?.message || e);
				});
			}
			break;

		case 'user_joined':
			state.users[data.id] = {
				username: data.username,
				camOn: data.cam_on || false,
				micOn: data.mic_on !== false,
				screenOn: data.screen_on || false,
				speaking: false
			};
			console.log('[Signal] user_joined:', data.id, 'micOn:', data.mic_on, 'state:', state.users[data.id]);
			updateUI();

			// Notification and sound
			showNotification('HardChats', `${data.username} joined the room`, 'user-join');
			playSound('join');
			break;

		case 'user_left':
			const leftUsername = state.users[data.id]?.username || 'Someone';

			// Immediately remove the user
			if (state.peers[data.id]) {
				if (state.peers[data.id].connectionTimeout) clearTimeout(state.peers[data.id].connectionTimeout);
				if (state.peers[data.id].statsInterval) clearInterval(state.peers[data.id].statsInterval);
				if (state.peers[data.id].audioContext) state.peers[data.id].audioContext.close();
				state.peers[data.id].pc.close();
				delete state.peers[data.id];
			}
			delete state.users[data.id];
			delete pendingCandidates[data.id];

			if (state.maximizedPeer === data.id) {
				state.maximizedPeer = null;
			}

			updateUI();

			// Notification and sound
			showNotification('HardChats', `${leftUsername} left the room`, 'user-leave');
			playSound('leave');
			break;

		case 'offer':
			state.users[data.from] = state.users[data.from] || { username: data.username, camOn: false, micOn: true, screenOn: false, speaking: false };
			handleOffer(data.from, data.username, data.sdp);
			updateUI();
			break;

		case 'answer':
			handleAnswer(data.from, data.sdp);
			break;

		case 'candidate':
			handleCandidate(data.from, data.candidate);
			break;

		case 'camera_status':
			if (data.id === state.myId) {
				state.users['local'].camOn = data.enabled;
			} else if (state.users[data.id]) {
				state.users[data.id].camOn = data.enabled;
				if (state.peers[data.id]) {
					state.peers[data.id].camOn = data.enabled;
				}
			}

			if (!data.enabled && state.maximizedPeer === data.id) {
				state.maximizedPeer = null;
			}

			updateUI();
			break;

		case 'mic_status':
			console.log('[Signal] mic_status received:', data);
			if (data.id === state.myId) {
				state.users['local'].micOn = data.enabled;
				console.log('[Signal] Updated local micOn to:', data.enabled);
			} else if (state.users[data.id]) {
				state.users[data.id].micOn = data.enabled;
				console.log('[Signal] Updated user', data.id, 'micOn to:', data.enabled);
			} else {
				console.log('[Signal] User not found for mic_status:', data.id, 'Known users:', Object.keys(state.users));
			}
			updateUI();
			break;

		case 'screen_status':
			console.log('[Signal] screen_status received:', data);
			if (data.id === state.myId) {
				state.users['local'].screenOn = data.enabled;
				console.log('[Signal] Updated local screenOn to:', data.enabled);
			} else if (state.users[data.id]) {
				state.users[data.id].screenOn = data.enabled;
				if (state.peers[data.id]) {
					state.peers[data.id].screenOn = data.enabled;
				}
				console.log('[Signal] Updated user', data.id, 'screenOn to:', data.enabled);
			} else {
				console.log('[Signal] User not found for screen_status:', data.id, 'Known users:', Object.keys(state.users));
			}
			updateUI();
			break;

	}
}

// ========== TIMER ==========

function startTimer() {
	setInterval(() => {
		if (!state.sessionStart) return;
		const elapsed = Math.floor(Date.now() / 1000 - state.sessionStart);
		const h = String(Math.floor(elapsed / 3600)).padStart(2, '0');
		const m = String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0');
		const s = String(elapsed % 60).padStart(2, '0');
		$('session-timer').textContent = `${h}:${m}:${s}`;
	}, 1000);
}

// ========== SIDEBAR & LAYOUT ==========

function initSidebarResize() {
	// Users sidebar resize (right side)
	const sidebar = $('sidebar');
	const sidebarResize = $('sidebar-resize');

	if (sidebarResize) {
		let isResizing = false;
		let startX, startWidth;

		sidebarResize.addEventListener('mousedown', (e) => {
			isResizing = true;
			startX = e.clientX;
			startWidth = sidebar.offsetWidth;
			document.body.style.cursor = 'ew-resize';
			document.body.style.userSelect = 'none';
		});

		document.addEventListener('mousemove', (e) => {
			if (!isResizing) return;
			const diff = startX - e.clientX;
			const newWidth = Math.min(Math.max(startWidth + diff, 200), 500); // Min 200px, max 500px
			sidebar.style.width = newWidth + 'px';
		});

		document.addEventListener('mouseup', () => {
			if (isResizing) {
				isResizing = false;
				document.body.style.cursor = '';
				document.body.style.userSelect = '';
			}
		});
	}

	// IRC sidebar resize (left side)
	const ircSidebar = $('irc-sidebar');
	const ircResize = $('irc-resize');

	if (ircResize) {
		let isResizing = false;
		let startX, startWidth;

		ircResize.addEventListener('mousedown', (e) => {
			isResizing = true;
			startX = e.clientX;
			startWidth = ircSidebar.offsetWidth;
			document.body.style.cursor = 'ew-resize';
			document.body.style.userSelect = 'none';
		});

		document.addEventListener('mousemove', (e) => {
			if (!isResizing) return;
			const diff = e.clientX - startX;
			const newWidth = Math.min(Math.max(startWidth + diff, 250), 600); // Min 250px, max 600px
			ircSidebar.style.width = newWidth + 'px';
		});

		document.addEventListener('mouseup', () => {
			if (isResizing) {
				isResizing = false;
				document.body.style.cursor = '';
				document.body.style.userSelect = '';
			}
		});
	}
}

function toggleSidebar() {
	state.sidebarOpen = !state.sidebarOpen;
	const sidebar = $('sidebar');

	// Clear inline width when hiding so CSS takes effect properly
	if (!state.sidebarOpen) {
		sidebar.style.width = '';
	}

	sidebar.classList.toggle('hidden', !state.sidebarOpen);
	$('users-btn').classList.toggle('active', state.sidebarOpen);
	updateOverlay();
}

function closeSidebars() {
	// Close user sidebar
	if (state.sidebarOpen) {
		state.sidebarOpen = false;
		$('sidebar').style.width = ''; // Clear inline width
		$('sidebar').classList.add('hidden');
		$('users-btn').classList.remove('active');
	}
	// Close IRC sidebar
	if (state.irc.sidebarOpen) {
		state.irc.sidebarOpen = false;
		$('irc-sidebar').style.width = ''; // Clear inline width
		$('irc-sidebar').classList.add('collapsed');
		$('irc-toggle').classList.remove('active');
	}
	updateOverlay();
}

function updateOverlay() {
	// Show overlay on mobile when either sidebar is open
	const isMobile = window.innerWidth <= 768;
	const anySidebarOpen = state.sidebarOpen || state.irc.sidebarOpen;
	$('sidebar-overlay').classList.toggle('hidden', !(isMobile && anySidebarOpen));
}

// ========== PAGE LEAVE ==========

function handlePageLeave() {
	state.intentionalDisconnect = true;

	// Cancel any pending reconnect
	if (state.wsReconnectTimer) {
		clearTimeout(state.wsReconnectTimer);
		state.wsReconnectTimer = null;
	}

	// Disconnect from IRC
	disconnectIrc();

	// Use sendBeacon for reliable leave notification during page unload
	// This is more reliable than WebSocket send during beforeunload/pagehide
	// Must use Blob with application/json content-type for proper server parsing
	if (state.myId) {
		try {
			const data = new Blob([JSON.stringify({ client_id: state.myId })], { type: 'application/json' });
			navigator.sendBeacon('/api/leave', data);
		} catch (e) {
			// Fallback to WebSocket if sendBeacon fails
			if (state.ws?.readyState === WebSocket.OPEN) {
				try {
					state.ws.send(JSON.stringify({ type: 'leave' }));
				} catch (e2) {
					// Ignore errors during unload
				}
			}
		}
	}

	if (state.localAudioContext) state.localAudioContext.close();
	state.localStream?.getTracks().forEach(t => t.stop());
	state.screenStream?.getTracks().forEach(t => t.stop());
	Object.values(state.peers).forEach(p => {
		if (p.audioContext) p.audioContext.close();
		p.pc.close();
	});
	state.ws?.close();
}

// Use both events for better cross-browser/mobile support
window.onbeforeunload = handlePageLeave;
window.addEventListener('pagehide', handlePageLeave);
