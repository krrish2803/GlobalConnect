import {
    AreaCode,
    DirectChannelIdentifier,
    LogLevel,
    NCEngine
} from '@nexconn/chat';
import { ChatUIEvents, NCChatUIApplication } from '@nexconn/chatui';

let chatUI = null;
let sdkInitialized = false;
let connectedUserId = null;
let currentOrderId = null;
let openingPromise = null;
const mirroredMessageIds = new Set();

const statusElement = () => document.getElementById('nexconnStatus');
const setStatus = (message, state = 'idle') => {
    const element = statusElement();
    if (!element) return;
    element.textContent = message;
    element.dataset.state = state;
};

async function loadProfiles(userIds) {
    if (!currentOrderId || !userIds.length) return [];
    const params = new URLSearchParams({ orderId: currentOrderId, users: userIds.join(',') });
    const response = await fetch(`/api/nexconn/profiles?${params}`, {
        credentials: 'same-origin',
        cache: 'no-store'
    });
    if (!response.ok) return userIds.map(userId => ({ userId, name: `Marketplace user ${userId.slice(-6)}` }));
    const profiles = await response.json();
    const known = new Map(profiles.map(profile => [profile.userId, profile]));
    return userIds.map(userId => known.get(userId) || ({ userId, name: `Marketplace user ${userId.slice(-6)}` }));
}

const hooks = {
    reqUserProfiles: loadProfiles,
    reqGroupProfiles: async groupIds => groupIds.map(groupId => ({ groupId, name: `Order ${groupId}` })),
    reqSystemProfiles: async targetIds => targetIds.map(targetId => ({ targetId, name: 'GlobalConnect' })),
    reqGroupMembers: async () => []
};

function initializeChatUI() {
    if (sdkInitialized) return;
    const mount = document.getElementById('nexconnChatMount');
    if (!mount) throw new Error('The Nexconn Chat panel is not available.');

    NCEngine.initialize({
        appKey: window.NEXCONN_APP_KEY,
        areaCode: AreaCode.SG,
        // Explicitly target the Singapore navigation service for this app.
        // Without this, the SDK may use automatic region discovery and never
        // receive the correct bootstrap configuration in restricted networks.
        naviServer: 'https://nav.sg-light-edge.com',
        logLevel: LogLevel.WARN
    });

    chatUI = NCChatUIApplication.initialize({ hooks, language: 'en_US', logLevel: LogLevel.WARN });
    if (!chatUI) throw new Error('Nexconn Chat UI could not initialize.');
    // The host app already has an order conversation rail. Give the active
    // conversation the full popup width so the SDK's channel list cannot
    // squeeze the message history and composer into half of the window.
    chatUI.setChannelBarSwitch(false);
    chatUI.setChannelDetailBackSwitch(false);
    chatUI.addEventListener(ChatUIEvents.MESSAGE_WILL_SEND, event => {
        const content = event?.data?.params?.content;
        if (!content) return;
        const originalText = String(content.text || '');
        const safeText = redactBeforeNexconnSend(originalText);
        content.text = safeText.text;
        content.extra = JSON.stringify({
            orderId: currentOrderId,
            product: 'GlobalConnect',
            contactRedacted: safeText.changed
        });
    });
    chatUI.addEventListener(ChatUIEvents.RECV_NEW_MESSAGES, event => {
        mirrorNexconnMessages(event?.data, 'received');
    });
    chatUI.addEventListener(ChatUIEvents.MESSAGE_STATE_CHANGE, event => {
        mirrorNexconnMessages(event?.data, 'sent');
    });
    chatUI.ready();

    const provider = document.createElement('nc-chat-ui-app-provider');
    provider.style.width = '100%';
    provider.style.height = '100%';
    mount.replaceChildren(provider);
    sdkInitialized = true;
}

function checkChatBrowserSupport() {
    if (!window.isSecureContext || !window.crypto?.subtle) {
        throw new Error('Nexconn Chat needs a secure browser context. Open GlobalConnect at localhost or an HTTPS address.');
    }

    try {
        // Safari can throw "The operation is insecure" when site storage is
        // disabled. Nexconn uses browser storage during SDK initialization.
        const storage = window.localStorage;
        const key = '__globalconnect_nexconn_storage_check__';
        const previous = storage.getItem(key);
        storage.setItem(key, 'ok');
        if (previous === null) storage.removeItem(key);
        else storage.setItem(key, previous);
    } catch (_) {
        throw new Error('Safari is blocking site storage for this page. Allow website data/cookies for localhost, then reload and reopen Nexconn Chat.');
    }
}

function redactBeforeNexconnSend(value) {
    let text = String(value || '');
    const original = text;
    text = text.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[REDACTED EMAIL]');
    text = text.replace(/\b(whatsapp|telegram|wechat|paypal|venmo|cashapp|zelle|wire transfer)\b/gi, '[OFF-PLATFORM CHANNEL REDACTED]');
    // Catch common international phone formats before they reach Nexconn.
    text = text.replace(/(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?)\d{3,4}[\s.-]?\d{3,4}/g, '[REDACTED PHONE]');
    return { text, changed: text !== original };
}

function messageExtra(message) {
    const raw = message?.content?.extra;
    if (!raw) return {};
    if (typeof raw === 'object') return raw;
    try { return JSON.parse(raw); } catch (_) { return {}; }
}

function mirrorNexconnMessages(models, direction) {
    const batch = Array.isArray(models) ? models : models ? [models] : [];
    for (const model of batch) {
        const message = model?.message || model;
        const content = model?.content || message?.content || {};
        const messageType = String(model?.messageType || message?.messageType || '');
        const text = String(content.text || '');
        const senderUserId = String(model?.senderUserId || message?.senderUserId || '');
        const messageId = String(model?.messageId || message?.messageId || model?.clientId || '');
        const extra = messageExtra(message);
        const orderId = String(extra.orderId || '');

        if (!text.trim() || !messageId || !orderId || !messageType.includes('TxtMsg')) continue;
        if (direction === 'sent') {
            const status = model?.sentStatus ?? message?.sentStatus;
            if (senderUserId !== connectedUserId || ![30, 50, 'SENT', 'READ'].includes(status)) continue;
        }
        const localKey = `${orderId}:${messageId}`;
        if (mirroredMessageIds.has(localKey)) continue;
        mirroredMessageIds.add(localKey);
        if (mirroredMessageIds.size > 500) mirroredMessageIds.clear();

        fetch(`/api/channels/${encodeURIComponent(orderId)}/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({
                text,
                externalMessageId: messageId,
                externalSenderId: senderUserId,
                preMasked: Boolean(extra.contactRedacted)
            })
        }).then(async response => {
            if (!response.ok) {
                const error = await response.json().catch(() => ({}));
                console.warn('[GlobalConnect translation mirror]', error.error || response.status);
                mirroredMessageIds.delete(localKey);
            }
        }).catch(error => {
            mirroredMessageIds.delete(localKey);
            console.warn('[GlobalConnect translation mirror]', error.message);
        });
    }
}

async function openOrder(orderId) {
    currentOrderId = orderId;
    if (openingPromise) return openingPromise;
    openingPromise = (async () => {
        let connectionStep = 'Preparing the conversation';
        setStatus('Connecting to Nexconn…', 'connecting');
        try {
            connectionStep = 'Checking Safari security and storage';
            checkChatBrowserSupport();

            connectionStep = 'Requesting a Nexconn chat session';
            const response = await fetch(`/api/nexconn/chat-session?orderId=${encodeURIComponent(orderId)}`, {
                credentials: 'same-origin',
                cache: 'no-store'
            });
            const identity = await response.json();
            if (!response.ok) throw new Error(identity.error || 'Could not prepare the Nexconn conversation.');

            window.NEXCONN_APP_KEY = identity.appKey;
            connectionStep = 'Initializing Nexconn Chat';
            initializeChatUI();

            if (connectedUserId !== identity.userId) {
                connectionStep = 'Connecting to Nexconn Singapore';
                let connectionTimeout;
                const connection = await Promise.race([
                    NCEngine.connect({ token: identity.token }),
                    new Promise((_, reject) => {
                        connectionTimeout = setTimeout(() => reject(new Error(
                            'Nexconn did not respond in 20 seconds. Check your network or Singapore chat endpoint.'
                        )), 20000);
                    })
                ]).finally(() => clearTimeout(connectionTimeout));
                if (!connection.isOk) throw new Error(`Nexconn connection failed (${connection.code}).`);
                connectedUserId = identity.userId;
            }

            connectionStep = 'Opening the order conversation';
            let opened = await chatUI.openChannel(new DirectChannelIdentifier(identity.peer.userId), true);
            if (!opened.isOk && opened.code === 39005) {
                setStatus('Syncing conversations…', 'connecting');
                await new Promise(resolve => setTimeout(resolve, 900));
                opened = await chatUI.openChannel(new DirectChannelIdentifier(identity.peer.userId), true);
            }
            if (!opened.isOk) throw new Error(`Could not open this conversation (${opened.code}).`);
            setStatus(`Connected · ${identity.peer.name}`, 'connected');
        } catch (error) {
            console.error('[Nexconn Chat]', error);
            setStatus(`${connectionStep}: ${error.message || 'Nexconn Chat could not connect.'}`, 'error');
        } finally {
            openingPromise = null;
        }
    })();
    return openingPromise;
}

window.globalConnectNexconn = {
    openOrder,
    setOrder(orderId) {
        currentOrderId = orderId;
        if (document.getElementById('chatColumn')?.classList.contains('nexconn-mode')) openOrder(orderId);
    }
};

const initialOrder = document.documentElement.dataset.activeOrderId;
if (initialOrder) window.globalConnectNexconn.setOrder(initialOrder);

window.addEventListener('beforeunload', () => chatUI?.destroy(), { once: true });
