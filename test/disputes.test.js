/**
 * Tests for src/disputes.js — persistent dispute mediation module.
 *
 * Uses a fresh SQLite database per run (DATABASE_PATH set BEFORE requiring
 * src/db) so the real dev database is never touched.
 *
 * Run: node --test test/disputes.test.js
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

// Fresh database per run — must be set before src/db is required.
process.env.DATABASE_PATH = path.join(
    os.tmpdir(),
    `globalconnect-disputes-${process.pid}-${crypto.randomBytes(6).toString('hex')}.db`
);

const { openDatabase, closeDatabase, getDb } = require('../src/db');
openDatabase();

const store = require('../src/store');
const disputes = require('../src/disputes');

const DB_PATH = process.env.DATABASE_PATH;
const MAX_EVIDENCE = 5 * 1024 * 1024;

// Shared state across the (sequentially run) tests.
let case9821 = null; // dispute id opened for GC-9821

after(() => {
    closeDatabase();
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(DB_PATH + suffix); } catch (_) { /* best effort */ }
    }
});

// ---------------------------------------------------------------------------
// openDispute
// ---------------------------------------------------------------------------

test('openDispute on GC-9821 freezes escrow with a 72h deadline and 3 proposals', async () => {
    const { dispute, order } = await disputes.openDispute({
        orderId: 'GC-9821',
        openedBy: 'buyer_dubai_12',
        complaint: 'Leather grain differs from listing photos',
        category: 'Material Specification & Texture Query',
        actorRole: 'buyer',
        ip: '127.0.0.1'
    });
    case9821 = dispute.id;

    // Order frozen
    assert.equal(order.status, 'ESCROW_FROZEN');
    assert.equal(store.getOrder('GC-9821').status, 'ESCROW_FROZEN');

    // 72h deadline
    assert.equal(dispute.status, 'AI_MEDIATION_ACTIVE');
    const hoursRemaining = (Date.parse(dispute.deadlineAt) - Date.now()) / 3600000;
    assert.ok(hoursRemaining > 71.9 && hoursRemaining <= 72.05,
        `expected ~72h deadline, got ${hoursRemaining}`);

    // 3 settlement templates ported from server.js
    assert.equal(dispute.settlementProposals.length, 3);
    const types = dispute.settlementProposals.map(p => p.type);
    assert.deepEqual(types, ['FULL_REFUND', 'PARTIAL_SETTLEMENT', 'HUMAN_ARBITRATION']);
    assert.match(
        dispute.settlementProposals[1].summary,
        /\$49\.80 USD \(20%\) courtesy credit/,
        '20% of $249.00 must be baked into the template'
    );

    // DISPUTE_FREEZE ledger entry (idempotencyKey dispute:<id>)
    const freeze = getDb().prepare('SELECT * FROM escrow_ledger WHERE idempotency_key = ?')
        .get(`dispute:${dispute.id}`);
    assert.ok(freeze, 'DISPUTE_FREEZE ledger entry must exist');
    assert.equal(freeze.type, 'DISPUTE_FREEZE');
    assert.equal(freeze.order_id, 'GC-9821');
    assert.equal(freeze.amount_minor, 24900);

    // Events: DISPUTE_OPENED (with the complaint) + ESCROW_FROZEN
    const events = store.listDisputeEvents(dispute.id);
    const opened = events.find(e => e.event_type === 'DISPUTE_OPENED');
    assert.ok(opened, 'DISPUTE_OPENED event missing');
    assert.match(opened.summary, /Leather grain differs/);
    assert.ok(events.some(e => e.event_type === 'ESCROW_FROZEN'), 'ESCROW_FROZEN event missing');

    // Audit entry
    const audit = getDb().prepare("SELECT * FROM audit_log WHERE action = 'DISPUTE_OPENED' AND target_id = ?")
        .get(dispute.id);
    assert.ok(audit, 'DISPUTE_OPENED audit entry missing');
});

test('opening a second dispute for GC-9821 throws 409', async () => {
    await assert.rejects(
        () => disputes.openDispute({
            orderId: 'GC-9821',
            openedBy: 'seller_milan_88',
            complaint: 'Second complaint'
        }),
        (err) => {
            assert.equal(err.statusCode, 409);
            return true;
        }
    );
});

test('openDispute on a missing order throws 404', async () => {
    await assert.rejects(
        () => disputes.openDispute({
            orderId: 'GC-0000',
            openedBy: 'buyer_dubai_12',
            complaint: 'No such order'
        }),
        (err) => {
            assert.equal(err.statusCode, 404);
            return true;
        }
    );
});

// ---------------------------------------------------------------------------
// getCaseHistory
// ---------------------------------------------------------------------------

test('getCaseHistory returns events including DISPUTE_OPENED and evidence array', () => {
    const history = disputes.getCaseHistory(case9821);
    assert.equal(history.dispute.id, case9821);
    assert.equal(history.order.id, 'GC-9821');
    assert.ok(Array.isArray(history.events));
    assert.ok(history.events.some(e => e.event_type === 'DISPUTE_OPENED'));
    assert.ok(history.events.some(e => e.event_type === 'ESCROW_FROZEN'));
    assert.ok(Array.isArray(history.evidence));
    assert.equal(history.evidence.length, 0, 'no evidence uploaded yet');

    assert.throws(
        () => disputes.getCaseHistory('dsp_does_not_exist'),
        (err) => err.message === 'Dispute not found'
    );
});

// ---------------------------------------------------------------------------
// addEvidenceItem
// ---------------------------------------------------------------------------

test('addEvidenceItem stores the row and records an EVIDENCE_UPLOADED event', () => {
    const evidence = disputes.addEvidenceItem({
        disputeId: case9821,
        uploadedBy: 'buyer_dubai_12',
        kind: 'photo',
        filename: 'grain-macro.jpg',
        mime: 'image/jpeg',
        sizeBytes: 204800,
        sha256: crypto.createHash('sha256').update('grain-macro').digest('hex'),
        note: 'Close-up of pebble grain after unboxing',
        ip: '127.0.0.1'
    });

    assert.ok(evidence.id);
    assert.equal(evidence.dispute_id, case9821);
    assert.equal(evidence.filename, 'grain-macro.jpg');
    assert.equal(evidence.size_bytes, 204800);

    const events = store.listDisputeEvents(case9821);
    const uploaded = events.find(e => e.event_type === 'EVIDENCE_UPLOADED');
    assert.ok(uploaded, 'EVIDENCE_UPLOADED event missing');
    assert.match(uploaded.summary, /grain-macro\.jpg/);

    const audit = getDb().prepare("SELECT * FROM audit_log WHERE action = 'EVIDENCE_UPLOADED' AND target_id = ?")
        .get(case9821);
    assert.ok(audit, 'EVIDENCE_UPLOADED audit entry missing');

    // History now reflects the evidence row
    const history = disputes.getCaseHistory(case9821);
    assert.equal(history.evidence.length, 1);
});

test('addEvidenceItem rejects files over 5MB (and empty/zero-size input)', () => {
    assert.throws(
        () => disputes.addEvidenceItem({
            disputeId: case9821,
            uploadedBy: 'buyer_dubai_12',
            kind: 'video',
            filename: 'huge.mp4',
            mime: 'video/mp4',
            sizeBytes: MAX_EVIDENCE + 1,
            sha256: 'deadbeef'
        }),
        (err) => err.statusCode === 400
    );

    assert.throws(
        () => disputes.addEvidenceItem({
            disputeId: case9821,
            uploadedBy: 'buyer_dubai_12',
            filename: 'zero.jpg',
            sizeBytes: 0,
            sha256: 'deadbeef'
        }),
        (err) => err.statusCode === 400
    );

    assert.throws(
        () => disputes.addEvidenceItem({
            disputeId: case9821,
            uploadedBy: 'buyer_dubai_12',
            filename: '   ',
            sizeBytes: 10,
            sha256: 'deadbeef'
        }),
        (err) => err.statusCode === 400
    );

    // Nothing was stored by the rejected calls
    assert.equal(store.listEvidence(case9821).length, 1);
});

// ---------------------------------------------------------------------------
// generatePacket
// ---------------------------------------------------------------------------

test('generatePacket for GC-9821 returns the material case shape from DB state', () => {
    const packet = disputes.generatePacket('GC-9821');

    assert.equal(packet.caseId, 'CASE-9821');
    assert.equal(packet.orderId, 'GC-9821');
    assert.equal(packet.itemTitle, 'Vintage Italian Leather Jacket');
    assert.equal(packet.escrowLockedAmount, 249);
    assert.equal(packet.currency, 'USD');
    assert.equal(packet.status, 'AI_MEDIATION_ACTIVE');
    assert.equal(typeof packet.slaHoursRemaining, 'number');

    // Parties come from the real order row
    assert.equal(packet.parties.buyer.name, 'Tariq Al-Mansoor');
    assert.equal(packet.parties.seller.name, 'Marco Rossi');

    // All legacy fields the app.html modal consumes
    assert.ok(packet.disputeCategory);
    assert.ok(packet.rootCauseSummary);
    assert.ok(Array.isArray(packet.bilingualTimeline));
    assert.ok(packet.bilingualTimeline.length > 0);
    assert.ok(packet.evidenceComparison.buyerClaim);
    assert.ok(packet.evidenceComparison.sellerListingVerified);
    assert.ok(packet.evidenceComparison.shippingStatus);
    assert.equal(typeof packet.timeSavedMinutes, 'number');

    // 3 recommendations with the actions the modal wires to /api/escrow/action
    assert.equal(packet.aiRecommendations.length, 3);
    assert.deepEqual(
        packet.aiRecommendations.map(r => r.action),
        ['SETTLE_PARTIAL', 'SETTLE_REFUND', 'SETTLE_AGENT']
    );

    // Evidence list reflects DB state (one upload earlier in this file)
    assert.ok(Array.isArray(packet.evidence));
    assert.equal(packet.evidence.length, 1);
    assert.equal(packet.evidence[0].filename, 'grain-macro.jpg');

    // Timeline is assembled from dispute_events (DB-driven, not static copy)
    assert.ok(packet.bilingualTimeline.some(t => /Leather grain differs/.test(t.event)),
        'timeline should contain the DISPUTE_OPENED summary from dispute_events');
    assert.ok(packet.bilingualTimeline.every(t => /^[A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}$/.test(t.time)),
        'timeline entries use the "Oct 24 14:30" time format');

    // customComplaint overrides the root cause
    const withComplaint = disputes.generatePacket('GC-9821', 'Buyer says lining is polyester not silk');
    assert.equal(withComplaint.rootCauseSummary, 'Buyer says lining is polyester not silk');
});

test('generatePacket for GC-6102 returns the customs case shape from DB state', () => {
    const packet = disputes.generatePacket('GC-6102');

    assert.equal(packet.caseId, 'CASE-6102');
    assert.equal(packet.orderId, 'GC-6102');
    assert.equal(packet.itemTitle, 'Kyoto Silk Kimono Fabric');
    assert.equal(packet.escrowLockedAmount, 420);
    assert.equal(packet.currency, 'USD');
    assert.equal(packet.status, 'AI_MEDIATION_ACTIVE');
    assert.equal(packet.disputeCategory, 'Customs Duty Classification & Invoice Discrepancy');

    assert.equal(packet.parties.buyer.name, 'Kenji Sato');
    assert.equal(packet.parties.seller.name, 'Emma Watson');

    assert.equal(packet.aiRecommendations.length, 3);
    assert.deepEqual(
        packet.aiRecommendations.map(r => r.action),
        ['SETTLE_PARTIAL', 'SETTLE_REFUND', 'SETTLE_AGENT']
    );

    assert.ok(Array.isArray(packet.bilingualTimeline));
    assert.ok(packet.bilingualTimeline.length > 0);
    // Seeded dispute_events drive the timeline
    assert.ok(packet.bilingualTimeline.some(t => /invoice reissuance/.test(t.event)));

    // Seeded evidence row from the DB
    assert.equal(packet.evidence.length, 1);
    assert.equal(packet.evidence[0].filename, 'bilingual-declaration-6102.pdf');
});

// ---------------------------------------------------------------------------
// listOpenCases — agent support inbox
// ---------------------------------------------------------------------------

test('listOpenCases includes GC-6102 with hoursRemaining and party names', () => {
    const cases = disputes.listOpenCases();
    assert.ok(Array.isArray(cases));
    assert.ok(cases.length > 0);

    const c6102 = cases.find(c => c.dispute.orderId === 'GC-6102');
    assert.ok(c6102, 'GC-6102 must appear in the open-case inbox');
    assert.equal(typeof c6102.hoursRemaining, 'number');
    assert.equal(c6102.amount, 420);
    assert.equal(c6102.order.buyerName, 'Kenji Sato');
    assert.equal(c6102.order.sellerName, 'Emma Watson');
    assert.equal(c6102.parties.buyer.name, 'Kenji Sato');
    assert.equal(c6102.parties.seller.name, 'Emma Watson');
    assert.equal(c6102.parties.buyer.lang, 'ja');
    assert.equal(c6102.caseId, 'CASE-6102');

    // GC-9821's dispute is still active at this point in the run
    const c9821 = cases.find(c => c.dispute.orderId === 'GC-9821');
    assert.ok(c9821, 'GC-9821 must appear while its dispute is active');

    // Sorted soonest-deadline first
    for (let i = 1; i < cases.length; i++) {
        assert.ok(Date.parse(cases[i - 1].dispute.deadlineAt) <= Date.parse(cases[i].dispute.deadlineAt),
            'cases must be sorted by deadline urgency');
    }

    // Resolved cases are excluded
    assert.ok(cases.every(c => ['OPEN', 'AI_MEDIATION_ACTIVE', 'ESCALATED_TO_AGENT'].includes(c.dispute.status)));
});

// ---------------------------------------------------------------------------
// proposeSettlements
// ---------------------------------------------------------------------------

test('proposeSettlements returns 3 fresh proposals with a computed 20% amount', () => {
    const before = store.listDisputeEvents(case9821).filter(e => e.event_type === 'MEDIATION_PROPOSED').length;

    const updated = disputes.proposeSettlements({
        disputeId: case9821,
        actorId: 'agent_support_01'
    });

    assert.equal(updated.settlementProposals.length, 3);
    const types = updated.settlementProposals.map(p => p.type);
    assert.deepEqual(types, ['PARTIAL_SETTLEMENT', 'FULL_REFUND', 'HUMAN_ARBITRATION']);

    // 20% of $249.00 = $49.80
    const partial = updated.settlementProposals.find(p => p.type === 'PARTIAL_SETTLEMENT');
    assert.equal(partial.amount, 49.8);

    // Full refund matches the order amount
    const refund = updated.settlementProposals.find(p => p.type === 'FULL_REFUND');
    assert.equal(refund.amount, 249);

    // Human arbitration names the agent
    const arbitration = updated.settlementProposals.find(p => p.type === 'HUMAN_ARBITRATION');
    assert.equal(arbitration.agent, 'Sarah Chen');

    // MEDIATION_PROPOSED event recorded
    const after = store.listDisputeEvents(case9821).filter(e => e.event_type === 'MEDIATION_PROPOSED');
    assert.equal(after.length, before + 1);
});

// ---------------------------------------------------------------------------
// resolveCase
// ---------------------------------------------------------------------------

test('resolveCase(SETTLE_PARTIAL) settles at 20% with an idempotent ledger entry', () => {
    const first = disputes.resolveCase({
        disputeId: case9821,
        action: 'SETTLE_PARTIAL',
        resolution: '20% courtesy credit issued to buyer',
        resolvedBy: 'agent_support_01',
        ip: '127.0.0.1'
    });

    assert.equal(first.dispute.status, 'SETTLED_PARTIAL_CREDIT');
    assert.equal(first.order.status, 'DISPUTE_SETTLED_PARTIAL');
    assert.ok(first.ledgerEntry);
    assert.equal(first.ledgerEntry.type, 'SETTLEMENT');
    assert.equal(first.ledgerEntry.amount_minor, 4980, '20% of 24900 minor units');
    assert.equal(first.ledgerEntry.idempotency_key, `settle:${case9821}:SETTLE_PARTIAL`);

    // RESOLVED/<action> event
    const events = store.listDisputeEvents(case9821);
    assert.ok(events.some(e => e.event_type === 'RESOLVED/SETTLE_PARTIAL'));

    // Calling again must NOT double the ledger
    disputes.resolveCase({
        disputeId: case9821,
        action: 'SETTLE_PARTIAL',
        resolution: '20% courtesy credit issued to buyer',
        resolvedBy: 'agent_support_01',
        ip: '127.0.0.1'
    });

    const keyed = getDb().prepare('SELECT COUNT(*) AS c FROM escrow_ledger WHERE idempotency_key = ?')
        .get(`settle:${case9821}:SETTLE_PARTIAL`).c;
    assert.equal(keyed, 1, 'idempotency key must prevent a duplicate SETTLEMENT row');

    const settlements = getDb().prepare(
        "SELECT COUNT(*) AS c FROM escrow_ledger WHERE order_id = 'GC-9821' AND type = 'SETTLEMENT'"
    ).get().c;
    assert.equal(settlements, 1, 'ledger must not be double-credited');
});

test('resolveCase(SETTLE_REFUND) issues a return label and full refund', () => {
    const result = disputes.resolveCase({
        disputeId: case9821,
        action: 'SETTLE_REFUND',
        resolution: 'Full refund with pre-paid return label',
        resolvedBy: 'agent_support_01',
        ip: '127.0.0.1'
    });

    assert.equal(result.dispute.status, 'REFUND_ISSUED');
    assert.equal(result.order.status, 'RETURN_LABEL_ISSUED');
    assert.equal(result.ledgerEntry.type, 'SETTLEMENT');
    assert.equal(result.ledgerEntry.amount_minor, 24900, 'full escrow amount');
    assert.equal(result.ledgerEntry.idempotency_key, `settle:${case9821}:SETTLE_REFUND`);
    assert.ok(store.listDisputeEvents(case9821).some(e => e.event_type === 'RESOLVED/SETTLE_REFUND'));
});

test('resolveCase(SETTLE_AGENT) assigns human arbitration', () => {
    const result = disputes.resolveCase({
        disputeId: case9821,
        action: 'SETTLE_AGENT',
        resolution: 'Escalated to bilingual arbitration officer',
        resolvedBy: 'agent_support_01',
        ip: '127.0.0.1'
    });

    assert.equal(result.dispute.status, 'ESCALATED_TO_AGENT');
    assert.equal(result.order.status, 'HUMAN_ARBITRATION_ASSIGNED');
    assert.equal(result.ledgerEntry.type, 'SETTLEMENT');
    assert.equal(result.ledgerEntry.amount_minor, 0, 'escalation moves no money');
    assert.ok(store.listDisputeEvents(case9821).some(e => e.event_type === 'RESOLVED/SETTLE_AGENT'));

    // Audit trail exists
    const audit = getDb().prepare("SELECT COUNT(*) AS c FROM audit_log WHERE action = 'DISPUTE_RESOLVED' AND target_id = ?")
        .get(case9821).c;
    assert.equal(audit, 4, 'one DISPUTE_RESOLVED audit row per resolveCase call (incl. the idempotent replay)');
});

test('resolveCase validates its inputs', () => {
    assert.throws(
        () => disputes.resolveCase({ disputeId: case9821, action: 'SETTLE_PARTIAL' }),
        (err) => err.statusCode === 400,
        'resolvedBy is mandatory'
    );

    assert.throws(
        () => disputes.resolveCase({ disputeId: case9821, action: 'NOT_A_ACTION', resolvedBy: 'agent_support_01' }),
        (err) => err.statusCode === 400
    );

    assert.throws(
        () => disputes.resolveCase({ disputeId: 'dsp_nope', action: 'SETTLE_PARTIAL', resolvedBy: 'agent_support_01' }),
        (err) => err.statusCode === 404
    );
});
