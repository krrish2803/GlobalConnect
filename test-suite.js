/**
 * GlobalConnect - Automated Verification Test Suite
 * Nexconn Build Challenge 2026 - Day 1 Checklist Verifications
 *
 * Verifies:
 * 1. Health & Service Gateway Availability
 * 2. Role-Based Token Generation (Buyer, Seller, Agent)
 * 3. Real-Time Translation with Cultural Nuance Adaptation
 * 4. Contact Masking Security Filter (Phone, Email, Off-Platform Apps)
 * 5. Sandbox Escrow Ledger Lifecycle & Fund Freezing
 * 6. AI Dispute Mediator & 72-Hour Resolution Plan
 * 7. HMAC-SHA256 Signed Webhook Verification & Tamper Rejection
 */

const http = require('http');
const crypto = require('crypto');

const PORT = 3000;
const WEBHOOK_SECRET = 'gc_live_secret_7f89d023a4';

function request(method, path, body = null, headers = {}) {
    return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : null;
        const options = {
            hostname: '127.0.0.1',
            port: PORT,
            path: path,
            method: method,
            headers: {
                'Content-Type': 'application/json',
                ...headers
            }
        };

        if (payload) {
            options.headers['Content-Length'] = Buffer.byteLength(payload);
        }

        const req = http.request(options, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                let parsed = null;
                try {
                    parsed = JSON.parse(data);
                } catch (e) {
                    parsed = data;
                }
                resolve({ status: res.statusCode, data: parsed });
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
    console.log("   Nexconn Build Challenge 2026 • Core System Validation");
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
        assert("Gateway identifies as GlobalConnect", health.data.service === 'GlobalConnect API Gateway');
        console.log();

        // --- Test 2: Auth Token Generation ---
        console.log("▶ [Test 2] Role-Based Token Endpoint");
        const tokenRes = await request('POST', '/api/auth/token', {
            userId: 'buyer_dubai_12',
            role: 'buyer'
        });
        assert("Token endpoint returns 200 OK", tokenRes.status === 200);
        assert("Valid JWT structure returned", typeof tokenRes.data.token === 'string' && tokenRes.data.token.split('.').length === 3);
        assert("Token expires in 86400s (24h)", tokenRes.data.expiresIn === 86400);
        console.log();

        // --- Test 3: Translation & Cultural Etiquette ---
        console.log("▶ [Test 3] Translation & Cultural Context Engine");
        const transRes = await request('POST', '/api/translate', {
            text: 'Is this genuine leather?',
            sourceLang: 'en',
            targetLang: 'ar',
            culturalContext: true
        });
        assert("Translation returns 200 OK", transRes.status === 200);
        assert("Confidence score exceeds 95%", transRes.data.confidenceScore >= 0.95);
        assert("Inference latency is under 60ms", transRes.data.inferenceLatencyMs < 60);
        assert("Cultural context notes provided", typeof transRes.data.culturalAdaptation === 'string');
        console.log();

        // --- Test 4: Contact Masking & Security Guard ---
        console.log("▶ [Test 4] Contact Masking & Leak Prevention");
        const cleanMsg = await request('POST', '/api/moderate', { text: 'What is the tracking number?' });
        assert("Clean message passes with 100% compliance", cleanMsg.data.isClean === true && cleanMsg.data.policyComplianceScore === 100);

        const leakMsg = await request('POST', '/api/moderate', {
            text: 'Call my cell at +1-555-482-1920 or message on WhatsApp to pay via PayPal'
        });
        assert("Violations accurately detected", leakMsg.data.isClean === false && leakMsg.data.violationsBlocked.length >= 2);
        assert("Phone number redacted", leakMsg.data.sanitizedText.includes('[REDACTED PHONE]'));
        assert("Platform keyword redacted", leakMsg.data.sanitizedText.includes('[OFF-PLATFORM CHANNEL REDACTED]'));
        console.log();

        // --- Test 5: Sandbox Escrow Ledger ---
        console.log("▶ [Test 5] Milestone Escrow Lifecycle");
        const escrowStatus = await request('GET', '/api/escrow/GC-9821');
        assert("Order GC-9821 exists in sandbox ledger", escrowStatus.status === 200);
        assert("Escrow amount is $249.00 USD", escrowStatus.data.amount === 249.00);

        const dispatchAction = await request('POST', '/api/escrow/action', {
            orderId: 'GC-9821',
            action: 'DISPATCH'
        });
        assert("Courier dispatch updates status to IN_TRANSIT", dispatchAction.data.newStatus === 'IN_TRANSIT');
        console.log();

        // --- Test 6: AI Dispute Mediator ---
        console.log("▶ [Test 6] AI Dispute Mediation & Escrow Freezing");
        const disputeAction = await request('POST', '/api/escrow/action', {
            orderId: 'GC-9821',
            action: 'DISPUTE'
        });
        assert("Dispute freeze updates status to ESCROW_FROZEN", disputeAction.data.newStatus === 'ESCROW_FROZEN');
        assert("72-hour mediation window established", disputeAction.data.dispute !== null && disputeAction.data.dispute.status === 'AI_MEDIATION_ACTIVE');
        assert("3 neutral settlement proposals generated", disputeAction.data.dispute.settlementProposals.length === 3);
        console.log();

        // --- Test 7: HMAC Webhook Signature Verification ---
        console.log("▶ [Test 7] HMAC-SHA256 Webhook Verification");
        const webhookPayload = JSON.stringify({
            event: 'message.sent',
            channelId: 'order_9821',
            sender: 'buyer_dubai_12',
            timestamp: new Date().toISOString()
        });

        const validSig = crypto.createHmac('sha256', WEBHOOK_SECRET)
            .update(webhookPayload)
            .digest('hex');

        // Valid signature test
        const validWebhook = await request('POST', '/api/webhooks/nexconn', JSON.parse(webhookPayload), {
            'x-nexconn-signature': validSig
        });
        assert("Authentic HMAC signature accepted (200 OK)", validWebhook.status === 200 && validWebhook.data.verified === true);

        // Tampered signature test
        const tamperedWebhook = await request('POST', '/api/webhooks/nexconn', JSON.parse(webhookPayload), {
            'x-nexconn-signature': 'tampered_invalid_signature_hex'
        });
        assert("Tampered signature rejected (403 Forbidden)", tamperedWebhook.status === 403);
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
}

runTests();
