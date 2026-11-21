/**
 * GlobalConnect — security middleware helpers
 *
 * - Sliding-window rate limiting (per-IP, per-bucket) with in-memory counters
 * - Security response headers (CSP tuned for this app's CDN + Nexconn sockets)
 * - Structured JSON logging + audit-log helpers
 */

const store = require('./store');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const config = {
    enabled: () => process.env.RATE_LIMIT_ENABLED !== 'false',
    buckets: {
        general: { windowMs: 60_000, max: Number(process.env.RL_GENERAL || 600) },
        auth: { windowMs: 60_000, max: Number(process.env.RL_AUTH || 30) },
        translate: { windowMs: 60_000, max: Number(process.env.RL_TRANSLATE || 60) },
        write: { windowMs: 60_000, max: Number(process.env.RL_WRITE || 120) },
        upload: { windowMs: 60_000, max: Number(process.env.RL_UPLOAD || 20) }
    }
};

// key -> { windowStart, count }
const counters = new Map();
let lastSweep = Date.now();

function clientIp(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length) {
        return forwarded.split(',')[0].trim();
    }
    return req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : 'unknown';
}

function sweep(now) {
    if (now - lastSweep < 30_000) return;
    lastSweep = now;
    for (const [key, entry] of counters) {
        if (now - entry.windowStart >= entry.windowMs) counters.delete(key);
    }
}

/**
 * Consume one unit from a rate-limit bucket.
 * @returns {{allowed:boolean, remaining:number, retryAfterSec:number, limit:number}}
 */
function consume(req, bucketName = 'general') {
    const bucket = config.buckets[bucketName] || config.buckets.general;
    const now = Date.now();
    sweep(now);

    if (!config.enabled()) {
        return { allowed: true, remaining: bucket.max, retryAfterSec: 0, limit: bucket.max };
    }

    const key = `${bucketName}:${clientIp(req)}`;
    let entry = counters.get(key);
    if (!entry || now - entry.windowStart >= bucket.windowMs) {
        entry = { windowStart: now, windowMs: bucket.windowMs, count: 0 };
        counters.set(key, entry);
    }

    entry.count += 1;
    const allowed = entry.count <= bucket.max;
    const retryAfterSec = allowed ? 0 : Math.max(1, Math.ceil((entry.windowStart + bucket.windowMs - now) / 1000));
    return { allowed, remaining: Math.max(0, bucket.max - entry.count), retryAfterSec, limit: bucket.max };
}

/** Send a 429 when the bucket is exhausted. Returns true when the request was rejected. */
function enforce(req, res, bucketName, sendJson) {
    const result = consume(req, bucketName);
    res.setHeader('X-RateLimit-Limit', String(result.limit));
    res.setHeader('X-RateLimit-Remaining', String(result.remaining));
    if (result.allowed) return false;
    res.setHeader('Retry-After', String(result.retryAfterSec));
    sendJson(res, 429, {
        error: 'Too many requests. Please slow down and retry shortly.',
        retryAfterSec: result.retryAfterSec
    });
    return true;
}

function resetForTests() {
    counters.clear();
}

// ---------------------------------------------------------------------------
// Response headers
// ---------------------------------------------------------------------------

// The workspace loads Three.js from cdnjs and fonts from Google Fonts.
// Nexconn's Singapore navigation and IM services use light-edge.com domains;
// retain the rongnav/rongcfg hosts for endpoints returned by the bootstrap API.
const CSP = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob:",
    "connect-src 'self' https://cdnjs.cloudflare.com https://nav.sg-light-edge.com https://nav-b.sg-light-edge.com https://dualstack-cloudcontrol.sg-light-edge.com wss://ws.sg-light-edge.com https://*.light-edge.com wss://*.light-edge.com https://api.sg-light-api.com https://api-b.sg-light-api.com https://*.rongnav.com wss://*.rongnav.com https://*.rongcfg.com wss://*.rongcfg.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'"
].join('; ');

function applyHeaders(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('X-DNS-Prefetch-Control', 'off');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    if (req.socket && req.socket.encrypted) {
        res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    }
}

function applyHtmlCsp(res) {
    res.setHeader('Content-Security-Policy', CSP);
}

// ---------------------------------------------------------------------------
// Structured logging
// ---------------------------------------------------------------------------

function log(level, message, fields = {}) {
    const entry = { ts: new Date().toISOString(), level, message, ...fields };
    const line = JSON.stringify(entry);
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
}

/** Record a sensitive action in the persistent audit log. */
function audit(req, action, { actor = null, targetType = null, targetId = null, detail = null, severity = 'INFO' } = {}) {
    try {
        store.addAudit({
            actorId: actor ? actor.id : null,
            actorRole: actor ? actor.role : null,
            action,
            targetType,
            targetId,
            ip: req ? clientIp(req) : null,
            detail,
            severity
        });
    } catch (error) {
        log('warn', 'audit_write_failed', { action, error: error.message });
    }
}

module.exports = {
    config,
    clientIp,
    consume,
    enforce,
    resetForTests,
    applyHeaders,
    applyHtmlCsp,
    CSP,
    log,
    audit
};
