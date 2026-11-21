/**
 * GlobalConnect — Escrow lifecycle (MOCK FUNDS, production-grade controls)
 *
 * ⚠️ No real money moves. This module implements the control surface a real
 * escrow needs: role-checked state transitions, an append-only ledger with
 * idempotency keys, audit entries and real-time event broadcast — so a live
 * payment provider can be dropped in behind `appendLedgerEntry` later.
 *
 * State machine:
 *   FUNDED → DISPATCH → IN_TRANSIT → DELIVER → UNDER_INSPECTION
 *          → RELEASE → FUNDS_RELEASED
 *   any → DISPUTE → ESCROW_FROZEN → SETTLE_* → settled states
 */

const store = require('./store');
const security = require('./security');

let broadcast = () => {};
function init({ broadcast: fn } = {}) {
    if (typeof fn === 'function') broadcast = fn;
}

class HttpError extends Error {
    constructor(statusCode, message) {
        super(message);
        this.statusCode = statusCode;
    }
}

const MILESTONE_BY_ACTION = {
    DISPATCH: 'COURIER_DISPATCHED',
    DELIVER: 'INSPECTION_PENDING',
    RELEASE: 'RELEASED'
};

const STATUS_BY_ACTION = {
    DISPATCH: 'IN_TRANSIT',
    DELIVER: 'UNDER_INSPECTION',
    RELEASE: 'FUNDS_RELEASED'
};

const LEDGER_TYPE_BY_ACTION = {
    RELEASE: 'RELEASE',
    SETTLE_PARTIAL: 'SETTLEMENT',
    SETTLE_REFUND: 'REFUND',
    SETTLE_AGENT: 'SETTLEMENT'
};

function loadDisputes() {
    // Lazy require: keeps boot independent of the disputes module
    return require('./disputes');
}

/**
 * Perform an escrow transition.
 * @param {{orderId:string, action:string, actor:object, idempotencyKey?:string,
 *          ip?:string, complaint?:string}} params
 */
function performAction({ orderId, action, actor, idempotencyKey = null, ip = null, complaint = null }) {
    const order = store.getOrder(orderId);
    if (!order) throw new HttpError(404, `Order ${orderId} not found`);
    if (!actor) throw new HttpError(401, 'Sign in to manage escrow.');
    if (!store.canAccessOrder(actor, orderId)) {
        throw new HttpError(403, 'You do not have access to this order.');
    }
    if (!store.canPerformEscrowAction(actor, order, action)) {
        throw new HttpError(403, `Your role cannot perform the ${action || 'requested'} escrow action.`);
    }

    let dispute = order.dispute || null;
    let ledgerEntry = null;

    if (MILESTONE_BY_ACTION[action]) {
        const step = MILESTONE_BY_ACTION[action];
        store.setMilestone(orderId, step, { completed: true, actorId: actor.id });
        store.updateOrderStatus(orderId, STATUS_BY_ACTION[action]);

        if (action === 'RELEASE') {
            const result = store.appendLedgerEntry({
                orderId,
                type: 'RELEASE',
                amountMinor: order.amountMinor,
                currency: order.currency,
                idempotencyKey: idempotencyKey || `release:${orderId}`,
                actorId: actor.id,
                reason: 'Escrow funds released to seller'
            });
            ledgerEntry = result.entry;
        }
    } else if (action === 'DISPUTE') {
        if (dispute && ['AI_MEDIATION_ACTIVE', 'OPEN', 'ESCALATED_TO_AGENT'].includes(dispute.status)) {
            throw new HttpError(409, 'An active dispute already exists for this order.');
        }
        const opened = loadDisputes().openDispute({
            orderId,
            openedBy: actor.id,
            complaint,
            actorRole: actor.role,
            ip
        });
        dispute = opened.dispute;
    } else if (['SETTLE_PARTIAL', 'SETTLE_REFUND', 'SETTLE_AGENT'].includes(action)) {
        const active = store.getActiveDisputeForOrder(orderId);
        if (!active) throw new HttpError(409, 'No active dispute to settle for this order.');
        const settled = loadDisputes().resolveCase({
            disputeId: active.id,
            action,
            resolution: complaint || null,
            resolvedBy: actor.id,
            ip
        });
        dispute = settled.dispute;
        ledgerEntry = settled.ledgerEntry || null;
    } else {
        throw new HttpError(400, `Unknown escrow action '${action}'.`);
    }

    const freshOrder = store.getOrder(orderId);
    dispute = freshOrder.dispute || dispute;

    security.audit(req0(ip), `ESCROW_${action}`, {
        actor,
        targetType: 'order',
        targetId: orderId,
        detail: { newStatus: freshOrder.status, idempotencyKey },
        severity: action === 'DISPUTE' || action.startsWith('SETTLE') ? 'WARN' : 'INFO'
    });

    const payload = {
        orderId,
        newStatus: freshOrder.status,
        milestones: freshOrder.escrowMilestones,
        dispute
    };
    broadcast(orderId, 'escrow_update', payload);

    return { ...payload, ledgerEntry };
}

// audit() expects a req-like object only for the IP; pass through a shim
function req0(ip) {
    return { socket: { remoteAddress: ip || null }, headers: {} };
}

module.exports = {
    init,
    performAction,
    HttpError,
    MILESTONE_BY_ACTION,
    STATUS_BY_ACTION,
    LEDGER_TYPE_BY_ACTION
};
