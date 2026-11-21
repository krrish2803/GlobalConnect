/**
 * GlobalConnect — HTTP API gateway & static server
 *
 * Thin routing layer over src/ modules:
 *   auth       — signup/login/sessions (src/auth.js)
 *   nexconn    — chat token + conversation identity (src/nexconn.js)
 *   translation— OpenAI + corpus pipeline (src/translation.js)
 *   moderation — contact masking guard (src/moderation.js)
 *   escrow     — mock-funds lifecycle with production controls (src/escrow.js)
 *   disputes   — case history, evidence, mediation (src/disputes.js)
 *   metrics    — live KPIs (src/metrics.js)
 *   security   — rate limits, headers, audit (src/security.js)
 *   store      — SQLite persistence (src/store.js)
 */

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

// Load local development secrets before requiring modules that read process.env.
// Existing shell/production variables always take precedence over .env values.
try {
    const envPath = path.join(__dirname, '.env');
    if (fs.existsSync(envPath)) {
        for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const separator = trimmed.indexOf('=');
            if (separator < 1) continue;
            const key = trimmed.slice(0, separator).trim();
            const value = trimmed.slice(separator + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
            if (key && process.env[key] === undefined) process.env[key] = value;
        }
    }
} catch (error) {
    console.warn('[Environment] Could not load local .env file:', error.message);
}

const db = require('./src/db');
const store = require('./src/store');
const auth = require('./src/auth');
const security = require('./src/security');
const moderation = require('./src/moderation');
const nexconn = require('./src/nexconn');
const escrow = require('./src/escrow');
const metrics = require('./src/metrics');

// Opened at module load so `require('./server.js')` (tests) shares one store
db.openDatabase();

// Lazy module loaders — translation/disputes are heavy and independently tested
let translationModule = null;
function translations() {
    if (!translationModule) translationModule = require('./src/translation');
    return translationModule;
}
let disputesModule = null;
function disputes() {
    if (!disputesModule) disputesModule = require('./src/disputes');
    return disputesModule;
}

const PORT = Number(process.env.PORT || 3000);
const WEBHOOK_SECRET = (process.env.NEXCONN_WEBHOOK_SECRET || '').trim();
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const DEMO_LOGIN_DISABLED = IS_PRODUCTION || process.env.DISABLE_DEMO_LOGIN === 'true';
const EVIDENCE_DIR = path.join(__dirname, 'uploads', 'evidence');
const MAX_EVIDENCE_BYTES = 5 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function sendJson(res, statusCode, data, extraHeaders = {}) {
    const jsonStr = JSON.stringify(data, null, 2);
    res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-nexconn-signature',
        'Cache-Control': 'no-store',
        ...extraHeaders
    });
    res.end(jsonStr);
}

function parseJsonBody(req, maxBytes = 1e6) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => {
            body += chunk;
            if (body.length > maxBytes) {
                req.destroy();
                reject(Object.assign(new Error('Payload too large'), { statusCode: 413 }));
            }
        });
        req.on('end', () => {
            if (!body) return resolve({});
            try { resolve(JSON.parse(body)); }
            catch (_) { reject(Object.assign(new Error('Invalid JSON'), { statusCode: 400 })); }
        });
        req.on('error', reject);
    });
}

function query(req) {
    return new URL(req.url, 'http://localhost').searchParams;
}

function pathSegments(pathname) {
    return pathname.split('/').filter(Boolean);
}

// ---------------------------------------------------------------------------
// Real-time SSE channels
// ---------------------------------------------------------------------------

const sseClientsByChannel = new Map();

function broadcastToChannel(orderId, eventType, data) {
    const clients = sseClientsByChannel.get(orderId);
    if (!clients || clients.size === 0) return;
    const message = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const clientRes of clients) {
        try { clientRes.write(message); }
        catch (_) { clients.delete(clientRes); }
    }
}

escrow.init({ broadcast: broadcastToChannel });

function closeAllSseClients() {
    for (const clients of sseClientsByChannel.values()) {
        for (const res of clients) {
            try { res.end(); } catch (_) { /* already closed */ }
        }
    }
    sseClientsByChannel.clear();
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function handleAuth(req, res, pathname) {
    // --- signup ---
    if (req.method === 'POST' && pathname === '/api/auth/signup') {
        if (security.enforce(req, res, 'auth', sendJson)) return true;

        const body = await parseJsonBody(req);
        const name = String(body.name || '').trim();
        const email = String(body.email || '').trim().toLowerCase();
        const password = String(body.password || '');
        const role = String(body.role || 'buyer').toLowerCase();

        if (name.length < 2 || name.length > 80) {
            sendJson(res, 400, { error: 'Enter a name between 2 and 80 characters.' }); return true;
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
            sendJson(res, 400, { error: 'Enter a valid email address.' }); return true;
        }
        if (password.length < 8 || password.length > 128) {
            sendJson(res, 400, { error: 'Password must be between 8 and 128 characters.' }); return true;
        }
        if (!['buyer', 'seller'].includes(role)) {
            sendJson(res, 400, { error: 'Self-service accounts can use the buyer or seller role. Support access is assigned separately.' }); return true;
        }
        if (store.getUserByEmail(email)) {
            sendJson(res, 409, { error: 'An account with that email already exists. Sign in instead.' }); return true;
        }

        const credentials = await auth.hashPassword(password);
        const user = store.createUser({
            name, email, role,
            lang: role === 'buyer' ? 'ar' : 'en',
            trustScore: 100,
            demoOrderIds: ['GC-9821'],
            passwordSalt: credentials.salt,
            passwordHash: credentials.hash
        });

        const safeUser = auth.startSession(req, res, user);
        security.audit(req, 'AUTH_SIGNUP', { actor: safeUser, targetType: 'user', targetId: safeUser.id });
        sendJson(res, 201, { success: true, user: safeUser, prototype: true });
        return true;
    }

    // --- one-click demo persona ---
    if (req.method === 'POST' && pathname === '/api/auth/demo-login') {
        if (DEMO_LOGIN_DISABLED) {
            sendJson(res, 404, { error: 'Demo persona sign-in is disabled.' }); return true;
        }
        if (security.enforce(req, res, 'auth', sendJson)) return true;

        const body = await parseJsonBody(req);
        const targetRole = String(body.role || 'buyer').trim().toLowerCase();
        const demoUsers = { buyer: 'buyer_dubai_12', seller: 'seller_milan_88', agent: 'agent_support_01' };
        const user = store.getUserById(demoUsers[targetRole]);
        if (!user) {
            sendJson(res, 404, { error: `No demonstration persona found for role '${targetRole}'.` }); return true;
        }
        const safeUser = auth.startSession(req, res, user);
        security.audit(req, 'AUTH_DEMO_LOGIN', { actor: safeUser, targetType: 'user', targetId: safeUser.id });
        sendJson(res, 200, { success: true, user: safeUser, prototype: true });
        return true;
    }

    // --- login ---
    if (req.method === 'POST' && pathname === '/api/auth/login') {
        if (security.enforce(req, res, 'auth', sendJson)) return true;

        const body = await parseJsonBody(req);
        const email = String(body.email || '').trim().toLowerCase();
        const password = String(body.password || '');
        const user = store.getUserByEmail(email);

        const ok = user && await auth.verifyPassword(password, user.password_salt, user.password_hash);
        if (!ok) {
            security.audit(req, 'AUTH_LOGIN_FAILED', { targetType: 'email', targetId: email, severity: 'WARN' });
            sendJson(res, 401, { error: 'Email or password is incorrect.' }); return true;
        }

        const safeUser = auth.startSession(req, res, user);
        security.audit(req, 'AUTH_LOGIN', { actor: safeUser, targetType: 'user', targetId: safeUser.id });
        sendJson(res, 200, { success: true, user: safeUser, prototype: true });
        return true;
    }

    // --- session state ---
    if (req.method === 'GET' && pathname === '/api/auth/me') {
        const user = auth.getSessionUser(req);
        if (!user) { sendJson(res, 401, { error: 'Sign in to continue.' }); return true; }
        sendJson(res, 200, { user, prototype: true });
        return true;
    }

    if (req.method === 'POST' && pathname === '/api/auth/logout') {
        const user = auth.getSessionUser(req);
        auth.endSession(req, res);
        if (user) security.audit(req, 'AUTH_LOGOUT', { actor: user, targetType: 'user', targetId: user.id });
        sendJson(res, 200, { success: true });
        return true;
    }

    if (req.method === 'GET' && pathname === '/api/auth/demo-login/status') {
        sendJson(res, 200, { enabled: !DEMO_LOGIN_DISABLED });
        return true;
    }

    return false;
}

async function handleNexconn(req, res, pathname, user) {
    if (req.method === 'POST' && pathname === '/api/auth/token') {
        if (!user) { sendJson(res, 401, { error: 'Sign in to request a chat token.' }); return true; }
        if (security.enforce(req, res, 'general', sendJson)) return true;
        try {
            const identity = await nexconn.issueToken(user);
            security.audit(req, 'NEXCONN_TOKEN_ISSUED', { actor: user, targetType: 'user', targetId: user.id });
            sendJson(res, 200, identity, { 'Cache-Control': 'no-store' });
        } catch (error) {
            sendJson(res, error.statusCode || 502, { error: error.message || 'Nexconn token issuance failed.' });
        }
        return true;
    }

    if (req.method === 'GET' && pathname === '/api/nexconn/chat-session') {
        if (!user) { sendJson(res, 401, { error: 'Sign in to open Nexconn Chat.' }); return true; }
        const orderId = query(req).get('orderId') || '';
        const order = store.getOrder(orderId);
        if (!order || !store.canAccessOrder(user, orderId)) {
            sendJson(res, 403, { error: 'You do not have access to this order conversation.' }); return true;
        }
        try {
            const payload = await nexconn.buildChatSession(user, order);
            sendJson(res, 200, payload, { 'Cache-Control': 'no-store' });
        } catch (error) {
            sendJson(res, error.statusCode || 502, { error: error.message || 'Nexconn connection setup failed.' });
        }
        return true;
    }

    if (req.method === 'GET' && pathname === '/api/nexconn/profiles') {
        if (!user) { sendJson(res, 401, { error: 'Sign in to load chat profiles.' }); return true; }
        const params = query(req);
        const orderId = params.get('orderId') || '';
        const order = store.getOrder(orderId);
        if (!order || !store.canAccessOrder(user, orderId)) {
            sendJson(res, 403, { error: 'You do not have access to these chat profiles.' }); return true;
        }
        sendJson(res, 200, nexconn.buildProfiles(order, params.get('users')));
        return true;
    }

    return false;
}

async function handleWorkspace(req, res, pathname, user) {
    // ---------- translation ----------
    if (req.method === 'POST' && pathname === '/api/translate') {
        if (security.enforce(req, res, 'translate', sendJson)) return true;
        const body = await parseJsonBody(req);
        const { text, sourceLang = 'en', targetLang = 'ar', culturalContext = true, orderId = null } = body;
        if (!text) { sendJson(res, 400, { error: 'Text field is required' }); return true; }

        const result = await translations().translate(text, sourceLang, targetLang, {
            culturalContext: Boolean(culturalContext),
            orderId
        });
        sendJson(res, 200, result);
        return true;
    }

    // ---------- moderation ----------
    if (req.method === 'POST' && pathname === '/api/moderate') {
        if (security.enforce(req, res, 'general', sendJson)) return true;
        const body = await parseJsonBody(req);
        if (!body.text) { sendJson(res, 400, { error: 'Text field is required' }); return true; }
        sendJson(res, 200, moderation.moderateText(body.text));
        return true;
    }

    // ---------- order channels (SSE + history + post) ----------
    if (pathname.startsWith('/api/channels/')) {
        const segments = pathSegments(pathname);
        const orderId = segments[2] || '';
        const action = segments[3] || '';

        if (!store.getOrder(orderId)) {
            sendJson(res, 404, { error: `Order ${orderId} not found` }); return true;
        }
        if (!store.canAccessOrder(user, orderId)) {
            sendJson(res, 403, { error: 'You do not have access to this order channel.' }); return true;
        }

        if (req.method === 'GET' && action === 'stream') {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache, no-transform',
                'Connection': 'keep-alive',
                'Access-Control-Allow-Origin': '*'
            });
            res.write(`event: connected\ndata: ${JSON.stringify({ orderId, status: 'listening', timestamp: new Date().toISOString() })}\n\n`);

            if (!sseClientsByChannel.has(orderId)) sseClientsByChannel.set(orderId, new Set());
            const channelSet = sseClientsByChannel.get(orderId);
            channelSet.add(res);

            const keepAlive = setInterval(() => {
                try { res.write(': keepalive\n\n'); } catch (_) { clearInterval(keepAlive); }
            }, 20_000);
            req.on('close', () => {
                clearInterval(keepAlive);
                channelSet.delete(res);
            });
            return;
        }

        if (req.method === 'GET' && action === 'messages') {
            sendJson(res, 200, { orderId, messages: store.listMessages(orderId) });
            return true;
        }

        if (req.method === 'POST' && action === 'messages') {
            if (security.enforce(req, res, 'write', sendJson)) return true;
            const body = await parseJsonBody(req);
            const text = String(body.text || '').trim();
            if (!text) { sendJson(res, 400, { error: 'Text field is required' }); return true; }

            // Nexconn text messages are mirrored here so the same moderation,
            // translation, persistence, and SSE pipeline powers the preview.
            // Stable IDs make simultaneous sender/recipient mirrors idempotent.
            const externalMessageId = String(body.externalMessageId || '').trim().slice(0, 180);
            let sender = user;
            let messageId;
            if (externalMessageId) {
                const order = store.getOrder(orderId);
                const participants = [order.buyerId, order.sellerId]
                    .map(id => store.getUserById(id)).filter(Boolean);
                const externalSenderId = String(body.externalSenderId || '');
                sender = participants.find(participant => nexconn.nexconnUserId(participant) === externalSenderId);
                if (!sender) {
                    sendJson(res, 403, { error: 'This Nexconn message sender is not part of the order.' }); return true;
                }
                messageId = `nex_${crypto.createHash('sha256').update(`${orderId}:${externalMessageId}`).digest('hex').slice(0, 48)}`;
                const existing = store.getMessageById(messageId);
                if (existing) { sendJson(res, 200, { success: true, duplicate: true, message: existing }); return true; }
            }

            const detected = moderation.moderateText(text, orderId);
            const modResult = body.preMasked ? {
                ...detected,
                isClean: false,
                isMasked: true,
                violationsBlocked: [...new Set([...detected.violationsBlocked, 'CONTACT_REDACTED_BEFORE_SEND'])]
            } : detected;
            const isSenderBuyer = sender.role === 'buyer';

            // Per-order language routing (buyer's language → seller's language)
            const languageRoutes = {
                'GC-9821': ['ar', 'en'],
                'GC-7740': ['de', 'en'],
                'GC-6102': ['ja', 'en']
            };
            const [buyerLang, sellerLang] = languageRoutes[orderId] || ['ar', 'en'];
            const defaultSourceLang = isSenderBuyer ? buyerLang : sellerLang;
            const defaultTargetLang = isSenderBuyer ? sellerLang : buyerLang;
            const sourceLang = body.sourceLang || defaultSourceLang;
            const targetLang = body.targetLang || defaultTargetLang;

            let translation = null;
            if (!modResult.isMasked) {
                translation = await translations().translate(text, sourceLang, targetLang, {
                    culturalContext: true,
                    orderId
                });
            }

            let message;
            try {
                message = store.insertMessage({
                    id: messageId,
                    orderId,
                    senderId: sender.id,
                    senderName: sender.name,
                    senderRole: sender.role,
                    originalText: text,
                    sanitizedText: modResult.sanitizedText,
                    isMasked: modResult.isMasked,
                    violations: modResult.violationsBlocked,
                    sourceLang,
                    targetLang,
                    translatedText: translation ? translation.translatedText : null,
                    confidence: translation ? translation.confidenceScore : null,
                    culturalAdaptation: translation ? translation.culturalAdaptation : null,
                    engine: translation ? translation.engine : null
                });
            } catch (error) {
                const duplicate = externalMessageId && store.getMessageById(messageId);
                if (duplicate) { sendJson(res, 200, { success: true, duplicate: true, message: duplicate }); return true; }
                throw error;
            }

            if (modResult.isMasked) {
                security.audit(req, 'MESSAGE_INTERCEPTED', {
                    actor: user, targetType: 'order', targetId: orderId,
                    detail: { violations: modResult.violationsBlocked }, severity: 'WARN'
                });
            }

            broadcastToChannel(orderId, 'message', message);
            sendJson(res, 201, { success: true, message });
            return true;
        }

        sendJson(res, 404, { error: `Route not found: ${pathname}` });
        return true;
    }

    // ---------- orders & deal workflow ----------
    if (pathname === '/api/orders' && req.method === 'GET') {
        const accessible = store.listOrders().filter(order => store.canAccessOrder(user, order.id));
        sendJson(res, 200, { orders: accessible });
        return true;
    }

    if (pathname === '/api/orders' && req.method === 'POST') {
        if (security.enforce(req, res, 'write', sendJson)) return true;
        if (!['buyer', 'seller'].includes(user.role)) {
            sendJson(res, 403, { error: 'Only buyers and sellers can create orders.' }); return true;
        }
        const body = await parseJsonBody(req);
        const title = String(body.title || '').trim();
        const sku = String(body.sku || '').trim();
        const amount = Number(body.amount);
        if (title.length < 3 || !sku || !Number.isFinite(amount) || amount <= 0) {
            sendJson(res, 400, { error: 'title, sku and a positive amount are required.' }); return true;
        }

        const counterpart = user.role === 'seller'
            ? store.listUsers().find(u => u.role === 'buyer' && u.id !== user.id)
            : store.listUsers().find(u => u.role === 'seller' && u.id !== user.id);
        if (!counterpart) { sendJson(res, 409, { error: 'No counterpart account is available yet.' }); return true; }

        const order = store.createOrder({
            title,
            sku,
            icon: String(body.icon || '📦').slice(0, 8),
            buyerId: user.role === 'buyer' ? user.id : counterpart.id,
            sellerId: user.role === 'seller' ? user.id : counterpart.id,
            amountMajor: amount,
            status: 'CREATED',
            origin: body.origin || null,
            destination: body.destination || null,
            carrier: body.carrier || null
        });

        security.audit(req, 'ORDER_CREATED', { actor: user, targetType: 'order', targetId: order.id, detail: { amount } });
        sendJson(res, 201, { success: true, order });
        return true;
    }

    if (pathname.startsWith('/api/orders/') && pathname.endsWith('/fund') && req.method === 'POST') {
        if (security.enforce(req, res, 'write', sendJson)) return true;
        const orderId = pathSegments(pathname)[2];
        const order = store.getOrder(orderId);
        if (!order) { sendJson(res, 404, { error: `Order ${orderId} not found` }); return true; }
        if (!store.canAccessOrder(user, orderId)) {
            sendJson(res, 403, { error: 'You do not have access to this order.' }); return true;
        }
        if (user.role !== 'buyer') {
            sendJson(res, 403, { error: 'Only the buyer can fund escrow.' }); return true;
        }
        if (order.status !== 'CREATED') {
            sendJson(res, 409, { error: `Order is already funded (status: ${order.status}).` }); return true;
        }

        store.appendLedgerEntry({
            orderId,
            type: 'FUNDS_HELD',
            amountMinor: order.amountMinor,
            currency: order.currency,
            idempotencyKey: `fund:${orderId}`,
            actorId: user.id,
            reason: 'Buyer funded escrow (mock funds)'
        });
        store.setMilestone(orderId, 'FUNDED', { completed: true, actorId: user.id });
        store.updateOrderStatus(orderId, 'ESCROW_FUNDED');
        broadcastToChannel(orderId, 'escrow_update', {
            orderId, newStatus: 'ESCROW_FUNDED',
            milestones: store.getMilestones(orderId), dispute: null
        });
        security.audit(req, 'ESCROW_FUNDED', { actor: user, targetType: 'order', targetId: orderId });
        sendJson(res, 200, { success: true, order: store.getOrder(orderId) });
        return true;
    }

    if (pathname === '/api/deals' && req.method === 'GET') {
        const orderId = query(req).get('orderId') || '';
        if (!store.canAccessOrder(user, orderId)) {
            sendJson(res, 403, { error: 'You do not have access to this order.' }); return true;
        }
        sendJson(res, 200, { deals: store.listDeals(orderId) });
        return true;
    }

    if (pathname === '/api/deals' && req.method === 'POST') {
        if (security.enforce(req, res, 'write', sendJson)) return true;
        const body = await parseJsonBody(req);
        const orderId = String(body.orderId || '');
        const order = store.getOrder(orderId);
        if (!order) { sendJson(res, 404, { error: `Order ${orderId} not found` }); return true; }
        if (!store.canAccessOrder(user, orderId)) {
            sendJson(res, 403, { error: 'You do not have access to this order.' }); return true;
        }
        if (!['buyer', 'seller'].includes(user.role)) {
            sendJson(res, 403, { error: 'Only order participants can propose terms.' }); return true;
        }
        const title = String(body.title || '').trim();
        const terms = Array.isArray(body.terms) ? body.terms.map(String).slice(0, 12) : [];
        if (title.length < 3 || !terms.length) {
            sendJson(res, 400, { error: 'title and at least one term are required.' }); return true;
        }

        const deal = store.createDeal({
            orderId, title, terms,
            proposedBy: user.id,
            status: body.counterOf ? 'COUNTERED' : 'PROPOSED',
            counterOf: body.counterOf || null
        });
        broadcastToChannel(orderId, 'message', { type: 'deal_update', deal });
        security.audit(req, 'DEAL_PROPOSED', { actor: user, targetType: 'deal', targetId: deal.id, detail: { orderId } });
        sendJson(res, 201, { success: true, deal });
        return true;
    }

    if (pathname.startsWith('/api/deals/') && pathname.endsWith('/resolve') && req.method === 'POST') {
        if (security.enforce(req, res, 'write', sendJson)) return true;
        const dealId = pathSegments(pathname)[2];
        const body = await parseJsonBody(req);
        const nextStatus = String(body.status || '').toUpperCase();
        if (!['ACCEPTED', 'REJECTED', 'COUNTERED'].includes(nextStatus)) {
            sendJson(res, 400, { error: "status must be ACCEPTED, REJECTED or COUNTERED." }); return true;
        }

        const deals = store.listDeals(query(req).get('orderId') || body.orderId || '');
        const deal = deals.find(d => d.id === dealId);
        if (!deal) { sendJson(res, 404, { error: 'Deal not found.' }); return true; }
        if (!store.canAccessOrder(user, deal.order_id)) {
            sendJson(res, 403, { error: 'You do not have access to this deal.' }); return true;
        }
        if (!['buyer', 'seller'].includes(user.role)) {
            sendJson(res, 403, { error: 'Only buyers and sellers can respond to deal terms.' }); return true;
        }
        if (deal.proposed_by === user.id) {
            sendJson(res, 403, { error: 'The proposer cannot accept or decline their own offer.' }); return true;
        }
        if (!['PROPOSED', 'COUNTERED'].includes(String(deal.status).toUpperCase())) {
            sendJson(res, 409, { error: 'This proposal has already been resolved.' }); return true;
        }

        const updated = store.resolveDeal(dealId, nextStatus);
        broadcastToChannel(deal.order_id, 'message', { type: 'deal_update', deal: updated });
        security.audit(req, `DEAL_${nextStatus}`, { actor: user, targetType: 'deal', targetId: dealId });
        sendJson(res, 200, { success: true, deal: updated });
        return true;
    }

    // ---------- escrow ----------
    if (req.method === 'GET' && pathname.startsWith('/api/escrow/')) {
        const segments = pathSegments(pathname);
        if (segments[3] === 'ledger') {
            const orderId = segments[2];
            if (!store.canAccessOrder(user, orderId)) {
                sendJson(res, 403, { error: 'You do not have access to this order.' }); return true;
            }
            sendJson(res, 200, { orderId, entries: store.listLedger(orderId) });
            return true;
        }
        const orderId = segments[2];
        const order = store.getOrder(orderId);
        if (!order) { sendJson(res, 404, { error: `Order ${orderId} not found` }); return true; }
        if (!store.canAccessOrder(user, orderId)) {
            sendJson(res, 403, { error: 'You do not have access to this order.' }); return true;
        }
        sendJson(res, 200, order);
        return true;
    }

    if (req.method === 'POST' && pathname === '/api/escrow/action') {
        if (security.enforce(req, res, 'write', sendJson)) return true;
        const body = await parseJsonBody(req);
        try {
            const result = escrow.performAction({
                orderId: String(body.orderId || 'GC-9821'),
                action: String(body.action || ''),
                actor: user,
                idempotencyKey: body.idempotencyKey ? String(body.idempotencyKey) : null,
                ip: security.clientIp(req),
                complaint: body.complaint ? String(body.complaint) : null
            });
            sendJson(res, 200, { success: true, orderId: result.orderId, newStatus: result.newStatus, milestones: result.milestones, dispute: result.dispute });
        } catch (error) {
            if (error.statusCode) sendJson(res, error.statusCode, { error: error.message });
            else throw error;
        }
        return true;
    }

    // ---------- disputes ----------
    if (req.method === 'GET' && pathname.startsWith('/api/dispute/packet/')) {
        const orderId = pathSegments(pathname)[3] || 'GC-9821';
        if (!store.getOrder(orderId)) { sendJson(res, 404, { error: `Order ${orderId} not found` }); return true; }
        if (!store.canAccessOrder(user, orderId)) {
            sendJson(res, 403, { error: 'You do not have access to this dispute.' }); return true;
        }
        sendJson(res, 200, disputes().generatePacket(orderId));
        return true;
    }

    if (req.method === 'POST' && pathname === '/api/dispute/mediate') {
        if (security.enforce(req, res, 'write', sendJson)) return true;
        const body = await parseJsonBody(req);
        const orderId = String(body.orderId || 'GC-9821');
        if (!store.getOrder(orderId)) { sendJson(res, 404, { error: `Order ${orderId} not found` }); return true; }
        if (!store.canAccessOrder(user, orderId)) {
            sendJson(res, 403, { error: 'You do not have access to this dispute.' }); return true;
        }
        sendJson(res, 200, disputes().generatePacket(orderId, body.complaint ? String(body.complaint) : undefined));
        return true;
    }

    if (req.method === 'GET' && pathname === '/api/dispute/cases') {
        const cases = disputes().listOpenCases();
        const visible = user.role === 'agent'
            ? cases
            : cases.filter(item => store.canAccessOrder(user, item.dispute.orderId));
        sendJson(res, 200, { cases: visible });
        return true;
    }

    if (req.method === 'GET' && pathname.startsWith('/api/dispute/history/')) {
        const disputeId = pathSegments(pathname)[3];
        try {
            const history = disputes().getCaseHistory(disputeId);
            if (user.role !== 'agent' && !store.canAccessOrder(user, history.dispute.orderId)) {
                sendJson(res, 403, { error: 'You do not have access to this case.' }); return true;
            }
            sendJson(res, 200, history);
        } catch (error) {
            sendJson(res, error.statusCode || 404, { error: error.message });
        }
        return true;
    }

    if (req.method === 'POST' && pathname.startsWith('/api/dispute/') && pathname.endsWith('/evidence')) {
        if (security.enforce(req, res, 'upload', sendJson)) return true;
        const disputeId = pathSegments(pathname)[2];
        const dispute = store.getDispute(disputeId);
        if (!dispute) { sendJson(res, 404, { error: 'Dispute not found.' }); return true; }
        if (user.role !== 'agent' && !store.canAccessOrder(user, dispute.orderId)) {
            sendJson(res, 403, { error: 'You do not have access to this case.' }); return true;
        }

        const body = await parseJsonBody(req, MAX_EVIDENCE_BYTES * 1.4);
        const filename = String(body.filename || '').trim();
        const kind = String(body.kind || 'document').trim();
        const note = body.note ? String(body.note).slice(0, 500) : null;
        if (!filename) { sendJson(res, 400, { error: 'filename is required.' }); return true; }

        let sizeBytes = Number(body.sizeBytes || 0);
        let sha256 = body.sha256 ? String(body.sha256) : null;
        let storagePath = null;

        if (typeof body.data === 'string' && body.data.length) {
            let buffer;
            try {
                buffer = Buffer.from(body.data, 'base64');
            } catch (_) {
                sendJson(res, 400, { error: 'data must be base64-encoded.' }); return true;
            }
            if (!buffer.length) { sendJson(res, 400, { error: 'data decoded to an empty file.' }); return true; }
            if (buffer.length > MAX_EVIDENCE_BYTES) {
                sendJson(res, 413, { error: 'Evidence exceeds the 5 MB limit.' }); return true;
            }
            const digest = crypto.createHash('sha256').update(buffer).digest('hex');
            if (sha256 && sha256.toLowerCase() !== digest) {
                sendJson(res, 400, { error: 'sha256 does not match the uploaded data.' }); return true;
            }
            sha256 = digest;
            sizeBytes = buffer.length;

            fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
            const safeName = filename.replace(/[^\w.\- ]+/g, '_').slice(0, 80);
            storagePath = path.join(EVIDENCE_DIR, `${disputeId}_${digest.slice(0, 12)}_${safeName}`);
            fs.writeFileSync(storagePath, buffer, { mode: 0o600 });
        }

        if (!sizeBytes || sizeBytes <= 0 || sizeBytes > MAX_EVIDENCE_BYTES) {
            sendJson(res, 400, { error: 'sizeBytes must be between 1 and 5242880 (provide data for server-side sizing).' }); return true;
        }

        try {
            const evidence = disputes().addEvidenceItem({
                disputeId,
                uploadedBy: user.id,
                kind, filename,
                mime: String(body.mime || 'application/octet-stream').slice(0, 120),
                sizeBytes,
                sha256: sha256 || crypto.createHash('sha256').update(filename + sizeBytes).digest('hex'),
                storagePath,
                note,
                ip: security.clientIp(req)
            });
            security.audit(req, 'EVIDENCE_UPLOADED', { actor: user, targetType: 'dispute', targetId: disputeId, detail: { filename, sizeBytes } });
            sendJson(res, 201, { success: true, evidence });
        } catch (error) {
            sendJson(res, error.statusCode || 400, { error: error.message });
        }
        return true;
    }

    if (req.method === 'GET' && pathname.startsWith('/api/dispute/evidence/') && pathname.endsWith('/download')) {
        const evidenceId = pathSegments(pathname)[3];
        const evidence = store.getEvidence(evidenceId);
        if (!evidence) { sendJson(res, 404, { error: 'Evidence not found.' }); return true; }
        const dispute = store.getDispute(evidence.dispute_id);
        if (!dispute) { sendJson(res, 404, { error: 'Case not found.' }); return true; }
        if (user.role !== 'agent' && !store.canAccessOrder(user, dispute.orderId)) {
            sendJson(res, 403, { error: 'You do not have access to this evidence.' }); return true;
        }
        if (!evidence.storage_path || !fs.existsSync(evidence.storage_path)) {
            sendJson(res, 410, { error: 'Evidence file is not available (metadata-only record).' }); return true;
        }
        security.audit(req, 'EVIDENCE_DOWNLOADED', { actor: user, targetType: 'evidence', targetId: evidenceId });
        res.writeHead(200, {
            'Content-Type': evidence.mime || 'application/octet-stream',
            'Content-Disposition': `attachment; filename="${evidence.filename.replace(/"/g, '')}"`,
            'Content-Length': String(evidence.size_bytes),
            'Cache-Control': 'no-store'
        });
        fs.createReadStream(evidence.storage_path).pipe(res);
        return;
    }

    // ---------- glossary ----------
    if (pathname.startsWith('/api/glossary')) {
        if (req.method === 'GET') {
            const glossary = store.listGlossary();
            sendJson(res, 200, { success: true, count: glossary.length, glossary });
            return true;
        }
        if (req.method === 'POST') {
            if (security.enforce(req, res, 'write', sendJson)) return true;
            const body = await parseJsonBody(req);
            const sourceTerm = String(body.sourceTerm || '').trim();
            if (!sourceTerm) { sendJson(res, 400, { error: 'sourceTerm is required' }); return true; }

            const entry = store.createGlossary({
                sourceTerm,
                category: String(body.category || 'General Commercial').trim(),
                contextNote: String(body.contextNote || 'Custom merchant terminology preference').trim(),
                translations: body.translations && typeof body.translations === 'object' ? body.translations : {}
            });
            security.audit(req, 'GLOSSARY_CREATED', { actor: user, targetType: 'glossary', targetId: entry.id, detail: { sourceTerm } });
            sendJson(res, 201, { success: true, entry });
            return true;
        }
    }

    // ---------- analytics ----------
    if (req.method === 'GET' && pathname === '/api/analytics/metrics') {
        sendJson(res, 200, metrics.computeMarketplaceMetrics());
        return true;
    }

    // ---------- audit log (agents only) ----------
    if (req.method === 'GET' && pathname === '/api/audit') {
        if (user.role !== 'agent') {
            sendJson(res, 403, { error: 'Audit log access is restricted to support agents.' }); return true;
        }
        const params = query(req);
        sendJson(res, 200, {
            entries: store.listAudit({
                limit: Math.min(Number(params.get('limit') || 50), 200),
                action: params.get('action') || null
            })
        });
        return true;
    }

    return false;
}

// ---------------------------------------------------------------------------
// Webhook receiver (HMAC-SHA256, constant-time)
// ---------------------------------------------------------------------------

async function handleWebhook(req, res, pathname) {
    if (!(req.method === 'POST' && pathname === '/api/webhooks/nexconn')) return false;
    if (security.enforce(req, res, 'general', sendJson)) return true;

    const signature = req.headers['x-nexconn-signature'];
    const rawBody = await new Promise((resolve, reject) => {
        let data = '';
        req.on('data', chunk => { data += chunk; if (data.length > 1e6) { req.destroy(); reject(new Error('Payload too large')); } });
        req.on('end', () => resolve(data));
        req.on('error', reject);
    });

    if (!signature) { sendJson(res, 401, { error: 'Missing x-nexconn-signature header' }); return true; }
    if (!WEBHOOK_SECRET) { sendJson(res, 503, { error: 'Webhook secret is not configured.' }); return true; }

    const expectedSig = crypto.createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');
    const provided = String(signature);
    const valid = provided.length === expectedSig.length &&
        crypto.timingSafeEqual(Buffer.from(provided, 'utf8'), Buffer.from(expectedSig, 'utf8'));

    if (!valid) {
        security.log('warn', 'webhook_signature_rejected', { ip: security.clientIp(req) });
        sendJson(res, 403, { error: 'Invalid HMAC signature. Webhook rejected.' });
        return true;
    }

    let payload = {};
    try { payload = JSON.parse(rawBody); } catch (_) { payload = {}; }
    sendJson(res, 200, {
        received: true,
        eventType: payload.event || 'message.sent',
        verified: true,
        timestamp: new Date().toISOString()
    });
    return true;
}

// ---------------------------------------------------------------------------
// Static file serving
// ---------------------------------------------------------------------------

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.glb': 'model/gltf-binary',
    '.gltf': 'model/gltf+json',
    '.pdf': 'application/pdf',
    '.woff2': 'font/woff2',
    '.ico': 'image/x-icon',
    '.txt': 'text/plain; charset=utf-8',
    '.md': 'text/plain; charset=utf-8'
};

function serveStatic(req, res, pathname, user) {
    // Auth redirects
    if (req.method === 'GET' && pathname === '/app.html' && !user) {
        res.writeHead(302, { Location: '/auth.html?next=%2Fapp.html', 'Cache-Control': 'no-store' });
        res.end(); return;
    }
    if (req.method === 'GET' && pathname === '/auth.html' && user) {
        res.writeHead(302, { Location: '/app.html', 'Cache-Control': 'no-store' });
        res.end(); return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 404, { error: `Route not found: ${pathname}` }); return;
    }

    const filePath = path.join(__dirname, pathname === '/' ? 'index.html' : pathname);

    // Workspace containment (path.join normalizes "..")
    if (!filePath.startsWith(__dirname + path.sep)) {
        res.writeHead(403); res.end('Access Denied'); return;
    }

    // Never expose dotfiles, .git, or the evidence uploads directory
    const relative = path.relative(__dirname, filePath);
    const segments = relative.split(path.sep);
    if (segments.some(segment => segment.startsWith('.')) || segments[0] === 'uploads') {
        sendJson(res, 404, { error: 'Not found' }); return;
    }

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath).toLowerCase();
        const isHtml = ext === '.html';
        if (isHtml) security.applyHtmlCsp(res);
        res.writeHead(200, {
            'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
            'Cache-Control': isHtml ? 'no-cache' : 'public, max-age=300',
            'X-Content-Type-Options': 'nosniff'
        });
        fs.createReadStream(filePath).pipe(res);
        return;
    }

    sendJson(res, 404, { error: `Route not found: ${pathname}` });
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
    const startedAt = Date.now();
    security.applyHeaders(req, res);

    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-nexconn-signature'
        });
        res.end();
        return;
    }

    let pathname;
    try { pathname = new URL(req.url, 'http://localhost').pathname; }
    catch (_) { sendJson(res, 400, { error: 'Malformed URL' }); return; }

    try {
        if (security.enforce(req, res, 'general', sendJson)) return;

        const user = auth.getSessionUser(req);

        if (await handleAuth(req, res, pathname)) return;
        if (await handleWebhook(req, res, pathname)) return;

        const workspacePrefixes = ['/api/translate', '/api/moderate', '/api/channels', '/api/orders',
            '/api/deals', '/api/escrow', '/api/dispute', '/api/glossary', '/api/analytics', '/api/audit'];
        const needsSession = workspacePrefixes.some(prefix => pathname.startsWith(prefix));
        if (needsSession && !user) {
            sendJson(res, 401, { error: 'Sign in to use workspace features.' });
            return;
        }

        if (await handleNexconn(req, res, pathname, user)) return;
        if (await handleWorkspace(req, res, pathname, user)) return;

        if (pathname === '/api/health') {
            sendJson(res, 200, {
                status: 'operational',
                service: 'GlobalConnect API Gateway',
                challenge: 'Nexconn Build Challenge 2026',
                timestamp: new Date().toISOString(),
                uptime: process.uptime(),
                activeOrders: store.listOrders().length,
                database: { path: path.basename(db.currentPath() || 'memory'), ok: true },
                sessions: { active: store.countActiveSessions() },
                nexconn: { configured: nexconn.isConfigured() },
                environment: process.env.NODE_ENV || 'development',
                responseMs: Date.now() - startedAt
            });
            return;
        }

        serveStatic(req, res, pathname, user);
    } catch (error) {
        security.log('error', 'request_failed', {
            path: pathname, message: error.message, stack: (error.stack || '').split('\n')[1]
        });
        if (!res.headersSent) {
            sendJson(res, error.statusCode || 500, {
                error: error.statusCode ? error.message : 'Internal Server Error',
                ...(IS_PRODUCTION ? {} : { message: error.message })
            });
        } else {
            try { res.end(); } catch (_) { /* stream already closed */ }
        }
    }
});

// ---------------------------------------------------------------------------
// Boot / shutdown
// ---------------------------------------------------------------------------

function logBootBanner() {
    console.log('=======================================================');
    console.log(`🚀 GlobalConnect Gateway running at: http://localhost:${PORT}`);
    console.log(`🗄️  Database: ${db.currentPath()}`);
    console.log(`🔐 Webhook secret: ${WEBHOOK_SECRET ? 'configured' : 'MISSING (webhooks rejected)'}`);
    console.log(`💬 Nexconn credentials: ${nexconn.isConfigured() ? 'configured' : 'not set (chat disabled)'}`);
    console.log(`🧠 OpenAI translation: ${process.env.OPENAI_API_KEY ? 'configured' : 'corpus/fallback only'}`);
    console.log(`🎭 Demo persona login: ${DEMO_LOGIN_DISABLED ? 'disabled' : 'enabled'}`);
    if (IS_PRODUCTION && process.env.DISABLE_DEMO_LOGIN !== 'true') {
        console.warn('⚠️  NODE_ENV=production — demo persona login is disabled.');
    }
    console.log('=======================================================');
}

let shuttingDown = false;
function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    security.log('info', 'shutdown_started', { signal });
    closeAllSseClients();
    server.close(() => {
        try { db.closeDatabase(); } catch (_) { /* ignore */ }
        security.log('info', 'shutdown_complete', {});
        process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000).unref();
}

if (require.main === module) {
    auth.seedDefaultAuthAccounts()
        .catch(error => security.log('error', 'seed_accounts_failed', { message: error.message }))
        .finally(() => {
            const pruneTimer = setInterval(() => {
                try { store.pruneExpiredSessions(); } catch (_) { /* ignore */ }
            }, 10 * 60 * 1000);
            pruneTimer.unref();

            server.listen(PORT, () => {
                logBootBanner();
                security.log('info', 'server_started', { port: PORT });
            });
        });

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
}

module.exports = server;
