// HardChats - Notifications & Sounds
// Requires: state from state.js
// Requires: saveSettings from settings.js (at runtime)

// Request notification permission and sync settings
async function requestNotificationPermission() {
	if (!('Notification' in window)) {
		state.settings.notifications = false;
		saveSettings();
		return false;
	}

	if (Notification.permission === 'default') {
		const result = await Notification.requestPermission();
		if (result !== 'granted') {
			state.settings.notifications = false;
			saveSettings();
			return false;
		}
	} else if (Notification.permission === 'denied') {
		state.settings.notifications = false;
		saveSettings();
		return false;
	}

	return Notification.permission === 'granted';
}

// Sync notification toggle with browser permission
function syncNotificationPermission() {
	if (!('Notification' in window) || Notification.permission === 'denied') {
		state.settings.notifications = false;
		saveSettings();
	}
}

// Show browser notification
function showNotification(title, body, tag = null) {
	console.log('[Notification] Attempting:', title, body, 'enabled:', state.settings.notifications, 'permission:', Notification?.permission);

	if (!state.settings.notifications) return;
	if (!('Notification' in window)) return;
	if (Notification.permission !== 'granted') return;

	// Only skip if document has focus (user is actively looking at the tab)
	if (document.hasFocus() && document.visibilityState === 'visible') return;

	const options = {
		body,
		icon: '/static/favicon.ico',
		badge: '/static/favicon.ico',
		tag: tag || undefined,
		renotify: !!tag,
		silent: false
	};

	try {
		const notif = new Notification(title, options);
		console.log('[Notification] Created successfully');

		// Auto-close after 5 seconds
		setTimeout(() => notif.close(), 5000);
	} catch (e) {
		console.error('[Notification] Failed:', e);
	}
}

// Sound context for generating sounds
let soundContext = null;

function getSoundContext() {
	if (!soundContext) {
		soundContext = new (window.AudioContext || window.webkitAudioContext)();
	}
	if (soundContext.state === 'suspended') {
		soundContext.resume();
	}
	return soundContext;
}

// Play sound effect using Web Audio API
function playSound(type) {
	if (!state.settings.sounds) return;

	console.log('[Sound] Playing:', type);

	try {
		const ctx = getSoundContext();
		const oscillator = ctx.createOscillator();
		const gainNode = ctx.createGain();

		oscillator.connect(gainNode);
		gainNode.connect(ctx.destination);

		// Different sounds for different events
		const now = ctx.currentTime;

		if (type === 'join') {
			// Rising tone
			oscillator.frequency.setValueAtTime(400, now);
			oscillator.frequency.linearRampToValueAtTime(600, now + 0.1);
			oscillator.type = 'sine';
			gainNode.gain.setValueAtTime(0.3, now);
			gainNode.gain.linearRampToValueAtTime(0, now + 0.15);
			oscillator.start(now);
			oscillator.stop(now + 0.15);
		} else if (type === 'leave') {
			// Falling tone
			oscillator.frequency.setValueAtTime(500, now);
			oscillator.frequency.linearRampToValueAtTime(300, now + 0.15);
			oscillator.type = 'sine';
			gainNode.gain.setValueAtTime(0.3, now);
			gainNode.gain.linearRampToValueAtTime(0, now + 0.2);
			oscillator.start(now);
			oscillator.stop(now + 0.2);
		} else if (type === 'message') {
			// Short double beep
			oscillator.frequency.setValueAtTime(800, now);
			oscillator.type = 'sine';
			gainNode.gain.setValueAtTime(0.2, now);
			gainNode.gain.setValueAtTime(0, now + 0.05);
			gainNode.gain.setValueAtTime(0.2, now + 0.1);
			gainNode.gain.linearRampToValueAtTime(0, now + 0.15);
			oscillator.start(now);
			oscillator.stop(now + 0.15);
		}
	} catch (e) {
		console.error('[Sound] Failed:', e);
	}
}

