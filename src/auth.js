/**
 * GlobalConnect — authentication & session management
 *
 * - scrypt password hashing (timing-safe verification)
 * - Durable cookie sessions backed by SQLite (token stored hashed)
 * - Seeded demo personas with environment-driven passwords
 */

const crypto = require('crypto');
const { promisify } = require('util');
const store = require('./store');

const scryptAsync = promisify(crypto.scrypt);

const COOKIE_NAME = 'gc_session';

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------

async function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
    const derivedKey = await scryptAsync(String(password), salt, 64);
    return { salt, hash: derivedKey.toString('hex') };
}

async function verifyPassword(password, salt, expectedHash) {
    if (!salt || !expectedHash) return false;
    const actual = await scryptAsync(String(password), salt, 64);
    const expected = Buffer.from(expectedHash, 'hex');
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// ---------------------------------------------------------------------------
// Cookies / sessions
// ---------------------------------------------------------------------------

function readCookies(req) {
    return Object.fromEntries((req.headers.cookie || '').split(';').map(part => {
        const separator = part.indexOf('=');
        if (separator < 0) return ['', ''];
        return [part.slice(0, separator).trim(), decodeURIComponent(part.slice(separator + 1).trim())];
    }).filter(([key]) => key));
}

function getSessionToken(req) {
    return readCookies(req)[COOKIE_NAME] || null;
}

function setSessionCookie(req, res, sessionId, maxAgeSeconds) {
    const secure = req.socket && req.socket.encrypted ? '; Secure' : '';
    const value = sessionId ? encodeURIComponent(sessionId) : '';
    res.setHeader('Set-Cookie',
        `${COOKIE_NAME}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}${secure}`);
}

function clearSessionCookie(req, res) {
    setSessionCookie(req, res, '', 0);
}

function toSafeUser(userRow) {
    if (!userRow) return null;
    return {
        id: userRow.id,
        name: userRow.name,
        email: userRow.email || '',
        role: userRow.role,
        lang: userRow.lang || 'en',
        trustScore: userRow.trust_score,
        demoOrderIds: userRow.demoOrderIds || [],
        nexconnUserId: userRow.nexconn_user_id || null
    };
}

/** Resolve the authenticated user for a request (or null). */
function getSessionUser(req) {
    const token = getSessionToken(req);
    if (!token) return null;
    const session = store.getSession(token);
    if (!session) return null;
    return toSafeUser(store.getUserById(session.user_id));
}

/** Create a session and set the cookie; returns the safe user object. */
function startSession(req, res, userRow) {
    const { token, expiresAt } = store.createSession(userRow.id, {
        ip: require('./security').clientIp(req),
        userAgent: req.headers['user-agent']
    });
    setSessionCookie(req, res, token, Math.round((expiresAt - Date.now()) / 1000));
    return toSafeUser(userRow);
}

function endSession(req, res) {
    const token = getSessionToken(req);
    if (token) store.deleteSession(token);
    clearSessionCookie(req, res);
}

// ---------------------------------------------------------------------------
// Seeded demo personas (persistent — hashes survive restarts)
// ---------------------------------------------------------------------------

async function ensureAccount({ id, email, role, name, lang, trustScore, password }) {
    const existing = store.getUserById(id);
    const envPassword = password || null;

    if (!existing) {
        const creds = await hashPassword(envPassword || crypto.randomBytes(16).toString('hex'));
        store.createUser({
            id, name, email, role, lang, trustScore,
            passwordSalt: creds.salt, passwordHash: creds.hash
        });
        return;
    }

    // Rotate the stored hash when an operator supplies DEMO_*_PASSWORD
    if (envPassword && existing.password_hash) {
        const current = await verifyPassword(envPassword, existing.password_salt, existing.password_hash);
        if (!current) {
            const creds = await hashPassword(envPassword);
            store.updateUserCredentials(id, creds);
        }
    }
}

async function seedDefaultAuthAccounts() {
    const accounts = [
        {
            id: 'buyer_dubai_12', email: 'buyer@globalconnect.io', role: 'buyer',
            name: 'Tariq Al-Mansoor', lang: 'ar', trustScore: 98,
            password: process.env.DEMO_BUYER_PASSWORD
        },
        {
            id: 'seller_milan_88', email: 'seller@globalconnect.io', role: 'seller',
            name: 'Marco Rossi', lang: 'en', trustScore: 99,
            password: process.env.DEMO_SELLER_PASSWORD
        },
        {
            id: 'agent_support_01', email: 'agent@globalconnect.io', role: 'agent',
            name: 'Sarah Chen', lang: 'en', trustScore: 100,
            password: process.env.DEMO_AGENT_PASSWORD
        }
    ];

    for (const account of accounts) {
        await ensureAccount(account);
    }
}

module.exports = {
    COOKIE_NAME,
    hashPassword,
    verifyPassword,
    readCookies,
    getSessionToken,
    setSessionCookie,
    clearSessionCookie,
    getSessionUser,
    startSession,
    endSession,
    toSafeUser,
    seedDefaultAuthAccounts
};
