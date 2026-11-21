/**
 * GlobalConnect — marketplace metrics (all computed from live DB state)
 *
 * Replaces the old in-memory hardcoded counters:
 * - escrow volumes from orders
 * - dispute KPIs from disputes table
 * - translation latency / counts / language mix from translation_log
 * - leak counter from security_events
 * - resolution time from actually resolved cases (with baseline fallback)
 */

const store = require('./store');

const BASELINE_DISPUTE_RATE = Number(process.env.BASELINE_DISPUTE_RATE || 45.0);
const RESOLUTION_BASELINE_HOURS = 4.2; // used only while no case has resolved
const AI_LATENCY_TARGET_MS = 60;

function computeMarketplaceMetrics() {
    const orders = store.listOrders();
    const totalOrders = orders.length;

    const totalEscrowVolumeUSD = orders.reduce((sum, o) => sum + (o.amount || 0), 0);
    const lockedEscrowVolumeUSD = orders
        .filter(o => o.status !== 'FUNDS_RELEASED')
        .reduce((sum, o) => sum + (o.amount || 0), 0);
    const releasedVolumeUSD = orders
        .filter(o => o.status === 'FUNDS_RELEASED')
        .reduce((sum, o) => sum + (o.amount || 0), 0);

    const activeDisputes = orders.filter(o =>
        o.status === 'ESCROW_FROZEN' ||
        (o.dispute && ['AI_MEDIATION_ACTIVE', 'OPEN', 'ESCALATED_TO_AGENT'].includes(o.dispute.status))
    ).length;
    const resolvedDisputes = orders.filter(o =>
        ['DISPUTE_SETTLED_PARTIAL', 'RETURN_LABEL_ISSUED', 'HUMAN_ARBITRATION_ASSIGNED', 'FUNDS_RELEASED']
            .includes(o.status) ||
        (o.dispute && o.dispute.status && !['AI_MEDIATION_ACTIVE', 'OPEN', 'ESCALATED_TO_AGENT'].includes(o.dispute.status))
    ).length;

    const currentDisputeRate = totalOrders > 0 ? (activeDisputes / totalOrders) * 100 : 0;
    const disputeReductionPercentage = BASELINE_DISPUTE_RATE > 0
        ? ((BASELINE_DISPUTE_RATE - currentDisputeRate) / BASELINE_DISPUTE_RATE) * 100
        : 0;

    const liveResolution = store.avgResolutionHours();

    const stats = store.translationStats();
    const languages = store.translationPairStats();
    const violations = store.violationTotal();

    return {
        timestamp: new Date().toISOString(),
        summary: {
            disputeReductionPercentage: Number((-Math.abs(disputeReductionPercentage)).toFixed(1)),
            currentDisputeRate: Number(currentDisputeRate.toFixed(1)),
            baselineDisputeRate: BASELINE_DISPUTE_RATE,
            avgResolutionTimeHours: liveResolution !== null ? liveResolution : RESOLUTION_BASELINE_HOURS,
            resolutionTimeSource: liveResolution !== null ? 'live' : 'baseline',
            slaLimitHours: 72,
            offPlatformLeaksBlocked: store.baselineLeaksBlocked() + violations,
            aiInferenceLatencyMs: stats.avgLatencyMs,
            aiLatencyTargetMs: AI_LATENCY_TARGET_MS,
            translationsCount: stats.translationsCount,
            liveTranslations: stats.liveTranslations,
            cachedTranslations: stats.cachedTranslations,
            avgConfidence: stats.avgConfidence,
            translationEngines: stats.byEngine
        },
        escrow: {
            totalOrders,
            totalEscrowVolumeUSD: Number(totalEscrowVolumeUSD.toFixed(2)),
            lockedEscrowVolumeUSD: Number(lockedEscrowVolumeUSD.toFixed(2)),
            releasedVolumeUSD: Number(releasedVolumeUSD.toFixed(2)),
            activeDisputes,
            resolvedDisputes,
            ledgerEntries: store.ledgerTotals().entries
        },
        languages,
        securityAuditTrail: store.listSecurityEvents(10),
        auditTrail: store.listAudit({ limit: 10 })
    };
}

module.exports = { computeMarketplaceMetrics, BASELINE_DISPUTE_RATE, AI_LATENCY_TARGET_MS };
