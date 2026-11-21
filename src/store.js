/**
 * GlobalConnect — Data access layer (repository pattern)
 *
 * Everything above this module speaks domain objects; everything below is SQL.
 * API response shapes stay backwards compatible with the original prototype
 * (see toApiOrder / toApiMessage).
 */

const crypto = require('crypto');
const { getDb, sha256, nowIso } = require('./db');

// ---------------------------------------------------------------------------
// Money helpers — minor units (cents) in storage, major units on the wire
// ---------------------------------------------------------------------------

function toMinor(amountMajor) {
    return Math.round(Number(amountMajor) * 100);
}

function toMajor(amountMinor) {
    return Number((Number(amountMinor || 0) / 100).toFixed(2));
}

function randomId(prefix) {
    return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function parseJson(value, fallback = null) {
    if (value == null) return fallback;
    if (typeof value === 'object') return value;
    try { return JSON.parse(value); } catch (_) { return fallback; }
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

function toApiUser(row, demoOrderIds = undefined) {
    if (!row) return null;
    return {
        id: row.id,
        name: row.name,
        email: row.email || '',
        role: row.role,
        lang: row.lang || 'en',
        trustScore: row.trust_score,
        demoOrderIds: demoOrderIds !== undefined ? demoOrderIds : parseJson(row.demo_order_ids, []),
        nexconnUserId: row.nexconn_user_id || null,
        createdAt: row.created_at
    };
}

function getUserById(id) {
    const row = getDb().prepare('SELECT * FROM users WHERE id = ?').get(id);
    return row ? { ...row, demoOrderIds: parseJson(row.demo_order_ids, []) } : null;
}

function getUserByEmail(email) {
    if (!email) return null;
    const row = getDb().prepare('SELECT * FROM users WHERE email = ?').get(String(email).toLowerCase());
    return row ? { ...row, demoOrderIds: parseJson(row.demo_order_ids, []) } : null;
}

function listUsers() {
    return getDb().prepare('SELECT * FROM users ORDER BY created_at').all().map(row => toApiUser(row));
}

function createUser({ id, name, email, role, lang = 'en', trustScore = 100, passwordSalt, passwordHash, demoOrderIds = [] }) {
    const db = getDb();
    const userId = id || randomId(role || 'user');
    const ts = nowIso();
    db.prepare(`
        INSERT INTO users (id, name, email, role, lang, trust_score, password_salt, password_hash,
                           demo_order_ids, created_at, updated_at)
        VALUES (@id, @name, @email, @role, @lang, @trustScore, @passwordSalt, @passwordHash,
                @demoOrderIds, @ts, @ts)
    `).run({
        id: userId,
        name,
        email: email ? String(email).toLowerCase() : null,
        role,
        lang,
        trustScore,
        passwordSalt: passwordSalt || null,
        passwordHash: passwordHash || null,
        demoOrderIds: JSON.stringify(demoOrderIds || []),
        ts
    });
    return getUserById(userId);
}

function updateUserCredentials(id, { passwordSalt, passwordHash }) {
    getDb().prepare(`
        UPDATE users SET password_salt = ?, password_hash = ?, updated_at = ? WHERE id = ?
    `).run(passwordSalt, passwordHash, nowIso(), id);
}

function setDemoOrderIds(id, orderIds) {
    getDb().prepare('UPDATE users SET demo_order_ids = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(orderIds || []), nowIso(), id);
}

// ---------------------------------------------------------------------------
// Sessions — durable, token stored hashed, sliding TTL with pruning
// ---------------------------------------------------------------------------

const SESSION_TTL_MS = Number(process.env.SESSION_TTL_HOURS || 12) * 60 * 60 * 1000;

function createSession(userId, { ip = null, userAgent = null, ttlMs = SESSION_TTL_MS } = {}) {
    const db = getDb();
    const token = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    db.prepare(`
        INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at, ip, user_agent)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(sha256(token), userId, now, now + ttlMs, now, ip, String(userAgent || '').slice(0, 255));
    return { token, expiresAt: now + ttlMs };
}

function pruneExpiredSessions() {
    return getDb().prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now()).changes;
}

/** Returns the session row (extending its TTL) or null. */
function getSession(token) {
    if (!token) return null;
    const db = getDb();
    const tokenHash = sha256(token);
    const row = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(tokenHash);
    if (!row) return null;

    const now = Date.now();
    if (row.expires_at <= now) {
        db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
        return null;
    }

    // Sliding expiry + throttle writes to once per minute per session
    if (now - row.last_seen_at > 60_000) {
        const expiresAt = now + SESSION_TTL_MS;
        db.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?')
            .run(now, expiresAt, tokenHash);
        row.last_seen_at = now;
        row.expires_at = expiresAt;
    }
    return row;
}

function deleteSession(token) {
    if (!token) return false;
    return getDb().prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token)).changes > 0;
}

function countActiveSessions() {
    return getDb().prepare('SELECT COUNT(*) AS c FROM sessions WHERE expires_at > ?').get(Date.now()).c;
}

// ---------------------------------------------------------------------------
// Orders + milestones
// ---------------------------------------------------------------------------

function toApiOrder(row) {
    if (!row) return null;
    const dispute = getActiveDisputeForOrder(row.id);
    return {
        id: row.id,
        title: row.title,
        sku: row.sku,
        icon: row.icon,
        buyerId: row.buyer_id,
        buyerName: row.buyer_name || undefined,
        sellerId: row.seller_id,
        sellerName: row.seller_name || undefined,
        amount: toMajor(row.amount_minor),
        amountMinor: row.amount_minor,
        currency: row.currency,
        status: row.status,
        origin: row.origin,
        destination: row.destination,
        carrier: row.carrier,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        escrowMilestones: getMilestones(row.id),
        dispute: dispute ? toApiDispute(dispute) : null
    };
}

const ORDER_SELECT = `
    SELECT o.*, b.name AS buyer_name, s.name AS seller_name
    FROM orders o
    LEFT JOIN users b ON b.id = o.buyer_id
    LEFT JOIN users s ON s.id = o.seller_id
`;

function listOrders() {
    return getDb().prepare(`${ORDER_SELECT} ORDER BY o.created_at`).all().map(toApiOrder);
}

function getOrderRow(id) {
    return getDb().prepare(`${ORDER_SELECT} WHERE o.id = ?`).get(id);
}

function getOrder(id) {
    return toApiOrder(getOrderRow(id));
}

function createOrder({ id, title, sku, icon = '📦', buyerId, sellerId, amountMajor, currency = 'USD', status = 'CREATED', origin, destination, carrier }) {
    const db = getDb();
    const orderId = id || `GC-${crypto.randomInt(1000, 9999)}`;
    const ts = nowIso();
    db.transaction(() => {
        db.prepare(`
            INSERT INTO orders (id, title, sku, icon, buyer_id, seller_id, amount_minor, currency,
                                status, origin, destination, carrier, created_at, updated_at)
            VALUES (@id, @title, @sku, @icon, @buyerId, @sellerId, @amountMinor, @currency,
                    @status, @origin, @destination, @carrier, @ts, @ts)
        `).run({
            id: orderId, title, sku, icon, buyerId, sellerId,
            amountMinor: toMinor(amountMajor), currency, status,
            origin: origin || null, destination: destination || null, carrier: carrier || null, ts
        });
        for (const step of ['FUNDED', 'COURIER_DISPATCHED', 'INSPECTION_PENDING', 'RELEASED']) {
            db.prepare('INSERT OR IGNORE INTO order_milestones (order_id, step, completed) VALUES (?, ?, 0)')
                .run(orderId, step);
        }
    })();
    return getOrder(orderId);
}

function updateOrderStatus(orderId, status) {
    getDb().prepare('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?')
        .run(status, nowIso(), orderId);
}

function getMilestones(orderId) {
    return getDb().prepare('SELECT * FROM order_milestones WHERE order_id = ? ORDER BY rowid')
        .all(orderId)
        .map(row => ({ step: row.step, completed: Boolean(row.completed), timestamp: row.timestamp }));
}

function setMilestone(orderId, step, { completed = true, timestamp = nowIso(), actorId = null } = {}) {
    getDb().prepare(`
        INSERT INTO order_milestones (order_id, step, completed, timestamp, actor_id)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(order_id, step) DO UPDATE SET completed = excluded.completed,
                                                  timestamp = excluded.timestamp,
                                                  actor_id = excluded.actor_id
    `).run(orderId, step, completed ? 1 : 0, timestamp, actorId);
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

function toApiMessage(row) {
    if (!row) return null;
    const payload = parseJson(row.payload, null);
    const api = {
        id: row.id,
        orderId: row.order_id,
        sender: { id: row.sender_id, name: row.sender_name, role: row.sender_role },
        originalText: row.original_text,
        sanitizedText: row.sanitized_text,
        isMasked: Boolean(row.is_masked),
        violations: parseJson(row.violations, []),
        sourceLang: row.source_lang,
        targetLang: row.target_lang,
        translation: row.translated_text != null ? {
            translatedText: row.translated_text,
            confidenceScore: row.confidence,
            culturalAdaptation: row.cultural_adaptation,
            engine: row.engine
        } : null,
        timestamp: row.created_at
    };

    if (row.kind === 'deal_card') {
        api.type = 'deal_card';
        api.deal = payload || { title: row.original_text, status: 'BINDING_OFFER', terms: [] };
    } else if (payload) {
        api.payload = payload;
    }
    return api;
}

function listMessages(orderId) {
    return getDb().prepare('SELECT * FROM messages WHERE order_id = ? ORDER BY created_at, rowid')
        .all(orderId)
        .map(toApiMessage);
}

function getMessageById(id) {
    const row = getDb().prepare('SELECT * FROM messages WHERE id = ?').get(id);
    return toApiMessage(row);
}

function insertMessage({
    id, orderId, senderId, senderName, senderRole, kind = 'text', originalText,
    sanitizedText = null, isMasked = false, violations = [], sourceLang = null,
    targetLang = null, translatedText = null, confidence = null,
    culturalAdaptation = null, engine = null, payload = null, createdAt = nowIso()
}) {
    const messageId = id || `msg_${Date.now()}_${crypto.randomBytes(2).toString('hex')}`;
    getDb().prepare(`
        INSERT INTO messages (id, order_id, sender_id, sender_name, sender_role, kind, original_text,
                              sanitized_text, is_masked, violations, source_lang, target_lang,
                              translated_text, confidence, cultural_adaptation, engine, payload, created_at)
        VALUES (@id, @orderId, @senderId, @senderName, @senderRole, @kind, @originalText,
                @sanitizedText, @isMasked, @violations, @sourceLang, @targetLang,
                @translatedText, @confidence, @culturalAdaptation, @engine, @payload, @createdAt)
    `).run({
        id: messageId, orderId, senderId, senderName, senderRole, kind, originalText,
        sanitizedText, isMasked: isMasked ? 1 : 0, violations: JSON.stringify(violations || []),
        sourceLang, targetLang, translatedText, confidence, culturalAdaptation, engine,
        payload: payload ? (typeof payload === 'string' ? payload : JSON.stringify(payload)) : null,
        createdAt
    });
    return toApiMessage(getDb().prepare('SELECT * FROM messages WHERE id = ?').get(messageId));
}

// ---------------------------------------------------------------------------
// Deal cards (offer / counter / accept workflow)
// ---------------------------------------------------------------------------

function listDeals(orderId) {
    return getDb().prepare('SELECT * FROM deals WHERE order_id = ? ORDER BY created_at').all(orderId)
        .map(row => ({ ...row, terms: parseJson(row.terms, []) }));
}

function createDeal({ orderId, title, terms = [], proposedBy, status = 'PROPOSED', counterOf = null }) {
    const id = `deal_${Date.now()}_${crypto.randomBytes(2).toString('hex')}`;
    getDb().prepare(`
        INSERT INTO deals (id, order_id, title, status, terms, proposed_by, counter_of, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, orderId, title, status, JSON.stringify(terms), proposedBy, counterOf, nowIso());

    // Mirror the deal into the channel as a deal_card message so both sides see it
    insertMessage({
        id, orderId, senderId: proposedBy, senderName: 'Deal Desk', senderRole: 'system',
        kind: 'deal_card', originalText: title, payload: { title, status, terms }
    });
    return { id, orderId, title, status, terms, proposedBy, counterOf, createdAt: nowIso() };
}

function resolveDeal(id, status) {
    getDb().prepare('UPDATE deals SET status = ?, resolved_at = ? WHERE id = ?')
        .run(status, nowIso(), id);
    const row = getDb().prepare('SELECT * FROM deals WHERE id = ?').get(id);
    return row ? { ...row, terms: parseJson(row.terms, []) } : null;
}

// ---------------------------------------------------------------------------
// Escrow ledger — mock funds, production controls:
// idempotency keys, append-only entries, role-checked transitions
// ---------------------------------------------------------------------------

function appendLedgerEntry({ orderId, type, amountMinor, currency = 'USD', idempotencyKey = null, actorId = null, reason = null }) {
    const db = getDb();
    if (idempotencyKey) {
        const existing = db.prepare('SELECT * FROM escrow_ledger WHERE idempotency_key = ?').get(idempotencyKey);
        if (existing) return { entry: existing, created: false };
    }
    const info = db.prepare(`
        INSERT INTO escrow_ledger (order_id, type, amount_minor, currency, idempotency_key, actor_id, reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(orderId, type, amountMinor, currency, idempotencyKey, actorId, reason, nowIso());

    const entry = db.prepare('SELECT * FROM escrow_ledger WHERE id = ?').get(info.lastInsertRowid);
    return { entry, created: true };
}

function listLedger(orderId) {
    return getDb().prepare('SELECT * FROM escrow_ledger WHERE order_id = ? ORDER BY id').all(orderId);
}

function ledgerTotals() {
    const rows = getDb().prepare(`
        SELECT
          COALESCE(SUM(CASE WHEN type = 'FUNDS_HELD' THEN amount_minor END), 0) AS held_minor,
          COALESCE(SUM(CASE WHEN type IN ('RELEASE','REFUND','SETTLEMENT') THEN amount_minor END), 0) AS out_minor,
          COALESCE(SUM(CASE WHEN type IN ('FUNDS_HELD','RELEASE','REFUND','SETTLEMENT') THEN amount_minor END), 0) AS gross_minor,
          COUNT(*) AS entries
        FROM escrow_ledger
    `).get();
    return {
        heldMinor: rows.held_minor,
        outMinor: rows.out_minor,
        grossMinor: rows.gross_minor,
        entries: rows.entries
    };
}

// ---------------------------------------------------------------------------
// Disputes, case history, evidence
// ---------------------------------------------------------------------------

function toApiDispute(row) {
    if (!row) return null;
    return {
        id: row.id,
        orderId: row.order_id,
        openedBy: row.opened_by,
        openedAt: row.opened_at,
        deadline72Hr: row.deadline_at,
        deadlineAt: row.deadline_at,
        category: row.category,
        status: row.status,
        rootCause: row.root_cause,
        settlementProposals: parseJson(row.proposals, []),
        resolution: row.resolution,
        resolvedBy: row.resolved_by,
        resolvedAt: row.resolved_at
    };
}

function getDispute(id) {
    return toApiDispute(getDb().prepare('SELECT * FROM disputes WHERE id = ?').get(id));
}

function getDisputeRow(id) {
    return getDb().prepare('SELECT * FROM disputes WHERE id = ?').get(id);
}

function getActiveDisputeForOrder(orderId) {
    const row = getDb().prepare(`
        SELECT * FROM disputes
        WHERE order_id = ? AND status IN ('AI_MEDIATION_ACTIVE','OPEN','ESCALATED_TO_AGENT')
        ORDER BY opened_at DESC LIMIT 1
    `).get(orderId);
    return row || null;
}

function listDisputes({ status = null, limit = 100 } = {}) {
    const db = getDb();
    const rows = status
        ? db.prepare('SELECT * FROM disputes WHERE status = ? ORDER BY opened_at DESC LIMIT ?').all(status, limit)
        : db.prepare('SELECT * FROM disputes ORDER BY opened_at DESC LIMIT ?').all(limit);
    return rows.map(toApiDispute);
}

function createDispute({ orderId, openedBy, category = null, rootCause = null, proposals = [], status = 'AI_MEDIATION_ACTIVE', deadlineAt = new Date(Date.now() + 72 * 3600 * 1000).toISOString() }) {
    const id = `dsp_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    getDb().prepare(`
        INSERT INTO disputes (id, order_id, opened_by, opened_at, deadline_at, category, status, root_cause, proposals)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, orderId, openedBy, nowIso(), deadlineAt, category, status, rootCause, JSON.stringify(proposals || []));
    return getDispute(id);
}

function updateDispute(id, patch = {}) {
    const fields = [];
    const values = [];
    const map = {
        status: 'status', rootCause: 'root_cause', resolution: 'resolution',
        resolvedBy: 'resolved_by', resolvedAt: 'resolved_at', category: 'category',
        proposals: 'proposals'
    };
    for (const [key, column] of Object.entries(map)) {
        if (patch[key] !== undefined) {
            fields.push(`${column} = ?`);
            values.push(key === 'proposals' ? JSON.stringify(patch[key]) : patch[key]);
        }
    }
    if (!fields.length) return getDispute(id);
    values.push(id);
    getDb().prepare(`UPDATE disputes SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    return getDispute(id);
}

function addDisputeEvent({ disputeId, actorId = null, eventType, summary, payload = null }) {
    const info = getDb().prepare(`
        INSERT INTO dispute_events (dispute_id, actor_id, event_type, summary, payload, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(disputeId, actorId, eventType, summary,
        payload ? (typeof payload === 'string' ? payload : JSON.stringify(payload)) : null,
        nowIso());
    return getDb().prepare('SELECT * FROM dispute_events WHERE id = ?').get(info.lastInsertRowid);
}

function listDisputeEvents(disputeId) {
    return getDb().prepare('SELECT * FROM dispute_events WHERE dispute_id = ? ORDER BY id')
        .all(disputeId)
        .map(row => ({ ...row, payload: parseJson(row.payload, null) }));
}

function addEvidence({ disputeId, uploadedBy, kind, filename, mime, sizeBytes, sha256: digest, storagePath = null, note = null }) {
    const id = `evd_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    getDb().prepare(`
        INSERT INTO evidence (id, dispute_id, uploaded_by, kind, filename, mime, size_bytes, sha256, storage_path, note, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, disputeId, uploadedBy, kind, filename, mime, sizeBytes, digest, storagePath, note, nowIso());
    return getEvidence(id);
}

function getEvidence(id) {
    return getDb().prepare('SELECT * FROM evidence WHERE id = ?').get(id) || null;
}

function listEvidence(disputeId) {
    return getDb().prepare('SELECT * FROM evidence WHERE dispute_id = ? ORDER BY created_at').all(disputeId);
}

// ---------------------------------------------------------------------------
// Glossary
// ---------------------------------------------------------------------------

function toApiGlossary(row) {
    return {
        id: row.id,
        category: row.category,
        sourceTerm: row.source_term,
        translations: parseJson(row.translations, {}),
        contextNote: row.context_note,
        usageCount: row.usage_count,
        createdAt: row.created_at
    };
}

function listGlossary() {
    return getDb().prepare('SELECT * FROM glossary ORDER BY usage_count DESC, rowid').all()
        .map(toApiGlossary);
}

function createGlossary({ sourceTerm, category = 'General Commercial', contextNote = 'Custom merchant terminology preference', translations = {} }) {
    const id = `glo_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    const merged = {
        en: translations.en || sourceTerm,
        ar: translations.ar || `[مصطلح تجاري]: ${sourceTerm}`,
        es: translations.es || `[Término]: ${sourceTerm}`,
        ja: translations.ja || `[用語]: ${sourceTerm}`,
        de: translations.de || `[Fachbegriff]: ${sourceTerm}`,
        ...translations
    };
    getDb().prepare(`
        INSERT INTO glossary (id, category, source_term, translations, context_note, usage_count, created_at)
        VALUES (?, ?, ?, ?, ?, 1, ?)
    `).run(id, category, sourceTerm, JSON.stringify(merged), contextNote, nowIso());
    return toApiGlossary(getDb().prepare('SELECT * FROM glossary WHERE id = ?').get(id));
}

function incrementGlossaryUsage(sourceTerms) {
    if (!sourceTerms || !sourceTerms.length) return;
    const stmt = getDb().prepare('UPDATE glossary SET usage_count = usage_count + 1 WHERE source_term = ?');
    const run = getDb().transaction(terms => { for (const term of terms) stmt.run(term); });
    run(sourceTerms);
}

// ---------------------------------------------------------------------------
// Translation log (powers the real dashboard numbers)
// ---------------------------------------------------------------------------

function logTranslation({ orderId = null, sourceLang, targetLang, engine, confidence = null, latencyMs, cached = false, charCount = 0 }) {
    getDb().prepare(`
        INSERT INTO translation_log (order_id, source_lang, target_lang, engine, confidence, latency_ms, cached, char_count, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(orderId, sourceLang, targetLang, engine, confidence, latencyMs, cached ? 1 : 0, charCount, nowIso());
}

function translationStats() {
    const db = getDb();
    const totals = db.prepare(`
        SELECT COUNT(*) AS count,
               COALESCE(SUM(latency_ms), 0) AS latency_sum,
               COALESCE(AVG(confidence), 0) AS avg_confidence,
               COALESCE(SUM(cached), 0) AS cached_count
        FROM translation_log
    `).get();

    // Baseline counters seeded at install keep demo numbers realistic before
    // real traffic exists; live rows are added on top.
    const baselineRow = db.prepare(`
        SELECT detail FROM audit_log WHERE action = 'SEED_BASELINE' ORDER BY id LIMIT 1
    `).get();
    const baseline = parseJson(baselineRow ? baselineRow.detail : null, {}) || {};

    const byEngine = db.prepare(`
        SELECT engine, COUNT(*) AS count FROM translation_log GROUP BY engine ORDER BY count DESC
    `).all();

    const recent = db.prepare(`
        SELECT * FROM translation_log ORDER BY id DESC LIMIT 25
    `).all();

    const baselineCount = Number(baseline.translationsCount || 0);
    const baselineLatency = Number(baseline.totalLatencySum || 0);
    const count = totals.count + baselineCount;
    const latencySum = totals.latency_sum + baselineLatency;

    return {
        translationsCount: count,
        liveTranslations: totals.count,
        cachedTranslations: totals.cached_count,
        avgLatencyMs: count > 0 ? Number((latencySum / count).toFixed(1)) : 0,
        avgConfidence: totals.count > 0 ? Number(Number(totals.avg_confidence).toFixed(3)) : null,
        byEngine,
        recent
    };
}

// ---------------------------------------------------------------------------
// Security events + audit log
// ---------------------------------------------------------------------------

function addSecurityEvent({ channel = null, eventType, redactedPattern = null, details = null, severity = 'MEDIUM' }) {
    const id = `sec_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    getDb().prepare(`
        INSERT INTO security_events (id, ts, channel, event_type, redacted_pattern, details, severity)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, nowIso(), channel, eventType, redactedPattern, details, severity);
    return id;
}

function listSecurityEvents(limit = 10) {
    return getDb().prepare('SELECT * FROM security_events ORDER BY ts DESC, rowid DESC LIMIT ?')
        .all(limit)
        .map(row => ({
            id: row.id,
            timestamp: row.ts,
            eventType: row.event_type,
            channel: row.channel,
            redactedPattern: row.redacted_pattern,
            details: row.details,
            severity: row.severity
        }));
}

function countSecurityEvents() {
    return getDb().prepare('SELECT COUNT(*) AS c FROM security_events').get().c;
}

function baselineLeaksBlocked() {
    const row = getDb().prepare(`
        SELECT detail FROM audit_log WHERE action = 'SEED_BASELINE' ORDER BY id LIMIT 1
    `).get();
    const baseline = parseJson(row ? row.detail : null, {}) || {};
    return Number(baseline.leaksBlockedCounter || 0);
}

function addAudit({ actorId = null, actorRole = null, action, targetType = null, targetId = null, ip = null, detail = null, severity = 'INFO' }) {
    getDb().prepare(`
        INSERT INTO audit_log (ts, actor_id, actor_role, action, target_type, target_id, ip, detail, severity)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(nowIso(), actorId, actorRole, action, targetType, targetId, ip,
        detail ? (typeof detail === 'string' ? detail : JSON.stringify(detail)) : null,
        severity);
}

function listAudit({ limit = 50, action = null } = {}) {
    const db = getDb();
    const rows = action
        ? db.prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY id DESC LIMIT ?').all(action, limit)
        : db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit);
    return rows.map(row => ({ ...row, detail: parseJson(row.detail, null) }));
}

// ---------------------------------------------------------------------------
// Aggregations used by the metrics dashboard (real data, no hardcoded samples)
// ---------------------------------------------------------------------------

const LANG_NAMES = {
    en: 'English', ar: 'Arabic', es: 'Spanish', ja: 'Japanese', de: 'German', it: 'Italian'
};

/** Language-pair distribution computed from the live translation log. */
function translationPairStats() {
    const rows = getDb().prepare(`
        SELECT source_lang, target_lang, COUNT(*) AS count
        FROM translation_log
        GROUP BY source_lang, target_lang
        ORDER BY count DESC, source_lang
    `).all();
    const total = rows.reduce((sum, row) => sum + row.count, 0);
    return rows.map(row => ({
        pair: `${LANG_NAMES[row.source_lang] || row.source_lang} (${row.source_lang}) ⟷ ${LANG_NAMES[row.target_lang] || row.target_lang} (${row.target_lang})`,
        sourceLang: row.source_lang,
        targetLang: row.target_lang,
        count: row.count,
        share: total > 0 ? Math.round((row.count / total) * 100) : 0
    }));
}

/** Total redaction instances across all security events (seeded + runtime). */
function violationTotal() {
    const rows = getDb().prepare('SELECT COALESCE(redacted_pattern, \'\' ) AS patterns FROM security_events').all();
    return rows.reduce((sum, row) =>
        sum + (row.patterns ? row.patterns.split(',').map(s => s.trim()).filter(Boolean).length : 0), 0);
}

/** Average dispute resolution time in hours from resolved cases (null when none). */
function avgResolutionHours() {
    const rows = getDb().prepare(`
        SELECT opened_at, resolved_at FROM disputes
        WHERE resolved_at IS NOT NULL AND opened_at IS NOT NULL
    `).all();
    if (!rows.length) return null;
    const total = rows.reduce((sum, row) => {
        const start = Date.parse(row.opened_at);
        const end = Date.parse(row.resolved_at);
        return sum + (Number.isFinite(start) && Number.isFinite(end) && end >= start
            ? (end - start) / 3_600_000
            : 0);
    }, 0);
    return Number((total / rows.length).toFixed(1));
}

// ---------------------------------------------------------------------------
// Authorization helpers (single source of truth for access decisions)
// ---------------------------------------------------------------------------

function canAccessOrder(user, orderId) {
    if (!user) return false;
    if (user.role === 'agent') return true;
    const order = getOrderRow(orderId);
    if (!order) return false;
    return order.buyer_id === user.id || order.seller_id === user.id ||
        (user.demoOrderIds || []).includes(orderId);
}

function canPerformEscrowAction(user, order, action) {
    if (!user || !order) return false;
    const isBuyer = user.id === order.buyerId ||
        ((user.demoOrderIds || []).includes(order.id) && user.role === 'buyer');
    const isSeller = user.id === order.sellerId ||
        ((user.demoOrderIds || []).includes(order.id) && user.role === 'seller');
    const isAgent = user.role === 'agent';

    if (action === 'DISPATCH') return isBuyer || isSeller || isAgent;
    if (action === 'DELIVER' || action === 'RELEASE') return isBuyer || isAgent;
    if (action === 'DISPUTE') return isBuyer || isSeller || isAgent;
    if (['SETTLE_PARTIAL', 'SETTLE_REFUND', 'SETTLE_AGENT'].includes(action)) return isAgent;
    return false;
}

module.exports = {
    // money / utils
    toMinor, toMajor, randomId, parseJson, sha256, nowIso,
    // users
    getUserById, getUserByEmail, listUsers, createUser, updateUserCredentials, setDemoOrderIds,
    // sessions
    createSession, getSession, deleteSession, pruneExpiredSessions, countActiveSessions, SESSION_TTL_MS,
    // orders
    listOrders, getOrder, getOrderRow, createOrder, updateOrderStatus, getMilestones, setMilestone, toApiOrder,
    // messages / deals
    listMessages, getMessageById, insertMessage, toApiMessage, listDeals, createDeal, resolveDeal,
    // escrow ledger
    appendLedgerEntry, listLedger, ledgerTotals,
    // disputes
    getDispute, getDisputeRow, getActiveDisputeForOrder, listDisputes, createDispute, updateDispute,
    addDisputeEvent, listDisputeEvents, addEvidence, getEvidence, listEvidence, toApiDispute,
    // glossary
    listGlossary, createGlossary, incrementGlossaryUsage, toApiGlossary,
    // translation log
    logTranslation, translationStats, translationPairStats, violationTotal, avgResolutionHours,
    // security / audit
    addSecurityEvent, listSecurityEvents, countSecurityEvents, baselineLeaksBlocked, addAudit, listAudit,
    // authz
    canAccessOrder, canPerformEscrowAction
};
