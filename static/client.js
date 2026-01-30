// HardChats Client
const state = {
    ws: null,
    myId: null,
    username: null,
    localStream: null,
    localAudioContext: null,
    localAnalyser: null,
    peers: {},
    users: {},
    micEnabled: true,
    camEnabled: false,
    volumeEnabled: true,
    maximizedPeer: null,
    sidebarOpen: true,
    captchaId: null,
    sessionStart: null,
    maxCameras: 10,
    configLoaded: false,
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

const USERNAME_REGEX = /^[\x20-\x7E]{1,20}$/;

const $ = (id) => document.getElementById(id);

document.addEventListener('DOMContentLoaded', async () => {
    // Load saved settings
    loadSettings();
    
    // Load configuration from server first
    await loadConfig();
    
    $('connect-btn').addEventListener('click', connect);
    $('username').addEventListener('keypress', (e) => e.key === 'Enter' && $('captcha-answer').focus());
    $('captcha-answer').addEventListener('keypress', (e) => e.key === 'Enter' && connect());
    $('refresh-captcha').addEventListener('click', loadCaptcha);
    $('mic-btn').addEventListener('click', toggleMic);
    $('cam-btn').addEventListener('click', toggleCam);
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
        
        switch (e.key.toLowerCase()) {
            case 'm':
                toggleMic();
                break;
            case 'u':
                toggleSidebar();
                break;
            case 'c':
                toggleIrcSidebar();
                break;
        }
    });
    
    loadCaptcha();
});

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
            $('footer-version').textContent = `v${config.version}`;
        }
        $('footer-year').textContent = new Date().getFullYear();
        
        console.log('[Config] Loaded successfully');
    } catch (e) {
        console.error('[Config] Failed to load:', e);
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

function validateUsername(name) {
    return USERNAME_REGEX.test(name);
}

async function connect() {
    const username = $('username').value.trim();
    const captchaAnswer = $('captcha-answer').value.trim();
    
    if (!username) return $('username').focus();
    if (!validateUsername(username)) {
        showError('Invalid username. Use 1-20 printable ASCII characters.');
        return;
    }
    if (!captchaAnswer) return $('captcha-answer').focus();
    
    state.username = username;
    $('login-error').classList.add('hidden');
    
    try {
        state.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        
        // Setup local audio analyser for speaking detection
        setupLocalAudioAnalyser();
        
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        state.ws = new WebSocket(`${protocol}//${location.host}/ws`);
        
        state.ws.onopen = () => {
            state.ws.send(JSON.stringify({
                type: 'join',
                username,
                captcha_id: state.captchaId,
                captcha_answer: captchaAnswer
            }));
        };
        
        state.ws.onmessage = (e) => handleSignal(JSON.parse(e.data));
        state.ws.onclose = () => console.log('Disconnected');
        state.ws.onerror = (e) => console.error('WS error:', e);
        
    } catch (err) {
        console.error('Media error:', err);
        showError(location.protocol === 'http:' ? 'HTTPS required!' : `Microphone error: ${err.message}`);
    }
}

function setupLocalAudioAnalyser() {
    try {
        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 256;
        const source = audioContext.createMediaStreamSource(state.localStream);
        source.connect(analyser);
        
        state.localAudioContext = audioContext;
        state.localAnalyser = analyser;
        
        const dataArray = new Uint8Array(analyser.frequencyBinCount);
        
        const checkAudio = () => {
            if (!state.localAnalyser) return;
            analyser.getByteFrequencyData(dataArray);
            const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
            const speaking = avg > 20;
            
            if (state.users['local'] && state.users['local'].speaking !== speaking) {
                state.users['local'].speaking = speaking;
                updateSpeakingIndicator('local', speaking);
            }
            requestAnimationFrame(checkAudio);
        };
        checkAudio();
    } catch (e) {
        console.error('Local audio analyser error:', e);
    }
}

function showError(msg) {
    const el = $('login-error');
    el.textContent = msg;
    el.classList.remove('hidden');
    loadCaptcha();
}

function handleSignal(data) {
    switch (data.type) {
        case 'error':
            showError(data.message);
            break;
            
        case 'users':
            state.myId = data.you;
            state.sessionStart = data.session_start;
            state.maxCameras = data.max_cameras;
            
            $('login-screen').classList.add('hidden');
            $('chat-screen').classList.remove('hidden');
            
            $('sidebar').classList.remove('hidden');
            $('users-btn').classList.add('active');
            
            state.users['local'] = { username: state.username, camOn: false, speaking: false };
            
            data.users.forEach(user => {
                state.users[user.id] = { username: user.username, camOn: user.cam_on, speaking: false };
                createPeerConnection(user.id, user.username, true);
            });
            
            updateUI();
            startTimer();
            break;
            
        case 'user_joined':
            state.users[data.id] = { username: data.username, camOn: false, speaking: false };
            updateUI();
            
            // Notification and sound
            showNotification('HardChats', `${data.username} joined the room`, 'user-join');
            playSound('join');
            break;
            
        case 'user_left':
            const leftUsername = state.users[data.id]?.username || 'Someone';
            
            // Immediately remove the user
            if (state.peers[data.id]) {
                if (state.peers[data.id].audioContext) state.peers[data.id].audioContext.close();
                state.peers[data.id].pc.close();
                delete state.peers[data.id];
            }
            delete state.users[data.id];
            
            if (state.maximizedPeer === data.id) {
                state.maximizedPeer = null;
            }
            
            updateUI();
            
            // Notification and sound
            showNotification('HardChats', `${leftUsername} left the room`, 'user-leave');
            playSound('leave');
            break;
            
        case 'offer':
            state.users[data.from] = state.users[data.from] || { username: data.username, camOn: false, speaking: false };
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
            
    }
}

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

// Network quality monitoring
function startNetworkMonitoring(peerId) {
    const peer = state.peers[peerId];
    if (!peer) return;
    
    // Clear existing interval if any
    if (peer.statsInterval) {
        clearInterval(peer.statsInterval);
    }
    
    peer.prevStats = null;
    
    peer.statsInterval = setInterval(async () => {
        if (!peer.pc || peer.pc.connectionState === 'closed') {
            clearInterval(peer.statsInterval);
            return;
        }
        
        try {
            const stats = await peer.pc.getStats();
            let packetsLost = 0;
            let packetsReceived = 0;
            let jitter = 0;
            let roundTripTime = 0;
            let hasAudioStats = false;
            
            stats.forEach(report => {
                // Look for inbound-rtp stats for audio
                if (report.type === 'inbound-rtp' && report.kind === 'audio') {
                    packetsReceived = report.packetsReceived || 0;
                    packetsLost = report.packetsLost || 0;
                    jitter = report.jitter || 0;
                    hasAudioStats = true;
                }
                
                // Look for candidate-pair stats for RTT
                if (report.type === 'candidate-pair' && report.state === 'succeeded') {
                    roundTripTime = report.currentRoundTripTime || 0;
                }
            });
            
            if (!hasAudioStats) return;
            
            // Calculate packet loss percentage
            const totalPackets = packetsReceived + packetsLost;
            const lossPercent = totalPackets > 0 ? (packetsLost / totalPackets) * 100 : 0;
            
            // Determine quality based on metrics
            // Packet loss: <1% excellent, 1-3% good, 3-8% fair, >8% poor
            // Jitter: <30ms excellent, 30-50ms good, 50-100ms fair, >100ms poor
            // RTT: <100ms excellent, 100-200ms good, 200-400ms fair, >400ms poor
            
            let quality, bars;
            
            if (lossPercent < 1 && jitter < 0.03 && roundTripTime < 0.1) {
                quality = 'excellent';
                bars = 4;
            } else if (lossPercent < 3 && jitter < 0.05 && roundTripTime < 0.2) {
                quality = 'good';
                bars = 3;
            } else if (lossPercent < 8 && jitter < 0.1 && roundTripTime < 0.4) {
                quality = 'fair';
                bars = 2;
            } else {
                quality = 'poor';
                bars = 1;
            }
            
            peer.networkQuality = quality;
            peer.networkBars = bars;
            peer.packetLoss = lossPercent.toFixed(1);
            peer.jitter = (jitter * 1000).toFixed(0);
            peer.rtt = (roundTripTime * 1000).toFixed(0);
            
            updateUsersList();
            
        } catch (e) {
            console.error('[Stats] Error getting peer stats:', e);
        }
    }, 3000); // Check every 3 seconds
}

function updateUI() {
    updateUsersList();
    updateVideoGrid();
}

async function createPeerConnection(peerId, username, initiator) {
    if (state.peers[peerId]) state.peers[peerId].pc.close();
    
    // Use TURN config from turn.js
    const pc = new RTCPeerConnection(getRtcConfig());
    
    state.peers[peerId] = { 
        pc, 
        stream: null, 
        username, 
        camOn: state.users[peerId]?.camOn || false, 
        muted: false, 
        videoOff: false, 
        volume: 100,
        audioContext: null, 
        analyser: null,
        gainNode: null,
        networkQuality: 'unknown',
        networkBars: 0,
        statsInterval: null
    };
    
    state.localStream.getTracks().forEach(track => pc.addTrack(track, state.localStream));
    
    pc.ontrack = (e) => {
        const stream = e.streams[0];
        if (stream) {
            state.peers[peerId].stream = stream;
            stream.getAudioTracks().forEach(t => t.enabled = state.volumeEnabled && !state.peers[peerId].muted);
            setupAudioAnalyser(peerId, stream);
            
            const hasVideo = stream.getVideoTracks().length > 0;
            if (hasVideo) {
                state.peers[peerId].camOn = true;
                if (state.users[peerId]) state.users[peerId].camOn = true;
            }
            
            updateUI();
            
            stream.onaddtrack = (e) => {
                if (e.track.kind === 'video') {
                    state.peers[peerId].camOn = true;
                    if (state.users[peerId]) state.users[peerId].camOn = true;
                    updateUI();
                }
            };
            
            stream.onremovetrack = (e) => {
                if (e.track.kind === 'video') {
                    state.peers[peerId].camOn = false;
                    if (state.users[peerId]) state.users[peerId].camOn = false;
                    updateUI();
                }
            };
        }
    };
    
    pc.onicecandidate = (e) => {
        if (e.candidate) send({ type: 'candidate', target: peerId, candidate: e.candidate });
    };
    
    pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') {
            startNetworkMonitoring(peerId);
            updateUI();
        } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed' || pc.connectionState === 'closed') {
            if (state.peers[peerId]?.statsInterval) {
                clearInterval(state.peers[peerId].statsInterval);
            }
        }
    };
    
    if (initiator) {
        pc.addTransceiver('video', { direction: 'recvonly' });
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        send({ type: 'offer', target: peerId, sdp: offer.sdp });
    }
    
    return pc;
}

async function handleOffer(peerId, username, sdp) {
    let pc;
    
    // Check if peer connection already exists (renegotiation)
    if (state.peers[peerId] && state.peers[peerId].pc && 
        state.peers[peerId].pc.connectionState !== 'closed' &&
        state.peers[peerId].pc.connectionState !== 'failed') {
        // Reuse existing connection for renegotiation
        pc = state.peers[peerId].pc;
        console.log(`[WebRTC] Renegotiating with ${peerId}`);
    } else {
        // Create new connection for new peer
        pc = await createPeerConnection(peerId, username, false);
    }
    
    await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp }));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    send({ type: 'answer', target: peerId, sdp: answer.sdp });
}

async function handleAnswer(peerId, sdp) {
    const peer = state.peers[peerId];
    if (peer) await peer.pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp }));
}

async function handleCandidate(peerId, candidate) {
    const peer = state.peers[peerId];
    if (peer) await peer.pc.addIceCandidate(new RTCIceCandidate(candidate));
}

function setupAudioAnalyser(peerId, stream) {
    try {
        // Close existing audio context if any
        if (state.peers[peerId]?.audioContext) {
            state.peers[peerId].audioContext.close();
        }
        
        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        
        // Resume audio context if suspended (browser autoplay policy)
        if (audioContext.state === 'suspended') {
            audioContext.resume();
        }
        
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 256;
        const source = audioContext.createMediaStreamSource(stream);
        
        // Create gain node for volume control
        const gainNode = audioContext.createGain();
        // Respect both global mute (volumeEnabled) and individual volume setting
        const peerVolume = (state.peers[peerId]?.volume ?? 100) / 100;
        gainNode.gain.value = state.volumeEnabled ? peerVolume : 0;
        
        // Connect: source -> analyser (for speaking detection)
        // Also: source -> gain -> destination (for playback with volume control)
        source.connect(analyser);
        source.connect(gainNode);
        gainNode.connect(audioContext.destination);
        
        state.peers[peerId].audioContext = audioContext;
        state.peers[peerId].analyser = analyser;
        state.peers[peerId].gainNode = gainNode;
        state.peers[peerId].audioSource = source;
        
        const dataArray = new Uint8Array(analyser.frequencyBinCount);
        
        const checkAudio = () => {
            if (!state.peers[peerId]) return;
            analyser.getByteFrequencyData(dataArray);
            const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
            const speaking = avg > 20;
            
            if (state.users[peerId] && state.users[peerId].speaking !== speaking) {
                state.users[peerId].speaking = speaking;
                updateSpeakingIndicator(peerId, speaking);
            }
            requestAnimationFrame(checkAudio);
        };
        checkAudio();
        
        console.log(`[Audio] Setup analyser for ${peerId}, context state: ${audioContext.state}`);
    } catch (e) {
        console.error('Audio analyser error:', e);
    }
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
    
    if (state.camEnabled && state.users['local']?.camOn) {
        camUsers.push({ 
            id: 'local', 
            username: state.username, 
            stream: state.localStream, 
            isLocal: true,
            speaking: state.users['local']?.speaking 
        });
    }
    
    Object.entries(state.peers).forEach(([id, peer]) => {
        if (state.users[id]?.camOn && peer.stream && !peer.videoOff) {
            camUsers.push({ 
                id, 
                username: peer.username, 
                stream: peer.stream, 
                isLocal: false,
                speaking: state.users[id]?.speaking
            });
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
                const aspectWidth = tileHeight * (16/9);
                const size = Math.min(tileWidth, aspectWidth);
                
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
    return `
        <div class="video-tile ${user.isLocal ? 'local' : ''} ${user.speaking ? 'speaking' : ''} ${isMaximized ? 'maximized' : ''}" id="tile-${user.id}">
            <video autoplay playsinline ${user.isLocal ? 'muted' : ''}></video>
            <div class="username">${escapeHtml(user.username)}${user.isLocal ? ' <span class="you">(you)</span>' : ''}</div>
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
                video.play().catch(() => {});
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
    
    const allUsers = [
        { id: 'local', ...state.users['local'], isLocal: true },
        ...Object.entries(state.users).filter(([id]) => id !== 'local').map(([id, u]) => ({ id, ...u, isLocal: false }))
    ];
    
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
                    <span class="user-name">${escapeHtml(user.username)}</span>
                    ${user.isLocal ? '' : getNetworkQualityHTML(user.id)}
                    <div class="user-indicators">
                        ${user.camOn ? '<svg class="indicator cam-on" viewBox="0 0 24 24" fill="currentColor"><path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/></svg>' : ''}
                        ${user.speaking ? '<svg class="indicator mic-active" viewBox="0 0 24 24" fill="currentColor"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/><path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/></svg>' : ''}
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

window.showVolumePopup = function(peerId, event) {
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

window.togglePeerVideo = function(peerId) {
    const peer = state.peers[peerId];
    if (!peer) return;
    
    peer.videoOff = !peer.videoOff;
    
    if (state.maximizedPeer === peerId && peer.videoOff) {
        state.maximizedPeer = null;
    }
    
    updateUI();
};

function toggleMic() {
    state.micEnabled = !state.micEnabled;
    state.localStream?.getAudioTracks().forEach(t => t.enabled = state.micEnabled);
    $('mic-btn').classList.toggle('active', state.micEnabled);
    $('mic-btn').classList.toggle('muted', !state.micEnabled);
}

async function toggleCam() {
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
    }
    
    $('cam-btn').classList.toggle('active', state.camEnabled);
    updateUI();
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

function toggleSidebar() {
    state.sidebarOpen = !state.sidebarOpen;
    $('sidebar').classList.toggle('hidden', !state.sidebarOpen);
    $('users-btn').classList.toggle('active', state.sidebarOpen);
    updateOverlay();
}

function closeSidebars() {
    // Close user sidebar
    if (state.sidebarOpen) {
        state.sidebarOpen = false;
        $('sidebar').classList.add('hidden');
        $('users-btn').classList.remove('active');
    }
    // Close IRC sidebar
    if (state.irc.sidebarOpen) {
        state.irc.sidebarOpen = false;
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

function send(data) {
    if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(data));
}

function escapeHtml(text) {
    const d = document.createElement('div');
    d.textContent = text;
    return d.innerHTML;
}

function handlePageLeave() {
    // Disconnect from IRC
    disconnectIrc();
    
    // Send leave message to server for immediate cleanup
    if (state.ws?.readyState === WebSocket.OPEN) {
        try {
            state.ws.send(JSON.stringify({ type: 'leave' }));
        } catch (e) {
            // Ignore errors during unload
        }
    }
    
    if (state.localAudioContext) state.localAudioContext.close();
    state.localStream?.getTracks().forEach(t => t.stop());
    Object.values(state.peers).forEach(p => {
        if (p.audioContext) p.audioContext.close();
        p.pc.close();
    });
    state.ws?.close();
}

// Use both events for better cross-browser/mobile support
window.onbeforeunload = handlePageLeave;
window.addEventListener('pagehide', handlePageLeave);

// ========== SETTINGS MODAL ==========
let settingsPreviewStream = null;
let selectedMicId = null;
let selectedCamId = null;

window.openSettings = async function(event) {
    event.stopPropagation();
    
    const modal = $('settings-modal');
    const micSelect = $('mic-select');
    const camSelect = $('cam-select');
    
    // Update toggle states from saved settings
    updateSettingsToggles();
    
    // Get current device IDs
    const currentAudioTrack = state.localStream?.getAudioTracks()[0];
    const currentVideoTrack = state.localStream?.getVideoTracks()[0];
    
    selectedMicId = currentAudioTrack?.getSettings()?.deviceId || null;
    selectedCamId = currentVideoTrack?.getSettings()?.deviceId || null;
    
    // Enumerate devices
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        
        // Populate microphone select
        micSelect.innerHTML = '';
        const audioDevices = devices.filter(d => d.kind === 'audioinput');
        audioDevices.forEach(device => {
            const option = document.createElement('option');
            option.value = device.deviceId;
            option.textContent = device.label || `Microphone ${micSelect.options.length + 1}`;
            if (device.deviceId === selectedMicId) option.selected = true;
            micSelect.appendChild(option);
        });
        
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
        
        // Show preview for current camera
        await updateSettingsPreview();
        
    } catch (e) {
        console.error('[Settings] Failed to enumerate devices:', e);
    }
    
    modal.classList.remove('hidden');
};

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
    
    updateUI();
    closeSettings();
}

// ========== NOTIFICATIONS & SOUNDS ==========

// Request notification permission
async function requestNotificationPermission() {
    if ('Notification' in window && Notification.permission === 'default') {
        await Notification.requestPermission();
    }
}

// Show browser notification
function showNotification(title, body, tag = null) {
    if (!state.settings.notifications) return;
    if (!('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;
    if (document.hasFocus()) return; // Don't show if tab is focused
    
    const options = {
        body,
        icon: '/static/favicon.ico',
        badge: '/static/favicon.ico',
        tag: tag || undefined,
        renotify: !!tag
    };
    
    try {
        new Notification(title, options);
    } catch (e) {
        console.error('[Notification] Failed:', e);
    }
}

// Play sound effect
function playSound(type) {
    if (!state.settings.sounds) return;
    
    const soundEl = $(`sound-${type}`);
    if (!soundEl) return;
    
    // Set sound source (base64 encoded short sounds)
    const sounds = {
        join: 'data:audio/mp3;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA//tQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAABhgC7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7//////////////////////////////////////////////////////////////////8AAAAATGF2YzU4LjEzAAAAAAAAAAAAAAAAJAAAAAAAAAAAAYbpUKJIAAAAAAAAAAAAAAAAAAAA//tQZAAP8AAAaQAAAAgAAA0gAAABAAABpAAAACAAADSAAAAETEFNRTMuMTAwVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//tQZB8P8AAAaQAAAAgAAA0gAAABAAABpAAAACAAADSAAAAEVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV',
        leave: 'data:audio/mp3;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA//tQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAABhgC7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7//////////////////////////////////////////////////////////////////8AAAAATGF2YzU4LjEzAAAAAAAAAAAAAAAAJAAAAAAAAAAAAYbHFMJhAAAAAAAAAAAAAAAAAAAA//tQZAAP8AAAaQAAAAgAAA0gAAABAAABpAAAACAAADSAAAAETEFNRTMuMTAwVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//tQZB8P8AAAaQAAAAgAAA0gAAABAAABpAAAACAAADSAAAAEVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV',
        message: 'data:audio/mp3;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA//tQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAABhgC7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7//////////////////////////////////////////////////////////////////8AAAAATGF2YzU4LjEzAAAAAAAAAAAAAAAAJAAAAAAAAAAAAYaQyJJIAAAAAAAAAAAAAAAAAAAA//tQZAAP8AAAaQAAAAgAAA0gAAABAAABpAAAACAAADSAAAAETEFNRTMuMTAwVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//tQZB8P8AAAaQAAAAgAAA0gAAABAAABpAAAACAAADSAAAAEVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV'
    };
    
    if (sounds[type]) {
        soundEl.src = sounds[type];
        soundEl.volume = 0.5;
        soundEl.play().catch(() => {});
    }
}

// Update settings toggle UI
function updateSettingsToggles() {
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
    toggle.dataset.enabled = newValue;
    state.settings[settingKey] = newValue;
    
    // Request notification permission if enabling
    if (settingKey === 'notifications' && newValue) {
        requestNotificationPermission();
    }
    
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
