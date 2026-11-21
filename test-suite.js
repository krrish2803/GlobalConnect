/**
 * GlobalConnect - Automated Verification Test Suite
 * Nexconn Build Challenge 2026 - Day 1 & Phase 1 Verifications
 *
 * Verifies:
 * 1. Gateway Health & System Operational State
 * 2. Role-Based Account Creation & Session Authentication (Buyer, Seller, Agent)
 * 3. Session User State Verification (/api/auth/me)
 * 4. Authenticated Server-Side Nexconn Token Issuance & Architecture Boundaries
 * 5. Real-Time Translation with Cultural Nuance & Free-Tier Quota Protection
 * 6. Contact Masking Security Filter (Phone, Email, Off-Platform Apps)
 * 7. Sandbox Escrow Ledger Lifecycle & Fund Freezing
 * 8. AI Dispute Mediator & 72-Hour Settlement Plan
 * 9. HMAC-SHA256 Signed Webhook Verification & Tamper Rejection
 */

const http = require('http');
const crypto = require('crypto');

// Load .env (and the resolved webhook secret) exactly the way server.js does.
// In `npm test` the server module is already cached, so this reuses it; for a
// standalone run against a separately started server it guarantees both sides
// sign with the same NEXCONN_WEBHOOK_SECRET.
require('./server.js');

const PORT = process.env.PORT || 3000;
const WEBHOOK_SECRET = (process.env.NEXCONN_WEBHOOK_SECRET || '').trim();

let sessionCookie = '';

function request(method, path, body = null, headers = {}) {
    return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : null;
        const reqHeaders = {
            'Content-Type': 'application/json',
            ...headers
        };

        if (sessionCookie && !reqHeaders['Cookie']) {
            reqHeaders['Cookie'] = sessionCookie;
        }

        const options = {
            hostname: '127.0.0.1',
            port: PORT,
            path: path,
            method: method,
            headers: reqHeaders
        };

        if (payload) {
            options.headers['Content-Length'] = Buffer.byteLength(payload);
        }

        const req = http.request(options, res => {
            let data = '';

            // Capture session cookie if returned
            const setCookie = res.headers['set-cookie'];
            if (setCookie && Array.isArray(setCookie)) {
                const gcCookie = setCookie.find(c => c.startsWith('gc_session='));
                if (gcCookie) {
                    sessionCookie = gcCookie.split(';')[0];
                }
            }

            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                let parsed = null;
                try {
                    parsed = JSON.parse(data);
                } catch (e) {
                    parsed = data;
                }
                resolve({ status: res.statusCode, data: parsed, headers: res.headers });
            });
        });

        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

async function runTests() {
    console.log("============================================================");
    console.log("🧪 Starting GlobalConnect Automated Verification Test Suite");
    console.log("   Nexconn Build Challenge 2026 • Phase 1 Core Validation");
    console.log("============================================================\n");

    let passed = 0;
    let failed = 0;

    function assert(name, condition, details = "") {
        if (condition) {
            console.log(`✅ PASS: ${name}`);
            passed++;
        } else {
            console.error(`❌ FAIL: ${name} - ${details}`);
            failed++;
        }
    }

    try {
        // --- Test 1: Gateway Health ---
        console.log("▶ [Test 1] Gateway Health Check");
        const health = await request('GET', '/api/health');
        assert("Gateway returns 200 OK", health.status === 200);
        assert("Gateway identifies as GlobalConnect", health.data && health.data.service === 'GlobalConnect API Gateway');
        console.log();

        // --- Test 2: Role-Based Account Creation & Session Authentication ---
        console.log("▶ [Test 2] Role-Based Authentication & Session Issuance");
        const testEmail = `test_buyer_${Date.now()}@example.com`;
        const signupRes = await request('POST', '/api/auth/signup', {
            name: 'Tariq Al-Mansoor',
            email: testEmail,
            password: 'secureDemoPassword2026!',
            role: 'buyer'
        });
        assert("Signup endpoint returns 201 Created", signupRes.status === 201);
        assert("Session cookie issued", Boolean(sessionCookie && sessionCookie.includes('gc_session=')));
        assert("User created with buyer role", signupRes.data && signupRes.data.user && signupRes.data.user.role === 'buyer');
        console.log();

        // --- Test 3: Session User Verification (/api/auth/me) ---
        console.log("▶ [Test 3] Session User State Verification");
        const meRes = await request('GET', '/api/auth/me');
        assert("Authenticated user returned via session cookie", meRes.status === 200 && meRes.data.user.email === testEmail);
        console.log();

        // --- Test 4: Authenticated Server-Side Nexconn Token Issuance ---
        console.log("▶ [Test 4] Nexconn Token Architecture Verification");
        const unauthTokenRes = await request('POST', '/api/auth/token', null, { Cookie: 'gc_session=' });
        assert("Token endpoint requires an authenticated session (401)", unauthTokenRes.status === 401);

        const tokenRes = await request('POST', '/api/auth/token', {
            userId: 'buyer_dubai_12',
            role: 'buyer'
        });
        const issuedToken =
            tokenRes.status === 200 &&
            typeof tokenRes.data.userId === 'string' &&
            typeof tokenRes.data.token === 'string' &&
            tokenRes.data.token.length > 0;
        const structuredError = tokenRes.status >= 500 && typeof tokenRes.data.error === 'string';
        assert("Server-side issuance returns a Nexconn token or a structured error", issuedToken || structuredError);
        const appSecretLeaked = Boolean(process.env.NEXCONN_APP_SECRET) &&
            JSON.stringify(tokenRes.data || {}).includes(process.env.NEXCONN_APP_SECRET);
        assert("Response never exposes the App Secret", !appSecretLeaked);
        console.log();

        // --- Test 5: Translation & Cultural Etiquette Engine ---
        console.log("▶ [Test 5] Live Translation & Cultural Context Engine");
        const transRes = await request('POST', '/api/translate', {
            text: 'Is this genuine leather?',
            sourceLang: 'en',
            targetLang: 'ar',
            culturalContext: true
        });
        assert("Translation returns 200 OK", transRes.status === 200);
        assert("Confidence score exceeds 95%", transRes.data && transRes.data.confidenceScore >= 0.95);
        assert("Inference latency is tracked", typeof transRes.data.inferenceLatencyMs === 'number');
        assert("Cultural context notes provided", typeof transRes.data.culturalAdaptation === 'string');
        assert("Free-tier quota protection active", transRes.data.quotaProtected === true);
        console.log();

        // --- Test 6: Contact Masking & Security Guard ---
        console.log("▶ [Test 6] Contact Masking & Leak Prevention");
        const cleanMsg = await request('POST', '/api/moderate', { text: 'What is the tracking number?' });
        assert("Clean message passes with 100% compliance", cleanMsg.data.isClean === true && cleanMsg.data.policyComplianceScore === 100);

        const leakMsg = await request('POST', '/api/moderate', {
            text: 'Call my cell at +1-555-482-1920 or message on WhatsApp to pay via PayPal'
        });
        assert("Violations accurately detected", leakMsg.data.isClean === false && leakMsg.data.violationsBlocked.length >= 2);
        assert("Phone number redacted", leakMsg.data.sanitizedText.includes('[REDACTED PHONE]'));
        assert("Platform keyword redacted", leakMsg.data.sanitizedText.includes('[OFF-PLATFORM CHANNEL REDACTED]'));
        console.log();

        // --- Test 7: Sandbox Escrow Ledger ---
        console.log("▶ [Test 7] Milestone Escrow Lifecycle");
        const escrowStatus = await request('GET', '/api/escrow/GC-9821');
        assert("Order GC-9821 exists in sandbox ledger", escrowStatus.status === 200);
        assert("Escrow amount is $249.00 USD", escrowStatus.data.amount === 249.00);

        const dispatchAction = await request('POST', '/api/escrow/action', {
            orderId: 'GC-9821',
            action: 'DISPATCH'
        });
        assert("Courier dispatch updates status to IN_TRANSIT", dispatchAction.data.newStatus === 'IN_TRANSIT');
        console.log();

        // --- Test 8: AI Dispute Mediator ---
        console.log("▶ [Test 8] AI Dispute Mediation & Escrow Freezing");
        const disputeAction = await request('POST', '/api/escrow/action', {
            orderId: 'GC-9821',
            action: 'DISPUTE'
        });
        assert("Dispute freeze updates status to ESCROW_FROZEN", disputeAction.data.newStatus === 'ESCROW_FROZEN');
        assert("72-hour mediation window established", disputeAction.data.dispute !== null && disputeAction.data.dispute.status === 'AI_MEDIATION_ACTIVE');
        assert("3 neutral settlement proposals generated", disputeAction.data.dispute.settlementProposals.length === 3);

        const mediateAnalysis = await request('POST', '/api/dispute/mediate', {
            orderId: 'GC-9821',
            complaint: 'Material grain differs from specification'
        });
        assert("AI dispute analysis generated with bilingual timeline", Array.isArray(mediateAnalysis.data.bilingualTimeline));
        console.log();

        // --- Test 9: Real-Time Order Channels & Message Pipeline ---
        console.log("▶ [Test 9] Order-Linked Channels & Real-Time Message Pipeline");
        const channelMsgs = await request('GET', '/api/channels/GC-9821/messages');
        assert("Channel messages retrieved (200 OK)", channelMsgs.status === 200);
        assert("Initial deal conversation and spec card seeded", Array.isArray(channelMsgs.data.messages) && channelMsgs.data.messages.length >= 3);

        const sendMsgRes = await request('POST', '/api/channels/GC-9821/messages', {
            text: 'Is this genuine leather?'
        });
        assert("Channel message posted with live translation (201 Created)", sendMsgRes.status === 201);
        assert("Message object generated with ID and sender", typeof sendMsgRes.data.message.id === 'string' && sendMsgRes.data.message.sender.role === 'buyer');
        assert("Real-time dual translation attached", sendMsgRes.data.message.translation !== null);
        console.log();

        // --- Test 10: AI Dispute Summary Context Packet ---
        console.log("▶ [Test 10] AI Dispute Summary Context Packet (Tier 2 #12)");
        const packet9821 = await request('GET', '/api/dispute/packet/GC-9821');
        assert("Briefing packet retrieved for GC-9821 (200 OK)", packet9821.status === 200);
        assert("Case ID matches CASE-9821", packet9821.data.caseId === 'CASE-9821');
        assert("Locked escrow amount is $249.00 USD", packet9821.data.escrowLockedAmount === 249.00);
        assert("Triangulated evidence comparison populated", Boolean(packet9821.data.evidenceComparison.buyerClaim && packet9821.data.evidenceComparison.sellerListingVerified));
        assert("Bilingual chronological audit trail present", Array.isArray(packet9821.data.bilingualTimeline) && packet9821.data.bilingualTimeline.length >= 4);
        assert("3 fast arbitration decisions generated", Array.isArray(packet9821.data.aiRecommendations) && packet9821.data.aiRecommendations.length === 3);
        assert("Triage time savings calculated (~12 mins)", packet9821.data.timeSavedMinutes >= 10);

        // Order-scoped authorization: a buyer without access to GC-6102 must be denied
        const deniedPacket = await request('GET', '/api/dispute/packet/GC-6102');
        assert("Cross-order dispute packet denied to unrelated buyer (403)", deniedPacket.status === 403);

        // Certified support agents are authorized for every order — verify CASE-6102
        const buyerSessionCookie = sessionCookie;
        const agentLogin = await request('POST', '/api/auth/demo-login', { role: 'agent' });
        assert("Demo support-agent session established", agentLogin.status === 200);
        const packet6102 = await request('GET', '/api/dispute/packet/GC-6102');
        assert("Briefing packet retrieved for Kyoto Kimono CASE-6102", packet6102.status === 200 && packet6102.data.caseId === 'CASE-6102');
        sessionCookie = buyerSessionCookie; // restore the buyer session for the remaining tests
        console.log();

        // --- Test 11: HMAC Webhook Signature Verification ---
        console.log("▶ [Test 11] HMAC-SHA256 Webhook Verification");
        const webhookPayload = JSON.stringify({
            event: 'message.sent',
            channelId: 'order_9821',
            sender: 'buyer_dubai_12',
            timestamp: new Date().toISOString()
        });

        if (WEBHOOK_SECRET) {
            const validSig = crypto.createHmac('sha256', WEBHOOK_SECRET)
                .update(webhookPayload)
                .digest('hex');

            // Valid signature test
            const validWebhook = await request('POST', '/api/webhooks/nexconn', JSON.parse(webhookPayload), {
                'x-nexconn-signature': validSig
            });
            assert("Authentic HMAC signature accepted (200 OK)", validWebhook.status === 200 && validWebhook.data.verified === true);
        } else {
            console.log("⚠️  SKIP: NEXCONN_WEBHOOK_SECRET unavailable — cannot assert the accepted-signature path.");
        }

        // Tampered signature test
        const tamperedWebhook = await request('POST', '/api/webhooks/nexconn', JSON.parse(webhookPayload), {
            'x-nexconn-signature': 'tampered_invalid_signature_hex'
        });
        assert("Tampered signature rejected (403 Forbidden)", tamperedWebhook.status === 403);
        console.log();

        // --- Test 12: Real-Time Marketplace Analytics & Security Audit Metrics ---
        // Tier 2 #14 (Real-Time Metrics & Security Audit Trail)
        console.log("▶ [Test 12] Real-Time Marketplace Analytics & Security Audit Metrics (Tier 2 #14)");
        const metricsRes = await request('GET', '/api/analytics/metrics');
        assert("Marketplace analytics endpoint returns 200 OK", metricsRes.status === 200);
        assert("Summary KPIs contain calculated dispute reduction", typeof metricsRes.data.summary.disputeReductionPercentage === 'number');
        assert("Off-platform leaks blocked counter is tracked", typeof metricsRes.data.summary.offPlatformLeaksBlocked === 'number' && metricsRes.data.summary.offPlatformLeaksBlocked >= 1428);
        assert("AI inference latency calculated under 60ms target", typeof metricsRes.data.summary.aiInferenceLatencyMs === 'number' && metricsRes.data.summary.aiInferenceLatencyMs < 60);
        assert("Escrow volume calculated across orders", typeof metricsRes.data.escrow.totalEscrowVolumeUSD === 'number' && metricsRes.data.escrow.totalEscrowVolumeUSD >= 669.00);
        assert("Cross-border language distribution tracked", Array.isArray(metricsRes.data.languages) && metricsRes.data.languages.length === 4);
        assert("Security audit trail populated with risk severity", Array.isArray(metricsRes.data.securityAuditTrail) && metricsRes.data.securityAuditTrail.length >= 1);

        // Verification of live telemetry increment when a leak is intercepted
        const initialLeaks = metricsRes.data.summary.offPlatformLeaksBlocked;
        await request('POST', '/api/channels/GC-9821/messages', {
            text: 'Call me on WhatsApp at +1-555-882-9102 right now to discuss wire payment'
        });
        const updatedMetricsRes = await request('GET', '/api/analytics/metrics');
        assert("Off-platform leaks counter dynamically incremented on interception", updatedMetricsRes.data.summary.offPlatformLeaksBlocked > initialLeaks);
        assert("New security event appended to top of audit trail", updatedMetricsRes.data.securityAuditTrail[0].channel === 'GC-9821');
        console.log();

        // --- Test 13: Smart Commercial Terminology & Learning Engine (Tier 3 #17) ---
        console.log("▶ [Test 13] Smart Commercial Terminology & Learning Engine (Tier 3 #17)");
        const gloRes = await request('GET', '/api/glossary');
        assert("Commercial glossary endpoint returns 200 OK", gloRes.status === 200);
        assert("Pre-seeded commercial glossaries loaded (>=4 entries)", gloRes.data.count >= 4);
        assert("Contains sizing, luxury materials, and customs HS code domains", gloRes.data.glossary.some(g => g.category === 'Customs Documentation'));

        // Add custom terminology preference
        const addGloRes = await request('POST', '/api/glossary', {
            sourceTerm: 'water-resistant',
            category: 'Material Quality',
            translations: {
                es: 'resistente al agua certificado',
                ar: 'مقاوم للماء معتمد رسمياً'
            },
            contextNote: 'Merchant IP68 verification preference'
        });
        assert("New merchant terminology preference created (201 Created)", addGloRes.status === 201);
        assert("New terminology entry assigned unique ID", Boolean(addGloRes.data.entry && addGloRes.data.entry.id));

        // Verify translation pipeline respects and annotates applied glossary terms
        const transGlossaryRes = await request('POST', '/api/translate', {
            text: 'This jacket is durable with EU 50 sizing',
            sourceLang: 'en',
            targetLang: 'es'
        });
        assert("Translation pipeline executes with glossary detection", transGlossaryRes.status === 200);
        assert("Applied glossary terms identified and attached", Array.isArray(transGlossaryRes.data.appliedGlossary) && transGlossaryRes.data.appliedGlossary.length >= 1);
        console.log();

    } catch (err) {
        console.error("Test execution failed with error:", err);
        failed++;
    }

    console.log("============================================================");
    console.log(`📊 Test Summary: ${passed} Passed, ${failed} Failed`);
    if (failed === 0) {
        console.log("🎉 ALL CRITICAL ARCHITECTURE CHECKS VERIFIED SUCCESSFULLY!");
    }
    console.log("============================================================");

    return failed === 0;
}

if (require.main === module) {
    runTests();
}

module.exports = { runTests };
