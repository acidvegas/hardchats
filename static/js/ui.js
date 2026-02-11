// HardChats - UI Rendering (Video Grid, Users List, Volume)
// Requires: state, $, escapeHtml from state.js

function updateUI() {
	updateUsersList();
	updateVideoGrid();
}

function updateSpeakingIndicator(peerId, speaking) {
	document.querySelector(`.user-item[data-id="${peerId}"]`)?.classList.toggle('speaking', speaking);
	$(`tile-${peerId}`)?.classList.toggle('speaking', speaking);
}

function updateVideoGrid() {
	const grid = $('video-grid');
	const maxView = $('maximized-video');
	const thumbStrip = $('thumbnail-strip');

	const camUsers = [];

	// Add local camera if enabled
	if (state.camEnabled && state.users['local']?.camOn) {
		camUsers.push({
			id: 'local',
			username: state.username,
			stream: state.localStream,
			isLocal: true,
			isScreen: false,
			speaking: state.users['local']?.speaking
		});
	}

	// Add local screen share if enabled (separate tile)
	if (state.screenEnabled && state.screenStream) {
		camUsers.push({
			id: 'local-screen',
			username: `${state.username} (Screen)`,
			stream: state.screenStream,
			isLocal: true,
			isScreen: true,
			speaking: false
		});
	}

	// Add remote users' cameras and screens
	Object.entries(state.peers).forEach(([id, peer]) => {
		if (state.users[id]?.camOn && peer.stream && !peer.videoOff) {
			// Check if stream has video tracks - could be camera or screen
			const videoTracks = peer.stream.getVideoTracks();
			if (videoTracks.length > 0) {
				camUsers.push({
					id,
					username: peer.username,
					stream: peer.stream,
					isLocal: false,
					isScreen: false,
					speaking: state.users[id]?.speaking
				});
			}
		}
		// Show screen share indicator for remote users
		if (state.users[id]?.screenOn && peer.stream && !peer.videoOff) {
			// Screen shares come through the same stream for remote peers
			// The peer.stream may contain multiple video tracks
		}
	});

	grid.innerHTML = '';

	if (state.maximizedPeer) {
		const maxUser = camUsers.find(u => u.id === state.maximizedPeer);
		if (!maxUser) {
			state.maximizedPeer = null;
			updateVideoGrid();
			return;
		}

		$('video-grid').classList.add('hidden');
		$('maximized-view').classList.remove('hidden');

		maxView.innerHTML = createVideoTile(maxUser, true);
		const tile = maxView.querySelector('.video-tile');
		if (tile) tile.onclick = () => exitMaximized();
		attachStreamToTile(maxUser.id, maxUser.stream, maxUser.isLocal);

		thumbStrip.innerHTML = '';
		camUsers.filter(u => u.id !== state.maximizedPeer).forEach(user => {
			const thumb = document.createElement('div');
			thumb.className = 'thumbnail';
			thumb.innerHTML = createVideoTile(user, false);
			thumb.onclick = () => maximizeVideo(user.id);
			thumbStrip.appendChild(thumb);
			attachStreamToTile(user.id, user.stream, user.isLocal);
		});
	} else {
		$('video-grid').classList.remove('hidden');
		$('maximized-view').classList.add('hidden');

		const count = camUsers.length;
		if (count > 0) {
			const gridRect = grid.parentElement.getBoundingClientRect();
			const availableWidth = gridRect.width - 16;
			const availableHeight = gridRect.height - 16;

			let bestCols = 1;
			let bestSize = 0;

			for (let cols = 1; cols <= count; cols++) {
				const rows = Math.ceil(count / cols);
				const tileWidth = (availableWidth - (cols - 1) * 8) / cols;
				const tileHeight = (availableHeight - (rows - 1) * 8) / rows;
				// Square tiles - use the smaller dimension
				const size = Math.min(tileWidth, tileHeight);

				if (size > bestSize) {
					bestSize = size;
					bestCols = cols;
				}
			}

			grid.style.gridTemplateColumns = `repeat(${bestCols}, 1fr)`;
		}

		camUsers.forEach(user => {
			const tile = document.createElement('div');
			tile.innerHTML = createVideoTile(user, false);
			const tileEl = tile.firstElementChild;
			tileEl.onclick = () => maximizeVideo(user.id);
			grid.appendChild(tileEl);
			attachStreamToTile(user.id, user.stream, user.isLocal);
		});
	}
}

function createVideoTile(user, isMaximized) {
	const isScreen = user.isScreen || user.id.includes('-screen');
	const isLocalUser = user.isLocal && !isScreen;
	return `
		<div class="video-tile ${user.isLocal ? 'local' : ''} ${user.speaking ? 'speaking' : ''} ${isMaximized ? 'maximized' : ''} ${isScreen ? 'screen-share' : ''}" id="tile-${user.id}">
			<video autoplay playsinline ${user.isLocal ? 'muted' : ''}></video>
			<div class="username">${isScreen ? '🖥️ ' : ''}${escapeHtml(user.username)}${isLocalUser ? ' <span class="you">(you)</span>' : ''}</div>
		</div>
	`;
}

function attachStreamToTile(id, stream, isLocal) {
	setTimeout(() => {
		const tile = $(`tile-${id}`);
		if (tile && stream) {
			const video = tile.querySelector('video');
			if (video) {
				video.srcObject = stream;
				// Always mute video element - audio is handled via Web Audio API GainNode
				video.muted = true;
				video.play().catch(() => { });
			}
		}
	}, 0);
}

function maximizeVideo(peerId) {
	state.maximizedPeer = peerId;
	updateVideoGrid();
}

function exitMaximized() {
	state.maximizedPeer = null;
	updateVideoGrid();
}

function getNetworkQualityHTML(peerId) {
	const peer = state.peers[peerId];
	if (!peer) return '';

	const quality = peer.networkQuality || 'unknown';
	const bars = peer.networkBars || 0;

	if (quality === 'unknown') return '';

	let barsHTML = '';
	for (let i = 1; i <= 4; i++) {
		barsHTML += `<div class="network-bar ${i <= bars ? 'active' : ''}"></div>`;
	}

	// Build detailed tooltip
	const details = [];
	if (peer.packetLoss !== undefined) details.push(`Loss: ${peer.packetLoss}%`);
	if (peer.jitter !== undefined) details.push(`Jitter: ${peer.jitter}ms`);
	if (peer.rtt !== undefined) details.push(`RTT: ${peer.rtt}ms`);
	const tooltip = details.length > 0 ? `${quality.charAt(0).toUpperCase() + quality.slice(1)} - ${details.join(', ')}` : quality;

	return `<div class="network-quality ${quality}" title="${tooltip}">${barsHTML}</div>`;
}

function updateUsersList() {
	const list = $('users-list');
	const count = $('user-count');

	// Build user list and sort alphabetically by username
	const allUsers = [
		{ id: 'local', ...state.users['local'], isLocal: true },
		...Object.entries(state.users).filter(([id]) => id !== 'local').map(([id, u]) => ({ id, ...u, isLocal: false }))
	].sort((a, b) => {
		// Local user always first, then sort alphabetically
		if (a.isLocal) return -1;
		if (b.isLocal) return 1;
		return (a.username || '').toLowerCase().localeCompare((b.username || '').toLowerCase());
	});

	// Debug log for mic status
	console.log('[UsersList] Rendering users:', allUsers.map(u => ({ id: u.id, username: u.username, micOn: u.micOn })));

	count.textContent = allUsers.length;

	list.innerHTML = allUsers.map(user => {
		const peer = state.peers[user.id];
		const volume = peer?.volume ?? 100;
		const isMuted = volume === 0;
		const isVideoOff = peer?.videoOff;

		// Volume icon changes based on level
		let volumeIcon;
		if (isMuted) {
			volumeIcon = '<path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>';
		} else if (volume < 50) {
			volumeIcon = '<path d="M7 9v6h4l5 5V4l-5 5H7z"/>';
		} else if (volume <= 100) {
			volumeIcon = '<path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/>';
		} else {
			volumeIcon = '<path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>';
		}

		return `
			<div class="user-item ${user.speaking ? 'speaking' : ''} ${user.isLocal ? 'local' : ''}" data-id="${user.id}">
				<div class="user-info">
					${user.isLocal ? '' : getNetworkQualityHTML(user.id)}
					<span class="user-name">${escapeHtml(user.username)}</span>
					<div class="user-indicators">
						${user.micOn === false ? '<svg class="indicator mic-muted" viewBox="0 0 24 24" fill="currentColor" title="Muted"><path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z"/></svg>' : ''}
						${user.camOn ? '<svg class="indicator cam-on" viewBox="0 0 24 24" fill="currentColor" title="Camera On"><path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/></svg>' : ''}
						${user.screenOn ? '<svg class="indicator screen-on" viewBox="0 0 24 24" fill="currentColor" title="Sharing Screen"><path d="M20 18c1.1 0 1.99-.9 1.99-2L22 6c0-1.1-.9-2-2-2H4c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2H0v2h24v-2h-4zM4 6h16v10H4V6z"/></svg>' : ''}
						${user.speaking && user.micOn !== false ? '<svg class="indicator mic-active" viewBox="0 0 24 24" fill="currentColor" title="Speaking"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/><path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/></svg>' : ''}
					</div>
				</div>
				${user.isLocal ? `
				<div class="user-controls">
					<button class="user-control-btn" onclick="openSettings(event)" title="Device Settings">
						<svg viewBox="0 0 24 24" fill="currentColor">
							<path d="M19.14 12.94c.04-.31.06-.63.06-.94 0-.31-.02-.63-.06-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/>
						</svg>
					</button>
				</div>
				` : `
				<div class="user-controls">
					<button class="user-control-btn ${isMuted ? 'active' : ''}" onclick="showVolumePopup('${user.id}', event)" title="Adjust Volume (${volume}%)">
						<svg viewBox="0 0 24 24" fill="currentColor">
							${volumeIcon}
						</svg>
					</button>
					<button class="user-control-btn ${isVideoOff ? 'active' : ''}" onclick="togglePeerVideo('${user.id}')" title="${isVideoOff ? 'Show Video' : 'Hide Video'}">
						<svg viewBox="0 0 24 24" fill="currentColor">
							${isVideoOff ? '<path d="M21 6.5l-4 4V7c0-.55-.45-1-1-1H9.82L21 17.18V6.5zM3.27 2L2 3.27 4.73 6H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.21 0 .39-.08.54-.18L19.73 21 21 19.73 3.27 2z"/>' : '<path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/>'}
						</svg>
					</button>
				</div>
				`}
			</div>
		`;
	}).join('');
}

// Volume popup state
let activeVolumePopup = null;

window.showVolumePopup = function (peerId, event) {
	event.stopPropagation();
	const peer = state.peers[peerId];
	const user = state.users[peerId];
	if (!peer) return;

	const popup = $('volume-popup');
	const slider = $('volume-slider');
	const nameEl = $('volume-popup-name');
	const valueEl = $('volume-popup-value');

	// Initialize volume if not set
	if (peer.volume === undefined) peer.volume = 100;

	nameEl.textContent = user?.username || 'User';
	slider.value = peer.volume;
	valueEl.textContent = peer.volume === 0 ? 'Muted' : `${peer.volume}%`;

	// Position popup near the button
	const btn = event.currentTarget;
	const rect = btn.getBoundingClientRect();
	popup.style.left = `${rect.left - 150}px`;
	popup.style.top = `${rect.bottom + 5}px`;

	// Ensure popup stays on screen
	const popupRect = popup.getBoundingClientRect();
	if (parseFloat(popup.style.left) < 10) {
		popup.style.left = '10px';
	}

	popup.classList.remove('hidden');
	activeVolumePopup = peerId;

	// Update volume on slider change
	slider.oninput = () => {
		const vol = parseInt(slider.value);
		peer.volume = vol;
		valueEl.textContent = vol === 0 ? 'Muted' : `${vol}%`;
		applyPeerVolume(peerId);
		updateUsersList();
	};
};

function applyPeerVolume(peerId) {
	const peer = state.peers[peerId];
	if (!peer) return;

	const vol = peer.volume ?? 100;

	// Resume audio context if suspended
	if (peer.audioContext && peer.audioContext.state === 'suspended') {
		peer.audioContext.resume();
	}

	// Use GainNode for volume control (supports 0-150%)
	// Only apply if global volume is enabled
	if (peer.gainNode) {
		const newGain = state.volumeEnabled ? (vol / 100) : 0;
		peer.gainNode.gain.setValueAtTime(newGain, peer.audioContext?.currentTime || 0);
		console.log(`[Audio] Set ${peerId} volume to ${vol}%, gain: ${newGain}`);
	}

	// Update muted state
	peer.muted = vol === 0;
}

// Close volume popup when clicking outside
document.addEventListener('click', (e) => {
	const popup = $('volume-popup');
	if (activeVolumePopup && !popup.contains(e.target)) {
		popup.classList.add('hidden');
		activeVolumePopup = null;
	}

	// Resume all audio contexts on user interaction (browser autoplay policy)
	resumeAllAudioContexts();
});

// Resume all suspended audio contexts
function resumeAllAudioContexts() {
	Object.values(state.peers).forEach(peer => {
		if (peer.audioContext && peer.audioContext.state === 'suspended') {
			peer.audioContext.resume().then(() => {
				console.log('[Audio] Context resumed after user interaction');
			});
		}
	});
}

window.togglePeerVideo = function (peerId) {
	const peer = state.peers[peerId];
	if (!peer) return;

	peer.videoOff = !peer.videoOff;

	if (state.maximizedPeer === peerId && peer.videoOff) {
		state.maximizedPeer = null;
	}

	updateUI();
};

