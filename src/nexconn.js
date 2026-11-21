/**
 * GlobalConnect — Nexconn Chat SDK server-side client
 *
 * - Stable per-user Nexconn identity (derived from the marketplace user id)
 * - Signed server-to-server token issuance with retry/backoff
 * - Order-scoped conversation + participant profile resolution
 */

const crypto = require('crypto');
const store = require('./store');
const security = require('./security');

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

function settings() {
    return {
        appKey: (process.env.NEXCONN_APP_KEY || '').trim(),
        appSecret: (process.env.NEXCONN_APP_SECRET || '').trim(),
        baseUrl: (process.env.NEXCONN_API_BASE_URL || 'https://api.sg-light-api.com').replace(/\/$/, ''),
        areaCode: (process.env.NEXCONN_AREA_CODE || 'SG').trim() || 'SG'
    };
}

function isConfigured() {
    const { appKey, appSecret } = settings();
    return Boolean(appKey && appSecret);
}

/** Stable Nexconn identity — independent from editable email/name fields. */
function nexconnUserId(user) {
    const seed = String(user.id || user);
    return `gc_${crypto.createHash('sha256').update(seed).digest('hex').slice(0, 32)}`;
}

function signRequest(secret, nonce, timestamp) {
    return crypto.createHash('sha1').update(`${secret}${nonce}${timestamp}`).digest('hex');
}

function findAccessToken(value, depth = 0) {
    if (!value || typeof value !== 'object' || depth > 5) return '';
    for (const [key, nested] of Object.entries(value)) {
        if (/^(token|userToken|accessToken|access_token)$/i.test(key) &&
            typeof nested === 'string' && nested.trim()) {
            return nested.trim();
        }
    }
    for (const nested of Object.values(value)) {
        const token = findAccessToken(nested, depth + 1);
        if (token) return token;
    }
    return '';
}

async function postWithRetry(url, body, headers, { retries = 2, timeoutMs = 10_000 } = {}) {
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(timeoutMs)
            });
            let result = null;
            try { result = await response.json(); } catch (_) { result = null; }

            const retryable = RETRYABLE_STATUS.has(response.status);
            if (retryable && attempt < retries) {
                lastError = { status: response.status, result };
                await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
                continue;
            }
            return { response, result };
        } catch (error) {
            lastError = { status: 0, result: null, error };
            if (attempt < retries) {
                await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
                continue;
            }
        }
    }
    throw Object.assign(new Error('Nexconn request failed after retries.'),
        { statusCode: 502, cause: lastError && lastError.error });
}

/**
 * Issue a Nexconn user token (server-side; App Secret never leaves the server).
 * @returns {Promise<{userId:string, token:string}>}
 */
async function issueToken(user) {
    const { appKey, appSecret, baseUrl } = settings();
    if (!appKey || !appSecret) {
        const error = new Error('Nexconn server credentials are not configured. Set NEXCONN_APP_KEY and NEXCONN_APP_SECRET in .env.');
        error.statusCode = 503;
        throw error;
    }

    const nonce = crypto.randomBytes(16).toString('hex');
    const timestamp = String(Date.now());
    const payload = {
        userId: nexconnUserId(user),
        name: String(user.name || user.email || user.id).slice(0, 64)
    };

    const { response, result } = await postWithRetry(
        `${baseUrl}/v4/auth/access-token/issue`,
        payload,
        {
            'Content-Type': 'application/json',
            'App-Key': appKey,
            Nonce: nonce,
            Timestamp: timestamp,
            Signature: signRequest(appSecret, nonce, timestamp)
        }
    );

    const token = findAccessToken(result);
    const resultCode = result && result.code != null ? Number(result.code) : null;
    const ok = response.ok && (resultCode === null || [0, 200].includes(resultCode)) && token;
    if (!ok) {
        const fields = result && typeof result === 'object' ? Object.keys(result).join(',') : 'non_json_response';
        security.log('warn', 'nexconn_token_issue_failed', {
            status: response.status, code: resultCode ?? 'no_code', fields
        });
        const vendorMessage = (result && (result.errorMessage || result.message || result.error)) || null;
        const error = new Error(vendorMessage
            ? `Nexconn token issuance failed: ${String(vendorMessage).slice(0, 180)}`
            : (response.ok ? 'Nexconn returned a successful response without a token.' : 'Nexconn token issuance failed.'));
        error.statusCode = response.ok ? 502 : (response.status >= 500 ? 502 : 502);
        throw error;
    }

    return { userId: payload.userId, token };
}

/** Build the full chat-session payload for the workspace popup. */
async function buildChatSession(user, order) {
    const { appKey, areaCode } = settings();
    const peerId = user.id === order.buyerId ? order.sellerId : order.buyerId;
    const peer = store.getUserById(peerId);
    if (!peer) {
        const error = new Error('Conversation participant was not found.');
        error.statusCode = 404;
        throw error;
    }

    const identity = await issueToken(user);
    return {
        ...identity,
        appKey,
        areaCode,
        orderId: order.id,
        peer: { userId: nexconnUserId(peer), name: peer.name }
    };
}

/** Order-scoped ChatUI profile lookup (bounded to the conversation parties). */
function buildProfiles(order, wantedCsv) {
    const wanted = new Set(String(wantedCsv || '').split(',').filter(Boolean).slice(0, 100));
    const participants = [order.buyerId, order.sellerId]
        .map(id => store.getUserById(id))
        .filter(Boolean)
        .map(profile => ({ userId: nexconnUserId(profile), name: profile.name }));
    return participants.filter(profile => wanted.has(profile.userId));
}

module.exports = {
    settings,
    isConfigured,
    nexconnUserId,
    issueToken,
    buildChatSession,
    buildProfiles
};
