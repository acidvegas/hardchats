// HardChats IRC Client
// Config is loaded from /api/config
// Requires: state, $, escapeHtml from client.js

let IRC_CONFIG = null;
let ircCooldownTimer = null;
let ircCooldownRemaining = 0;

const IRC_COOLDOWN_SECONDS = 10;

// Spam control
const IRC_MAX_MESSAGES_PER_SECOND = 3;
let ircMessageTimestamps = [];

// Nick colors (max 100 to prevent memory exhaustion)
const IRC_MAX_NICK_COLORS = 100;
const nickColorCache = new Map();

function getNickColor(nick) {
    // Return cached color if exists
    if (nickColorCache.has(nick)) {
        return nickColorCache.get(nick);
    }
    
    // Generate color from nick hash
    let hash = 0;
    for (let i = 0; i < nick.length; i++) {
        hash = nick.charCodeAt(i) + ((hash << 5) - hash);
    }
    
    // Generate HSL color avoiding dark/black/white
    // Hue: 0-360 (full spectrum)
    // Saturation: 50-90% (vibrant but not neon)
    // Lightness: 45-65% (avoid too dark or too light)
    const hue = Math.abs(hash) % 360;
    const saturation = 50 + (Math.abs(hash >> 8) % 40);  // 50-90%
    const lightness = 45 + (Math.abs(hash >> 16) % 20);  // 45-65%
    
    const color = `hsl(${hue}, ${saturation}%, ${lightness}%)`;
    
    // Evict oldest entry if at capacity
    if (nickColorCache.size >= IRC_MAX_NICK_COLORS) {
        const firstKey = nickColorCache.keys().next().value;
        nickColorCache.delete(firstKey);
    }
    
    nickColorCache.set(nick, color);
    return color;
}

// Load IRC config from server
function loadIrcConfig(serverConfig) {
    IRC_CONFIG = {
        server: serverConfig.irc.server,
        channel: serverConfig.irc.channel,
        protocols: serverConfig.irc.protocols,
        user: serverConfig.irc.user,
        realname: serverConfig.irc.realname,
        maxNickLength: serverConfig.irc.max_nick_length,
        reconnectDelay: serverConfig.irc.reconnect_delay,
        joinDelay: serverConfig.irc.join_delay,
        maxBacklog: serverConfig.irc.max_backlog
    };
    console.log('[IRC] Config loaded:', IRC_CONFIG.server, IRC_CONFIG.channel);
}

const IRC_MAX_MESSAGE_LENGTH = 300;

function initIrcListeners() {
    $('irc-toggle').addEventListener('click', toggleIrcSidebar);
    $('irc-input').addEventListener('keypress', (e) => e.key === 'Enter' && sendIrcMessage());
    $('irc-input').addEventListener('input', updateCharCount);
    $('irc-send').addEventListener('click', sendIrcMessage);
    $('irc-connect').addEventListener('click', handleIrcConnect);
    $('irc-disconnect').addEventListener('click', handleIrcDisconnect);
}

function updateCharCount() {
    const input = $('irc-input');
    const counter = $('irc-char-count');
    const len = input.value.length;
    
    counter.textContent = `${len}/${IRC_MAX_MESSAGE_LENGTH}`;
    counter.classList.remove('warning', 'danger');
    
    if (len >= IRC_MAX_MESSAGE_LENGTH) {
        counter.classList.add('danger');
    } else if (len >= IRC_MAX_MESSAGE_LENGTH * 0.8) {
        counter.classList.add('warning');
    }
}

function toggleIrcSidebar() {
    state.irc.sidebarOpen = !state.irc.sidebarOpen;
    $('irc-sidebar').classList.toggle('collapsed', !state.irc.sidebarOpen);
    $('irc-toggle').classList.toggle('active', state.irc.sidebarOpen);
    
    if (state.irc.sidebarOpen) {
        state.irc.unreadCount = 0;
        updateIrcBadge();
        if (state.irc.connected) {
            $('irc-input').focus();
        }
        scrollIrcToBottom();
    }
}

function handleIrcConnect() {
    const btn = $('irc-connect');
    
    // Check cooldown
    if (btn.disabled || ircCooldownRemaining > 0) return;
    
    // Start cooldown
    startIrcCooldown();
    
    // Connect
    connectIrc();
}

function handleIrcDisconnect() {
    const btn = $('irc-disconnect');
    
    if (btn.disabled) return;
    
    // Mark as intentional disconnect to prevent error messages
    state.irc.intentionalDisconnect = true;
    
    // Disconnect
    disconnectIrc();
    
    // Clear chat history
    $('irc-messages').innerHTML = '';
    
    // Collapse sidebar
    state.irc.sidebarOpen = false;
    $('irc-sidebar').classList.add('collapsed');
    $('irc-toggle').classList.remove('active');
    state.irc.unreadCount = 0;
    updateIrcBadge();
    
    // Reset char counter
    $('irc-input').value = '';
    updateCharCount();
    
    // Update button visibility
    updateIrcButtons();
}

function startIrcCooldown() {
    const btn = $('irc-connect');
    ircCooldownRemaining = IRC_COOLDOWN_SECONDS;
    
    btn.disabled = true;
    btn.classList.add('cooldown');
    btn.setAttribute('data-cooldown', ircCooldownRemaining);
    
    ircCooldownTimer = setInterval(() => {
        ircCooldownRemaining--;
        
        if (ircCooldownRemaining <= 0) {
            clearInterval(ircCooldownTimer);
            ircCooldownTimer = null;
            btn.disabled = false;
            btn.classList.remove('cooldown');
            btn.removeAttribute('data-cooldown');
        } else {
            btn.setAttribute('data-cooldown', ircCooldownRemaining);
        }
    }, 1000);
}

function updateIrcButtons() {
    const connectBtn = $('irc-connect');
    const disconnectBtn = $('irc-disconnect');
    
    if (state.irc.connected || state.irc.ws) {
        connectBtn.classList.add('hidden');
        disconnectBtn.classList.remove('hidden');
    } else {
        connectBtn.classList.remove('hidden');
        disconnectBtn.classList.add('hidden');
    }
}

function connectIrc() {
    if (state.irc.ws) return;
    if (!IRC_CONFIG) {
        console.error('[IRC] Config not loaded!');
        return;
    }
    
    // Sanitize nickname for IRC (alphanumeric, max length from config)
    let nick = state.username.replace(/[^a-zA-Z0-9_\-\[\]\\^{}|`]/g, '');
    if (!nick || nick.length === 0) nick = 'User';
    nick = nick.substring(0, IRC_CONFIG.maxNickLength);
    state.irc.nick = nick;
    
    updateIrcStatus('connecting');
    updateIrcButtons();
    addIrcMessage('system', `Connecting to ${IRC_CONFIG.server.replace('wss://', '')}...`);
    
    try {
        console.log('[IRC] Attempting WebSocket connection...');
        console.log('[IRC] URL:', IRC_CONFIG.server);
        console.log('[IRC] Subprotocols:', IRC_CONFIG.protocols);
        
        state.irc.ws = new WebSocket(IRC_CONFIG.server, IRC_CONFIG.protocols);
        
        state.irc.ws.onopen = () => {
            console.log('[IRC] WebSocket connected successfully');
            console.log('[IRC] Protocol selected:', state.irc.ws.protocol);
            // Send IRC registration
            ircSend(`NICK ${state.irc.nick}`);
            ircSend(`USER ${IRC_CONFIG.user} 0 * :${IRC_CONFIG.realname}`);
        };
        
        state.irc.ws.onmessage = (e) => {
            // IRCv3 WebSocket: each message is a single IRC line (no \r\n)
            // But handle both cases for compatibility
            const lines = e.data.split(/\r?\n/).filter(line => line.length > 0);
            lines.forEach(handleIrcMessage);
        };
        
        state.irc.ws.onclose = (e) => {
            console.log('[IRC] WebSocket closed');
            console.log('[IRC] Close code:', e.code);
            console.log('[IRC] Close reason:', e.reason || '(none provided)');
            console.log('[IRC] Clean close:', e.wasClean);
            
            state.irc.connected = false;
            state.irc.ws = null;
            updateIrcStatus('disconnected');
            updateIrcButtons();
            $('irc-input').disabled = true;
            $('irc-send').disabled = true;
            
            // Don't show messages if intentional disconnect
            if (state.irc.intentionalDisconnect) {
                state.irc.intentionalDisconnect = false;
                return;
            }
            
            // More descriptive disconnect messages
            let msg = 'Disconnected from IRC';
            if (e.code === 1006) {
                msg = 'Connection failed - check if server supports WebSocket on this port';
            } else if (e.code === 1015) {
                msg = 'TLS handshake failed - certificate issue';
            } else if (e.reason) {
                msg = `Disconnected: ${e.reason}`;
            }
            addIrcMessage('system', msg);
        };
        
        state.irc.ws.onerror = (err) => {
            console.error('[IRC] WebSocket error event fired');
            console.error('[IRC] Error object:', err);
            console.error('[IRC] WebSocket readyState:', state.irc.ws?.readyState);
            // Don't show error if intentional disconnect
            if (!state.irc.intentionalDisconnect) {
                addIrcMessage('error', 'Connection error - see browser console (F12) for details');
            }
        };
        
    } catch (err) {
        console.error('[IRC] Connection exception:', err);
        console.error('[IRC] Error name:', err.name);
        console.error('[IRC] Error message:', err.message);
        console.error('[IRC] Error stack:', err.stack);
        addIrcMessage('error', `Failed to connect: ${err.message}`);
        updateIrcStatus('disconnected');
        updateIrcButtons();
    }
}

function ircSend(data) {
    if (state.irc.ws && state.irc.ws.readyState === WebSocket.OPEN) {
        state.irc.ws.send(data);
        console.log('[IRC] >', data);
    }
}

function handleIrcMessage(line) {
    console.log('[IRC] <', line);
    
    // Handle PING - must echo back the exact token
    // Format: PING :token or PING token
    if (line.startsWith('PING ') || line === 'PING') {
        const token = line.substring(5); // Everything after "PING "
        ircSend(`PONG ${token}`);
        return;
    }
    
    // Ignore PONG responses (from our keepalive pings)
    if (line.startsWith('PONG ') || line === 'PONG') {
        return;
    }
    
    // Parse IRC message
    let prefix = '', command = '', params = [];
    let idx = 0;
    
    if (line.startsWith(':')) {
        idx = line.indexOf(' ');
        prefix = line.substring(1, idx);
        line = line.substring(idx + 1);
    }
    
    if (line.includes(' :')) {
        const trailIdx = line.indexOf(' :');
        const beforeTrail = line.substring(0, trailIdx);
        const trailing = line.substring(trailIdx + 2);
        const parts = beforeTrail.split(' ');
        command = parts[0];
        params = parts.slice(1);
        params.push(trailing);
    } else {
        const parts = line.split(' ');
        command = parts[0];
        params = parts.slice(1);
    }
    
    // Extract nick from prefix
    const nick = prefix.split('!')[0];
    
    switch (command) {
        case '001': // RPL_WELCOME - Successfully registered
            state.irc.connected = true;
            updateIrcStatus('connected');
            updateIrcButtons();
            addIrcMessage('system', `Connected as ${state.irc.nick}`);
            // Wait before joining channel (server may auto-join elsewhere)
            setTimeout(() => {
                if (state.irc.connected) {
                    ircSend(`JOIN ${IRC_CONFIG.channel}`);
                }
            }, IRC_CONFIG.joinDelay);
            break;
            
        case '433': // ERR_NICKNAMEINUSE
            // Add 4 random digits, truncate base nick to fit within max length
            const baseNick = state.irc.nick.replace(/\d{4}$/, '').substring(0, IRC_CONFIG.maxNickLength - 4);
            const suffix = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
            state.irc.nick = baseNick + suffix;
            addIrcMessage('system', `Nick in use, trying ${state.irc.nick}`);
            ircSend(`NICK ${state.irc.nick}`);
            break;
            
        case 'JOIN':
            if (nick === state.irc.nick) {
                const joinedChannel = params[0].replace(':', '');
                // Auto-part from #blackhole if server auto-joined us there
                if (joinedChannel.toLowerCase() === '#blackhole') {
                    ircSend('PART #blackhole');
                    break;
                }
                if (joinedChannel.toLowerCase() === IRC_CONFIG.channel.toLowerCase()) {
                    addIrcMessage('system', `Joined ${IRC_CONFIG.channel}`);
                    $('irc-input').disabled = false;
                    $('irc-send').disabled = false;
                }
            }
            // We don't show other users' join messages
            break;
            
        case 'PRIVMSG':
            const target = params[0];
            const message = params[1];
            if (target.toLowerCase() === IRC_CONFIG.channel.toLowerCase()) {
                const isSelf = nick === state.irc.nick;
                addIrcMessage('chat', message, nick, isSelf);
                
                // Update unread count if sidebar is closed
                if (!state.irc.sidebarOpen && !isSelf) {
                    state.irc.unreadCount++;
                    updateIrcBadge();
                }
            }
            break;
            
        case 'NOTICE':
            // Show notices but not server spam
            if (params[1] && !params[1].includes('Looking up your hostname')) {
                addIrcMessage('system', params[1]);
            }
            break;
            
        case 'KICK':
            // params[0] = channel, params[1] = kicked nick, params[2] = reason
            if (params[1] === state.irc.nick) {
                const kickChannel = params[0];
                const kickReason = params[2] || 'No reason';
                addIrcMessage('system', `Kicked from ${kickChannel}: ${kickReason}`);
                $('irc-input').disabled = true;
                $('irc-send').disabled = true;
                
                // Auto-rejoin after 3 seconds
                if (kickChannel.toLowerCase() === IRC_CONFIG.channel.toLowerCase()) {
                    addIrcMessage('system', 'Rejoining in 3 seconds...');
                    setTimeout(() => {
                        if (state.irc.connected) {
                            ircSend(`JOIN ${IRC_CONFIG.channel}`);
                        }
                    }, 3000);
                }
            }
            break;
            
        case 'INVITE':
            // params[0] = our nick, params[1] = channel
            const inviteChannel = params[1];
            addIrcMessage('system', `Invited to ${inviteChannel} by ${nick}`);
            // Auto-join if invited
            if (state.irc.connected) {
                ircSend(`JOIN ${inviteChannel}`);
            }
            break;
            
        case 'ERROR':
            addIrcMessage('error', params[0] || 'Connection error');
            break;
            
        // Ignore PART, QUIT, MODE, etc.
    }
}

function linkifyText(text) {
    // Escape HTML first, then linkify URLs
    const escaped = escapeHtml(text);
    // Match http:// and https:// URLs
    const urlRegex = /(https?:\/\/[^\s<>&"']+)/gi;
    return escaped.replace(urlRegex, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
}

function addIrcMessage(type, text, nick = null, isSelf = false) {
    const container = $('irc-messages');
    const msg = document.createElement('div');
    msg.className = `irc-msg ${type}`;
    
    const time = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
    
    if (type === 'chat' && nick) {
        const nickColor = isSelf ? 'var(--acid)' : getNickColor(nick);
        msg.innerHTML = `<span class="timestamp">${time}</span><span class="nick" style="color: ${nickColor}">&lt;${escapeHtml(nick)}&gt;</span> ${linkifyText(text)}`;
    } else {
        msg.innerHTML = `<span class="timestamp">${time}</span>${linkifyText(text)}`;
    }
    
    container.appendChild(msg);
    scrollIrcToBottom();
    
    // Limit message history
    while (container.children.length > (IRC_CONFIG?.maxBacklog || 5000)) {
        container.removeChild(container.firstChild);
    }
}

function scrollIrcToBottom() {
    const container = $('irc-messages');
    container.scrollTop = container.scrollHeight;
}

function sendIrcMessage() {
    const input = $('irc-input');
    const message = input.value.trim();
    
    if (!message || !state.irc.connected || !IRC_CONFIG) return;
    
    // Spam control - check if sending too fast
    const now = Date.now();
    
    // Remove timestamps older than 1 second
    ircMessageTimestamps = ircMessageTimestamps.filter(ts => now - ts < 1000);
    
    // Check if at limit
    if (ircMessageTimestamps.length >= IRC_MAX_MESSAGES_PER_SECOND) {
        addIrcMessage('error', 'SLOW DOWN NERD');
        return;
    }
    
    // Record this message timestamp
    ircMessageTimestamps.push(now);
    
    ircSend(`PRIVMSG ${IRC_CONFIG.channel} :${message}`);
    addIrcMessage('chat', message, state.irc.nick, true);
    input.value = '';
}

function updateIrcStatus(status) {
    const el = $('irc-status');
    el.textContent = status;
    el.className = `irc-status ${status}`;
}

function updateIrcBadge() {
    const badge = document.querySelector('.irc-badge');
    if (state.irc.unreadCount > 0) {
        badge.textContent = state.irc.unreadCount > 99 ? '99+' : state.irc.unreadCount;
        badge.classList.remove('hidden');
    } else {
        badge.classList.add('hidden');
    }
}

function disconnectIrc() {
    if (state.irc.ws) {
        if (state.irc.connected) {
            ircSend('QUIT :Leaving HardChats');
        }
        state.irc.ws.close();
        state.irc.ws = null;
        state.irc.connected = false;
    }
    updateIrcStatus('disconnected');
    updateIrcButtons();
    $('irc-input').disabled = true;
    $('irc-send').disabled = true;
}
