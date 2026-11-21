/**
 * GlobalConnect — SQLite persistence layer (better-sqlite3)
 *
 * Single source of truth for: users, sessions, orders, messages, deals,
 * escrow ledger, disputes + evidence, glossary, translation log,
 * security events and the audit log.
 *
 * Design notes:
 * - Money is stored in MINOR units (integer cents) to avoid float drift.
 *   API responses keep exposing major units (`amount`) for compatibility.
 * - Session tokens are stored hashed (sha256) so a DB leak cannot be
 *   replayed as a live session.
 * - WAL mode + foreign keys on; all writes go through prepared statements.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const DEFAULT_DB_PATH = path.join(ROOT, 'db', 'globalconnect.db');

let db = null;
let dbPath = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  email           TEXT UNIQUE,
  role            TEXT NOT NULL CHECK (role IN ('buyer','seller','agent')),
  lang            TEXT NOT NULL DEFAULT 'en',
  trust_score     INTEGER NOT NULL DEFAULT 100,
  password_salt   TEXT,
  password_hash   TEXT,
  demo_order_ids  TEXT NOT NULL DEFAULT '[]',
  nexconn_user_id TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash   TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  ip           TEXT,
  user_agent   TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS orders (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  sku          TEXT NOT NULL,
  icon         TEXT NOT NULL DEFAULT '📦',
  buyer_id     TEXT NOT NULL REFERENCES users(id),
  seller_id    TEXT NOT NULL REFERENCES users(id),
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
  currency     TEXT NOT NULL DEFAULT 'USD',
  status       TEXT NOT NULL,
  origin       TEXT,
  destination  TEXT,
  carrier      TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS order_milestones (
  order_id   TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  step       TEXT NOT NULL,
  completed  INTEGER NOT NULL DEFAULT 0,
  timestamp  TEXT,
  actor_id   TEXT,
  PRIMARY KEY (order_id, step)
);

CREATE TABLE IF NOT EXISTS messages (
  id                 TEXT PRIMARY KEY,
  order_id           TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  sender_id          TEXT,
  sender_name        TEXT,
  sender_role        TEXT NOT NULL,
  kind               TEXT NOT NULL DEFAULT 'text',
  original_text      TEXT NOT NULL,
  sanitized_text     TEXT,
  is_masked          INTEGER NOT NULL DEFAULT 0,
  violations         TEXT NOT NULL DEFAULT '[]',
  source_lang        TEXT,
  target_lang        TEXT,
  translated_text    TEXT,
  confidence         REAL,
  cultural_adaptation TEXT,
  engine             TEXT,
  payload            TEXT,
  created_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_order ON messages(order_id, created_at);

CREATE TABLE IF NOT EXISTS deals (
  id          TEXT PRIMARY KEY,
  order_id    TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  status      TEXT NOT NULL,
  terms       TEXT NOT NULL DEFAULT '[]',
  proposed_by TEXT NOT NULL,
  counter_of  TEXT,
  created_at  TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_deals_order ON deals(order_id, created_at);

CREATE TABLE IF NOT EXISTS escrow_ledger (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id        TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  type            TEXT NOT NULL,
  amount_minor    INTEGER NOT NULL,
  currency        TEXT NOT NULL DEFAULT 'USD',
  idempotency_key TEXT UNIQUE,
  actor_id        TEXT,
  reason          TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_order ON escrow_ledger(order_id, id);

CREATE TABLE IF NOT EXISTS disputes (
  id          TEXT PRIMARY KEY,
  order_id    TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  opened_by   TEXT NOT NULL,
  opened_at   TEXT NOT NULL,
  deadline_at TEXT NOT NULL,
  category    TEXT,
  status      TEXT NOT NULL,
  root_cause  TEXT,
  proposals   TEXT NOT NULL DEFAULT '[]',
  resolution  TEXT,
  resolved_by TEXT,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_disputes_order ON disputes(order_id, opened_at);

CREATE TABLE IF NOT EXISTS dispute_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  dispute_id  TEXT NOT NULL REFERENCES disputes(id) ON DELETE CASCADE,
  actor_id    TEXT,
  event_type  TEXT NOT NULL,
  summary     TEXT NOT NULL,
  payload     TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dispute_events ON dispute_events(dispute_id, id);

CREATE TABLE IF NOT EXISTS evidence (
  id           TEXT PRIMARY KEY,
  dispute_id   TEXT NOT NULL REFERENCES disputes(id) ON DELETE CASCADE,
  uploaded_by  TEXT NOT NULL,
  kind         TEXT NOT NULL,
  filename     TEXT NOT NULL,
  mime         TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL,
  sha256       TEXT NOT NULL,
  storage_path TEXT,
  note         TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evidence_dispute ON evidence(dispute_id, created_at);

CREATE TABLE IF NOT EXISTS glossary (
  id           TEXT PRIMARY KEY,
  category     TEXT NOT NULL,
  source_term  TEXT NOT NULL,
  translations TEXT NOT NULL DEFAULT '{}',
  context_note TEXT,
  usage_count  INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS translation_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id    TEXT,
  source_lang TEXT NOT NULL,
  target_lang TEXT NOT NULL,
  engine      TEXT NOT NULL,
  confidence  REAL,
  latency_ms  REAL NOT NULL,
  cached      INTEGER NOT NULL DEFAULT 0,
  char_count  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_translation_log_ts ON translation_log(created_at);

CREATE TABLE IF NOT EXISTS security_events (
  id              TEXT PRIMARY KEY,
  ts              TEXT NOT NULL,
  channel         TEXT,
  event_type      TEXT NOT NULL,
  redacted_pattern TEXT,
  details         TEXT,
  severity        TEXT NOT NULL DEFAULT 'MEDIUM'
);

CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT NOT NULL,
  actor_id    TEXT,
  actor_role  TEXT,
  action      TEXT NOT NULL,
  target_type TEXT,
  target_id   TEXT,
  ip          TEXT,
  detail      TEXT,
  severity    TEXT NOT NULL DEFAULT 'INFO'
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);
`;

// ---------------------------------------------------------------------------
// Seed data — mirrors the original demo dataset (3 orders, 6 personas,
// bilingual channel history, glossary, baseline metrics).
// ---------------------------------------------------------------------------

function nowIso() {
    return new Date().toISOString();
}

function sha256(value) {
    return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function seedUsers(stmt) {
    const insert = stmt(`
        INSERT OR IGNORE INTO users
            (id, name, email, role, lang, trust_score, demo_order_ids, created_at, updated_at)
        VALUES (@id, @name, @email, @role, @lang, @trustScore, @demoOrderIds, @ts, @ts)
    `);

    const users = [
        { id: 'buyer_dubai_12', name: 'Tariq Al-Mansoor', email: 'buyer@globalconnect.io', role: 'buyer', lang: 'ar', trustScore: 98, demoOrderIds: ['GC-9821'] },
        { id: 'buyer_munich_55', name: 'Klaus Weber', email: null, role: 'buyer', lang: 'de', trustScore: 97, demoOrderIds: ['GC-7740'] },
        { id: 'buyer_kyoto_09', name: 'Kenji Sato', email: null, role: 'buyer', lang: 'ja', trustScore: 99, demoOrderIds: ['GC-6102'] },
        { id: 'seller_milan_88', name: 'Marco Rossi', email: 'seller@globalconnect.io', role: 'seller', lang: 'en', trustScore: 99, demoOrderIds: ['GC-9821', 'GC-7740'] },
        { id: 'seller_london_33', name: 'Emma Watson', email: null, role: 'seller', lang: 'en', trustScore: 98, demoOrderIds: ['GC-6102'] },
        { id: 'agent_support_01', name: 'Sarah Chen', email: 'agent@globalconnect.io', role: 'agent', lang: 'en', trustScore: 100, demoOrderIds: [] }
    ];

    const ts = nowIso();
    for (const user of users) {
        insert.run({
            ...user,
            demoOrderIds: JSON.stringify(user.demoOrderIds || []),
            ts
        });
    }
}

function seedOrders(stmt) {
    const insertOrder = stmt(`
        INSERT OR IGNORE INTO orders
            (id, title, sku, icon, buyer_id, seller_id, amount_minor, currency, status,
             origin, destination, carrier, created_at, updated_at)
        VALUES (@id, @title, @sku, @icon, @buyerId, @sellerId, @amountMinor, @currency, @status,
                @origin, @destination, @carrier, @createdAt, @createdAt)
    `);
    const insertMilestone = stmt(`
        INSERT OR IGNORE INTO order_milestones (order_id, step, completed, timestamp)
        VALUES (?, ?, ?, ?)
    `);

    const orders = [
        {
            id: 'GC-9821', title: 'Vintage Italian Leather Jacket', sku: 'GC-LEATHER-50 • Size EU 50', icon: '🧥',
            buyerId: 'buyer_dubai_12', sellerId: 'seller_milan_88', amountMinor: 24900, currency: 'USD',
            status: 'ESCROW_FUNDED', origin: 'Milan, Italy', destination: 'Dubai, UAE', carrier: 'DHL Express',
            createdAt: '2026-10-24T14:30:00Z',
            milestones: [
                ['FUNDED', 1, '2026-10-24T14:30:00Z'],
                ['COURIER_DISPATCHED', 1, '2026-10-25T09:15:00Z'],
                ['INSPECTION_PENDING', 0, null],
                ['RELEASED', 0, null]
            ]
        },
        {
            id: 'GC-7740', title: 'Swiss Chrono Watch (42mm)', sku: 'SWISS-CHRONO-42 • Sapphire Crystal', icon: '⌚',
            buyerId: 'buyer_munich_55', sellerId: 'seller_milan_88', amountMinor: 185000, currency: 'USD',
            status: 'IN_TRANSIT', origin: 'Geneva, Switzerland', destination: 'Munich, Germany', carrier: 'FedEx Priority',
            createdAt: '2026-10-25T11:00:00Z',
            milestones: [
                ['FUNDED', 1, '2026-10-25T11:00:00Z'],
                ['COURIER_DISPATCHED', 1, '2026-10-25T13:30:00Z'],
                ['INSPECTION_PENDING', 0, null],
                ['RELEASED', 0, null]
            ]
        },
        {
            id: 'GC-6102', title: 'Kyoto Silk Kimono Fabric', sku: 'KYOTO-SILK-BOLT-12 • Gold Thread', icon: '👘',
            buyerId: 'buyer_kyoto_09', sellerId: 'seller_london_33', amountMinor: 42000, currency: 'USD',
            status: 'ESCROW_FROZEN', origin: 'Kyoto, Japan', destination: 'London, UK', carrier: 'Japan Post EMS',
            createdAt: '2026-10-22T08:00:00Z',
            milestones: [
                ['FUNDED', 1, '2026-10-22T08:00:00Z'],
                ['COURIER_DISPATCHED', 1, '2026-10-22T10:00:00Z'],
                ['INSPECTION_PENDING', 0, null],
                ['RELEASED', 0, null]
            ]
        }
    ];

    for (const order of orders) {
        insertOrder.run(order);
        for (const [step, completed, timestamp] of order.milestones) {
            insertMilestone.run(order.id, step, completed, timestamp);
        }
    }
}

function seedMessages(stmt) {
    const insert = stmt(`
        INSERT OR IGNORE INTO messages
            (id, order_id, sender_id, sender_name, sender_role, kind, original_text,
             source_lang, target_lang, translated_text, confidence, cultural_adaptation,
             payload, created_at)
        VALUES (@id, @orderId, @senderId, @senderName, @senderRole, @kind, @originalText,
                @sourceLang, @targetLang, @translatedText, @confidence, @culturalAdaptation,
                @payload, @createdAt)
    `);

    const messages = [
        {
            id: 'msg_9821_1', orderId: 'GC-9821', senderId: 'buyer_dubai_12', senderName: 'Tariq Al-Mansoor', senderRole: 'buyer',
            kind: 'text', originalText: 'مرحباً، هل مقاس الجاكيت مناسب للمقاسات الأوروبية القياسية؟ وهل الجلد طبيعي أصلي؟',
            sourceLang: 'ar', targetLang: 'en',
            translatedText: 'Hello, is the jacket size true to standard European sizing? And is the leather 100% genuine calfskin?',
            confidence: 0.992, culturalAdaptation: 'Polite formal inquiry. Product specs automatically mapped.',
            payload: null, createdAt: '2026-10-24T14:32:00Z'
        },
        {
            id: 'deal_9821_1', orderId: 'GC-9821', senderId: 'system', senderName: 'GlobalConnect Escrow', senderRole: 'system',
            kind: 'deal_card', originalText: 'Proposed Purchase Specification Agreement',
            sourceLang: null, targetLang: null, translatedText: null, confidence: null, culturalAdaptation: null,
            payload: JSON.stringify({
                title: 'Proposed Purchase Specification Agreement',
                status: 'BINDING_OFFER',
                terms: [
                    'Item: Vintage Italian Leather Jacket (EU 50 / L)',
                    'Agreed Amount: $249.00 USD (Includes DHL International Courier)',
                    'Inspection Guarantee: 48-hour return window for authenticity verification'
                ]
            }),
            createdAt: '2026-10-24T14:33:00Z'
        },
        {
            id: 'msg_9821_2', orderId: 'GC-9821', senderId: 'seller_milan_88', senderName: 'Marco Rossi', senderRole: 'seller',
            kind: 'text', originalText: 'Yes, exactly true to European EU 50 sizing. It is handcrafted Tuscan full-grain leather with certified authenticity tags.',
            sourceLang: 'en', targetLang: 'ar',
            translatedText: 'نعم، المقاس مطابق تماماً للمقاس الأوروبي EU 50. وهو مصنوع يدوياً من جلد توسكاني طبيعي أصلي عالي الجودة مع بطاقات المصادقة المعتمدة.',
            confidence: 0.988, culturalAdaptation: 'Merchant specification clarification verified.',
            payload: null, createdAt: '2026-10-24T14:34:00Z'
        },
        {
            id: 'msg_7740_1', orderId: 'GC-7740', senderId: 'buyer_munich_55', senderName: 'Klaus Weber', senderRole: 'buyer',
            kind: 'text', originalText: 'Guten Tag, liegt dem Chronographen das originale Garantiezertifikat und die Originalverpackung bei?',
            sourceLang: 'de', targetLang: 'en',
            translatedText: 'Good day, does the chronograph come with the original warranty certificate and box?',
            confidence: 0.994, culturalAdaptation: 'Formal German commercial inquiry.',
            payload: null, createdAt: '2026-10-25T11:15:00Z'
        },
        {
            id: 'msg_7740_2', orderId: 'GC-7740', senderId: 'seller_milan_88', senderName: 'Marco Rossi', senderRole: 'seller',
            kind: 'text', originalText: 'Yes, complete set with original 2024 stamped papers and manufacturer presentation case.',
            sourceLang: 'en', targetLang: 'de',
            translatedText: 'Ja, vollständiges Set mit Originalpapieren von 2024 und Hersteller-Präsentationsbox.',
            confidence: 0.991, culturalAdaptation: 'Commercial documentation assurance.',
            payload: null, createdAt: '2026-10-25T11:22:00Z'
        },
        {
            id: 'msg_6102_1', orderId: 'GC-6102', senderId: 'buyer_kyoto_09', senderName: 'Kenji Sato', senderRole: 'buyer',
            kind: 'text', originalText: '税関の書類手続きについて、インボイスの再発行をお願いできますでしょうか？',
            sourceLang: 'ja', targetLang: 'en',
            translatedText: 'Regarding the customs documentation procedures, could you please reissue the commercial invoice?',
            confidence: 0.989, culturalAdaptation: 'Japanese business Keigo (polite request).',
            payload: null, createdAt: '2026-10-22T08:10:00Z'
        },
        {
            id: 'msg_6102_2', orderId: 'GC-6102', senderId: 'agent_support_01', senderName: 'Sarah Chen (Bilingual Agent)', senderRole: 'agent',
            kind: 'text', originalText: 'I have uploaded the stamped bilingual commercial invoice. Escrow funds remain secured during customs clearance.',
            sourceLang: 'en', targetLang: 'ja',
            translatedText: '捺印済みのバイリンガル商業送り状をアップロードいたしました。通関中もエスクロー資金は安全に保護されております。',
            confidence: 0.995, culturalAdaptation: 'Certified dispute mediation assurance.',
            payload: null, createdAt: '2026-10-22T09:40:00Z'
        }
    ];

    for (const message of messages) insert.run(message);
}

function seedGlossary(stmt) {
    const insert = stmt(`
        INSERT OR IGNORE INTO glossary (id, category, source_term, translations, context_note, usage_count, created_at)
        VALUES (@id, @category, @sourceTerm, @translations, @contextNote, @usageCount, @ts)
    `);

    const entries = [
        {
            id: 'glo_1', category: 'Product Sizing', sourceTerm: 'EU 50',
            translations: { en: 'EU 50 (US 40 / Large)', ar: 'المقاس الأوروبي 50 (يعادل US 40 / L)', es: 'Talla europea 50 (equivale a US 40 / Grande)', ja: 'EU 50（US 40 / 日本サイズ L 相当）', de: 'EU 50 (Größe L / US 40)' },
            contextNote: 'Standardized cross-border apparel garment sizing conversion', usageCount: 42
        },
        {
            id: 'glo_2', category: 'Material Quality', sourceTerm: 'full-grain leather',
            translations: { en: 'certified full-grain calfskin', ar: 'جلد عجل طبيعي كامل الحبيبات عالي الجودة', es: 'cuero plena flor vacuno certificado', ja: '認定フルグレインカーフレザー（最高級本革）', de: 'zertifiziertes Vollnarben-Kalbsleder' },
            contextNote: 'Prevents material specification disputes upon delivery receipt', usageCount: 88
        },
        {
            id: 'glo_3', category: 'Customs Documentation', sourceTerm: 'HS 5007.20',
            translations: { en: 'Harmonized Tariff Code HS 5007.20 (Woven Silk Fabric)', ar: 'رمز النظام المنسق الجمركي HS 5007.20 (أقمشة حرير منسوجة)', es: 'Código arancelario armonizado HS 5007.20 (Tejidos de seda)', ja: '国際HS関税分類コード 5007.20（絹織物）', de: 'Zolltarifcode HS 5007.20 (Gewebe aus Seide)' },
            contextNote: 'Eliminates bonded terminal customs clearance holds at Heathrow & Royal Mail', usageCount: 19
        },
        {
            id: 'glo_4', category: 'Commercial Negotiation', sourceTerm: 'durable',
            translations: { en: 'heavy-duty commercial durability guaranteed', ar: 'متين فائق التحمل مع ضمان تجاري معتمد', es: 'resistente de alta durabilidad garantizada', ja: '優れた高耐久性（商用品質保証付き）', de: 'äußerst strapazierfähig und langlebig' },
            contextNote: 'Merchant preference calibration (e.g. durable -> resistente in Spanish)', usageCount: 65
        }
    ];

    const ts = nowIso();
    for (const entry of entries) insert.run({ ...entry, translations: JSON.stringify(entry.translations), ts });
}

function seedSecurityEvents(stmt) {
    const insert = stmt(`
        INSERT OR IGNORE INTO security_events (id, ts, channel, event_type, redacted_pattern, details, severity)
        VALUES (@id, @ts, @channel, @eventType, @redactedPattern, @details, @severity)
    `);

    [
        {
            id: 'sec_1', ts: '2026-10-25T14:10:00Z', channel: 'GC-9821', eventType: 'OFF_PLATFORM_CONTACT_BLOCKED',
            redactedPattern: 'PHONE_NUMBER_DETECTED', details: 'Buyer attempted to exchange unencrypted phone contact (+971 50 ...)', severity: 'MEDIUM'
        },
        {
            id: 'sec_2', ts: '2026-10-25T11:45:00Z', channel: 'GC-7740', eventType: 'DIRECT_PAYMENT_BYPASS_BLOCKED',
            redactedPattern: 'EXTERNAL_PAYMENT_PLATFORM', details: 'Seller attempted wire transfer bypass outside escrow protection', severity: 'HIGH'
        },
        {
            id: 'sec_3', ts: '2026-10-24T18:20:00Z', channel: 'GC-6102', eventType: 'EMAIL_HARVESTING_PREVENTED',
            redactedPattern: 'EMAIL_DETECTED', details: 'Private email exchange redacted to preserve marketplace escrow protection', severity: 'LOW'
        }
    ].forEach(event => insert.run(event));
}

function seedEscrowLedger(stmt) {
    const insert = stmt(`
        INSERT OR IGNORE INTO escrow_ledger (order_id, type, amount_minor, currency, idempotency_key, actor_id, reason, created_at)
        VALUES (@orderId, @type, @amountMinor, @currency, @key, @actorId, @reason, @createdAt)
    `);

    [
        { orderId: 'GC-9821', type: 'FUNDS_HELD', amountMinor: 24900, currency: 'USD', key: 'seed:GC-9821:held', actorId: 'buyer_dubai_12', reason: 'Buyer funded escrow', createdAt: '2026-10-24T14:30:00Z' },
        { orderId: 'GC-7740', type: 'FUNDS_HELD', amountMinor: 185000, currency: 'USD', key: 'seed:GC-7740:held', actorId: 'buyer_munich_55', reason: 'Buyer funded escrow', createdAt: '2026-10-25T11:00:00Z' },
        { orderId: 'GC-6102', type: 'FUNDS_HELD', amountMinor: 42000, currency: 'USD', key: 'seed:GC-6102:held', actorId: 'buyer_kyoto_09', reason: 'Buyer funded escrow', createdAt: '2026-10-22T08:00:00Z' },
        { orderId: 'GC-6102', type: 'DISPUTE_FREEZE', amountMinor: 42000, currency: 'USD', key: 'seed:GC-6102:freeze', actorId: 'agent_support_01', reason: 'Customs invoice dispute opened', createdAt: '2026-10-22T09:00:00Z' }
    ].forEach(row => insert.run(row));
}

function seedDisputes(stmt) {
    const insertDispute = stmt(`
        INSERT OR IGNORE INTO disputes
            (id, order_id, opened_by, opened_at, deadline_at, category, status, root_cause)
        VALUES (@id, @orderId, @openedBy, @openedAt, @deadlineAt, @category, @status, @rootCause)
    `);

    const insertEvent = stmt(`
        INSERT OR IGNORE INTO dispute_events (dispute_id, actor_id, event_type, summary, payload, created_at)
        VALUES (@disputeId, @actorId, @eventType, @summary, @payload, @createdAt)
    `);

    const insertEvidence = stmt(`
        INSERT OR IGNORE INTO evidence (id, dispute_id, uploaded_by, kind, filename, mime, size_bytes, sha256, note, created_at)
        VALUES (@id, @disputeId, @uploadedBy, @kind, @filename, @mime, @sizeBytes, @sha256, @note, @createdAt)
    `);

    // GC-6102 already runs an active mediation in the demo dataset
    insertDispute.run({
        id: 'dsp_6102', orderId: 'GC-6102', openedBy: 'buyer_kyoto_09',
        openedAt: '2026-10-22T09:00:00Z', deadlineAt: '2026-10-25T09:00:00Z',
        category: 'Customs Duty Classification & Invoice Discrepancy',
        status: 'AI_MEDIATION_ACTIVE',
        rootCause: 'Export documentation omitted HS Code 5007.20 (Woven Silk Fabric), resulting in an unexpected tariff assessment hold at Heathrow customs terminal.',
        proposals: [
            { id: 1, type: 'INVOICE_CLEARANCE', summary: 'Seller provides corrected export customs declaration invoice' },
            { id: 2, type: 'DUTY_CREDIT', summary: 'Split import duties 50/50 via immediate escrow refund credit' },
            { id: 3, type: 'HUMAN_ARBITRATION', summary: 'Sarah Chen assigned for bilingual courier investigation' }
        ]
    });

    [
        { disputeId: 'dsp_6102', actorId: 'buyer_kyoto_09', eventType: 'DISPUTE_OPENED', summary: 'Buyer requested export invoice reissuance in Japanese; escrow frozen', payload: null, createdAt: '2026-10-22T09:00:00Z' },
        { disputeId: 'dsp_6102', actorId: 'carrier', eventType: 'EVIDENCE_CAPTURED', summary: 'Carrier placed parcel on customs inspection hold', payload: JSON.stringify({ tracking: 'EMS-88219' }), createdAt: '2026-10-22T09:05:00Z' },
        { disputeId: 'dsp_6102', actorId: 'agent_support_01', eventType: 'EVIDENCE_UPLOADED', summary: 'Agent uploaded stamped bilingual declaration form', payload: null, createdAt: '2026-10-22T09:40:00Z' },
        { disputeId: 'dsp_6102', actorId: 'agent_support_01', eventType: 'MEDIATION_PROPOSED', summary: 'Three settlement proposals generated (duty credit / recall / arbitration)', payload: null, createdAt: '2026-10-22T10:15:00Z' }
    ].forEach(event => insertEvent.run(event));

    insertEvidence.run({
        id: 'evd_6102_1', disputeId: 'dsp_6102', uploadedBy: 'agent_support_01', kind: 'customs_declaration',
        filename: 'bilingual-declaration-6102.pdf', mime: 'application/pdf', sizeBytes: 184320,
        sha256: sha256('bilingual-declaration-6102'), note: 'Stamped bilingual commercial declaration', createdAt: '2026-10-22T09:40:00Z'
    });
}

function seedTranslationBaseline(stmt) {
    // Baseline counters so the metrics dashboard starts from realistic values
    // and then grows from real rows. The leak baseline excludes the three
    // seeded security_events rows (their violations are counted live), so the
    // displayed total starts at exactly 1428 and increments per interception.
    const insert = stmt(`
        INSERT OR IGNORE INTO audit_log (ts, actor_id, actor_role, action, target_type, target_id, detail, severity)
        VALUES (?, NULL, 'system', 'SEED_BASELINE', 'metrics', 'translation_baseline', ?, 'INFO')
    `);
    insert.run(nowIso(), JSON.stringify({ translationsCount: 894, totalLatencySum: 38084.4, leaksBlockedCounter: 1425 }));
}

// ---------------------------------------------------------------------------

function migrate(database) {
    database.exec(SCHEMA);
    const applied = database.prepare('SELECT COUNT(*) AS c FROM schema_migrations').get().c;
    if (applied === 0) {
        database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (1, ?)').run(nowIso());
    }
}

function seedIfEmpty(database) {
    const stmt = sql => database.prepare(sql);
    const anyUsers = database.prepare('SELECT COUNT(*) AS c FROM users').get().c > 0;
    if (anyUsers) return;

    const run = database.transaction(() => {
        seedUsers(stmt);
        seedOrders(stmt);
        seedMessages(stmt);
        seedGlossary(stmt);
        seedSecurityEvents(stmt);
        seedEscrowLedger(stmt);
        seedDisputes(stmt);
        seedTranslationBaseline(stmt);
    });
    run();
}

/**
 * Open (or reuse) the application database.
 * @param {string} [overridePath] test hook / DATABASE_PATH env support
 */
function openDatabase(overridePath) {
    if (db) return db;

    dbPath = overridePath || process.env.DATABASE_PATH || DEFAULT_DB_PATH;
    if (dbPath !== ':memory:') {
        fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }

    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');

    migrate(db);
    seedIfEmpty(db);
    return db;
}

function getDb() {
    if (!db) return openDatabase();
    return db;
}

function closeDatabase() {
    if (db) {
        try { db.close(); } catch (_) { /* already closed */ }
        db = null;
        dbPath = null;
    }
}

function currentPath() {
    return dbPath;
}

module.exports = {
    openDatabase,
    getDb,
    closeDatabase,
    currentPath,
    sha256,
    nowIso
};
