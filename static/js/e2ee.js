// HardChats - End-to-End Encryption Key Exchange
// Requires: state, send from state.js
// Requires: LivekitClient (vendor/livekit-client.umd.js)
// Requires: applySubscriptionsFor from livekit.js (at runtime)
//
// The SFU terminates DTLS, so every audio/video frame is additionally encrypted in the
// browser (LiveKit insertable-streams E2EE, AES-GCM) before it leaves. Each participant
// encrypts with its own random sender key. Keys travel to each peer over the app
// WebSocket sealed with an ECDH (P-256) shared secret between the two browsers, so the
// server and the SFU only ever relay public keys and ciphertext.
//
// Trust level matches the old peer-to-peer mesh: a passive server can't decrypt, but
// the server that relays public keys could substitute its own (MITM) if it were
// actively malicious - there is no out-of-band key verification.
//
// Every participant rotates its sender key whenever someone leaves, so a departed user
// can't decrypt anything sent after they're gone.

const E2EE_KEYRING_SIZE  = 16;   // LiveKit's key index wraps at the keyring size
const E2EE_ROTATE_DELAY  = 1500; // ms between handing out a new key and encrypting with it
const E2EE_HKDF_SALT     = new TextEncoder().encode('hardchats-e2ee-v1');

class HardChatsKeyProvider extends LivekitClient.BaseKeyProvider {
	constructor() {
		// Per-participant keys. No auto-ratcheting and no key invalidation on decrypt
		// failures: frames can briefly arrive before their sender's key does.
		super({ sharedKey: false, ratchetWindowSize: 0, failureTolerance: -1, keyringSize: E2EE_KEYRING_SIZE });
	}

	async setRawKey(identity, raw, keyIndex) {
		const material = await LivekitClient.createKeyMaterialFromBuffer(raw);
		this.onSetEncryptionKey(material, identity, keyIndex);
	}
}

const e2ee = {
	provider: null,
	keyPair: null,
	publicKey: null,      // our raw P-256 public key, base64
	senderKey: null,      // our current raw sender key (Uint8Array, 32 bytes)
	keyIndex: 0,
	wrapKeys: new Map(),  // peer id -> AES-GCM key derived from ECDH with that peer
	haveKey: new Set(),   // peer ids whose sender key we hold (livekit.js only subscribes to these)
	queue: Promise.resolve(), // messages are handled strictly in arrival order (see handleE2EEMessage)
	rotateTimer: null
};

const b64encode = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const b64decode = (str) => Uint8Array.from(atob(str), c => c.charCodeAt(0));

// Fresh identity for a new room session: new ECDH keypair, new sender key at index 0.
// Must run (and finish) before the room connects so our first frames are encrypted.
async function initE2EE() {
	clearTimeout(e2ee.rotateTimer);
	e2ee.provider = new HardChatsKeyProvider();
	e2ee.keyPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
	e2ee.publicKey = b64encode(await crypto.subtle.exportKey('raw', e2ee.keyPair.publicKey));
	e2ee.wrapKeys = new Map();
	e2ee.haveKey = new Set();
	e2ee.keyIndex = 0;
	e2ee.senderKey = crypto.getRandomValues(new Uint8Array(32));
	await e2ee.provider.setRawKey(state.myId, e2ee.senderKey, e2ee.keyIndex);
	return e2ee.provider;
}

// Announce our public key to everyone already in the room.
function announceE2EE() {
	send({ type: 'e2ee', payload: { kind: 'hello', pub: e2ee.publicKey } });
}

async function deriveWrapKey(peerId, peerPub) {
	const pub = await crypto.subtle.importKey('raw', b64decode(peerPub), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
	const secret = await crypto.subtle.deriveBits({ name: 'ECDH', public: pub }, e2ee.keyPair.privateKey, 256);
	const hkdf = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
	const info = new TextEncoder().encode([state.myId, peerId].sort().join('|'));
	return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: E2EE_HKDF_SALT, info }, hkdf, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

// The AAD binds each sealed key to its sender, recipient and key index, so a relayed
// message can't be replayed as coming from someone else or for another slot.
const keyAad = (from, to, index) => new TextEncoder().encode(`${from}>${to}#${index}`);

async function sendSenderKey(peerId) {
	const wrapKey = e2ee.wrapKeys.get(peerId);
	if (!wrapKey) return;
	const index = e2ee.keyIndex;
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: keyAad(state.myId, peerId, index) }, wrapKey, e2ee.senderKey);
	send({ type: 'e2ee', target: peerId, payload: { kind: 'key', index, iv: b64encode(iv), ct: b64encode(ct) } });
}

// A peer's key can arrive while their hello is still being processed (deriving the wrap
// key is async), so messages are chained instead of handled concurrently.
function handleE2EEMessage(from, payload) {
	e2ee.queue = e2ee.queue.then(() => processE2EEMessage(from, payload));
}

async function processE2EEMessage(from, payload) {
	if (!e2ee.keyPair || !payload || from === state.myId) return;
	try {
		if (payload.kind === 'hello') {
			e2ee.wrapKeys.set(from, await deriveWrapKey(from, payload.pub));
			// Answer a newcomer's broadcast hello with our own public key so they can
			// derive the same wrap key, then hand them our current sender key.
			if (!payload.reply) send({ type: 'e2ee', target: from, payload: { kind: 'hello', pub: e2ee.publicKey, reply: true } });
			await sendSenderKey(from);
		} else if (payload.kind === 'key') {
			const wrapKey = e2ee.wrapKeys.get(from);
			if (!wrapKey) return;
			const index = Number(payload.index);
			if (!Number.isInteger(index) || index < 0 || index >= E2EE_KEYRING_SIZE) return;
			const raw = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64decode(payload.iv), additionalData: keyAad(from, state.myId, index) }, wrapKey, b64decode(payload.ct));
			await e2ee.provider.setRawKey(from, raw, index);
			console.log(`[E2EE] Received key #${index} from ${from}`);
			if (!e2ee.haveKey.has(from)) {
				e2ee.haveKey.add(from);
				applySubscriptionsFor(from);
			}
		}
	} catch (e) {
		console.error(`[E2EE] Failed to process ${payload.kind} from ${from}:`, e?.message || e);
	}
}

// Someone left: forget them and rotate our sender key. The new key goes out to everyone
// still here first; we only start encrypting with it after a short delay so it has
// arrived before the first frame that uses it. Several leaves in a row collapse into one.
function rotateE2EEOnLeave(peerId) {
	e2ee.wrapKeys.delete(peerId);
	e2ee.haveKey.delete(peerId);
	if (!e2ee.keyPair) return;
	clearTimeout(e2ee.rotateTimer);
	e2ee.rotateTimer = setTimeout(async () => {
		e2ee.keyIndex = (e2ee.keyIndex + 1) % E2EE_KEYRING_SIZE;
		e2ee.senderKey = crypto.getRandomValues(new Uint8Array(32));
		const index = e2ee.keyIndex, key = e2ee.senderKey;
		await Promise.all([...e2ee.wrapKeys.keys()].map(sendSenderKey));
		setTimeout(() => {
			if (e2ee.keyIndex !== index) return; // superseded by a later rotation
			e2ee.provider.setRawKey(state.myId, key, index);
			console.log(`[E2EE] Rotated to key #${index}`);
		}, E2EE_ROTATE_DELAY);
	}, 250);
}
