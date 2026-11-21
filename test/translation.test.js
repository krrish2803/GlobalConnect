'use strict';

/**
 * Tests for src/translation.js — no real network calls, fresh temp SQLite DB
 * per run. Run with:  node --test test/translation.test.js
 */

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

// --- Environment must be configured BEFORE the db/translation modules load ---
const DB_FILE = path.join(
    os.tmpdir(),
    `globalconnect-translation-test-${process.pid}-${Date.now()}.db`
);
process.env.DATABASE_PATH = DB_FILE;
process.env.OPENAI_API_KEY = 'sk-test-globalconnect-not-a-real-key';
process.env.OPENAI_MODEL = 'gpt-4o-mini';

const dbModule = require('../src/db');
dbModule.openDatabase();

const store = require('../src/store');
const { translate, resetStateForTests, OPENAI_CONFIG } = require('../src/translation');

const originalFetch = global.fetch;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResponse(payload, { ok = true, status = 200 } = {}) {
    return {
        ok,
        status,
        json: async () => payload
    };
}

/** Valid /v1/responses payload carrying a valid translation schema. */
function openAIResponse(translatedText, confidenceScore = 0.97, culturalAdaptation = 'Tono comercial formal.') {
    return jsonResponse({
        output: [{
            content: [{
                type: 'output_text',
                text: JSON.stringify({ translatedText, confidenceScore, culturalAdaptation })
            }]
        }]
    });
}

function statusResponse(status) {
    return jsonResponse({ error: { message: `mock HTTP ${status}` } }, { ok: false, status });
}

/** Output text that is not valid JSON at all. */
function malformedOutputResponse(badText) {
    return jsonResponse({
        output: [{ content: [{ type: 'output_text', text: badText }] }]
    });
}

function assertInvariants(result, sourceLang, targetLang, originalText) {
    assert.ok(result && typeof result === 'object', 'result must be an object');
    assert.equal(typeof result.translatedText, 'string');
    assert.ok(result.translatedText.length > 0, 'translatedText must be non-empty');
    assert.equal(typeof result.confidenceScore, 'number');
    assert.ok(result.confidenceScore >= 0 && result.confidenceScore <= 1, 'confidenceScore in [0,1]');
    assert.equal(typeof result.inferenceLatencyMs, 'number');
    assert.ok(result.inferenceLatencyMs >= 0, 'latency is a number >= 0');
    assert.equal(result.quotaProtected, true);
    assert.equal(result.sourceLang, sourceLang);
    assert.equal(result.targetLang, targetLang);
    assert.equal(result.originalText, originalText);
    assert.equal(typeof result.cached, 'boolean');
    assert.ok(Array.isArray(result.appliedGlossary));
    assert.ok(
        result.culturalAdaptation === null || typeof result.culturalAdaptation === 'string',
        'culturalAdaptation is string or null'
    );
    assert.ok(
        result.engine === 'curated-corpus' ||
        result.engine === 'procedural-linguistic-engine' ||
        String(result.engine).startsWith('openai-'),
        `unexpected engine: ${result.engine}`
    );
}

function glossaryUsage(term) {
    const entry = store.listGlossary().find(g => g.sourceTerm === term);
    assert.ok(entry, `glossary entry "${term}" exists in seed data`);
    return entry.usageCount;
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

beforeEach(() => {
    resetStateForTests();
    // Default: any unexpected fetch call fails loudly (and is retried once,
    // so tests that expect no network set their own stub).
    global.fetch = async () => {
        throw new Error('unexpected fetch call');
    };
});

after(() => {
    global.fetch = originalFetch;
    try { dbModule.closeDatabase(); } catch (_) { /* already closed */ }
    for (const file of [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`]) {
        try { fs.unlinkSync(file); } catch (_) { /* nothing to clean */ }
    }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('curated corpus hit returns the curated translation with a cultural note', async () => {
    let fetchCalls = 0;
    global.fetch = async () => { fetchCalls++; throw new Error('should not hit the network'); };

    const result = await translate('hello', 'en', 'ar');

    assert.equal(fetchCalls, 0, 'corpus hits must not call OpenAI');
    assert.equal(result.engine, 'curated-corpus');
    assert.equal(result.translatedText, 'مرحباً بكم، يشرفنا التواصل معكم');
    assert.equal(result.culturalAdaptation, 'Formal honorific added to maintain commercial respect.');
    assert.equal(result.cached, false);
    assertInvariants(result, 'en', 'ar', 'hello');
});

test('successful OpenAI response parses correctly and logs to translation_log', async () => {
    let fetchCalls = 0;
    global.fetch = async () => {
        fetchCalls++;
        return openAIResponse('¿Cómo está el pedido?', 0.97, 'Tono comercial formal.');
    };

    const before = store.translationStats().liveTranslations;
    const result = await translate('How is the order going?', 'en', 'es', { orderId: 'GC-9821' });
    const after = store.translationStats().liveTranslations;

    assert.equal(fetchCalls, 1);
    assert.ok(result.engine.startsWith('openai-'), `engine was ${result.engine}`);
    assert.equal(result.translatedText, '¿Cómo está el pedido?');
    assert.equal(result.confidenceScore, 0.97);
    assert.equal(result.culturalAdaptation, 'Tono comercial formal.');
    assert.equal(after, before + 1, 'exactly one translation_log row was added');

    const latest = store.translationStats().recent[0];
    assert.equal(latest.order_id, 'GC-9821');
    assert.equal(latest.engine, result.engine);
    assert.equal(latest.char_count, 'How is the order going?'.length);

    assertInvariants(result, 'en', 'es', 'How is the order going?');
});

test('malformed JSON output from OpenAI falls back gracefully', async () => {
    let fetchCalls = 0;
    global.fetch = async () => {
        fetchCalls++;
        return malformedOutputResponse('this is { definitely not ] json');
    };

    const result = await translate('A brand new question about sizing charts?', 'en', 'de');

    assert.equal(fetchCalls, 1, 'malformed output is not retried');
    assert.equal(result.engine, 'procedural-linguistic-engine');
    assert.ok(result.translatedText.length > 0);
    assertInvariants(result, 'en', 'de', 'A brand new question about sizing charts?');
});

test('HTTP 500 is retried and the second attempt succeeds', async () => {
    let fetchCalls = 0;
    global.fetch = async () => {
        fetchCalls++;
        return fetchCalls === 1 ? statusResponse(500) : openAIResponse('Se enviará el viernes.', 0.93);
    };

    const result = await translate('Can you ship this by Friday?', 'en', 'es');

    assert.equal(fetchCalls, 2, 'exactly one retry after the 500');
    assert.ok(result.engine.startsWith('openai-'));
    assert.equal(result.translatedText, 'Se enviará el viernes.');
    assertInvariants(result, 'en', 'es', 'Can you ship this by Friday?');
});

test('HTTP 429 is retried, then falls back without throwing', async () => {
    let fetchCalls = 0;
    global.fetch = async () => {
        fetchCalls++;
        return statusResponse(429);
    };

    const result = await translate('Do you have this item in stock?', 'en', 'it');

    assert.equal(fetchCalls, 2, '429 is retried once');
    assert.equal(result.engine, 'procedural-linguistic-engine');
    assert.ok(result.translatedText.length > 0);
    assertInvariants(result, 'en', 'it', 'Do you have this item in stock?');
});

test('network rejection falls back without throwing', async () => {
    let fetchCalls = 0;
    global.fetch = async () => {
        fetchCalls++;
        throw new TypeError('fetch failed');
    };

    const result = await translate('What is your return policy?', 'en', 'ja');

    assert.equal(fetchCalls, 2, 'network errors are retried once');
    assert.equal(result.engine, 'procedural-linguistic-engine');
    assert.ok(result.translatedText.length > 0);
    assertInvariants(result, 'en', 'ja', 'What is your return policy?');
});

test('invalid schema from OpenAI falls back with confidence in range', async () => {
    // Case 1: missing translatedText
    global.fetch = async () => malformedOutputResponse(JSON.stringify({ confidenceScore: 0.9 }));
    const missingText = await translate('Is the warranty valid internationally?', 'en', 'de');
    assert.equal(missingText.engine, 'procedural-linguistic-engine');
    assert.ok(missingText.confidenceScore >= 0 && missingText.confidenceScore <= 1);
    assertInvariants(missingText, 'en', 'de', 'Is the warranty valid internationally?');

    // Case 2: confidenceScore not a number
    resetStateForTests();
    global.fetch = async () => malformedOutputResponse(
        JSON.stringify({ translatedText: 'ok', confidenceScore: 'high' })
    );
    const badConfidence = await translate('Another unique question about import duties?', 'en', 'de');
    assert.equal(badConfidence.engine, 'procedural-linguistic-engine');
    assert.ok(badConfidence.confidenceScore >= 0 && badConfidence.confidenceScore <= 1);
    assertInvariants(badConfidence, 'en', 'de', 'Another unique question about import duties?');

    // Case 3: numeric but out-of-range confidence is clamped, not failed
    resetStateForTests();
    global.fetch = async () => malformedOutputResponse(
        JSON.stringify({ translatedText: 'Ein eindeutiger Satz.', confidenceScore: 9 })
    );
    const clamped = await translate('A third unique sentence about packaging?', 'en', 'de');
    assert.ok(clamped.engine.startsWith('openai-'));
    assert.equal(clamped.confidenceScore, 1);
    assertInvariants(clamped, 'en', 'de', 'A third unique sentence about packaging?');
});

test('rate limit: the 11th OpenAI call within a minute skips fetch entirely', async () => {
    let fetchCalls = 0;
    global.fetch = async () => {
        fetchCalls++;
        return openAIResponse('ok', 0.9);
    };

    // Time-travel: space each call 3s apart (> minIntervalMs) while keeping all
    // timestamps inside the 60s RPM window, so the first 10 calls really reach
    // fetch and only the 11th is throttled by the RPM guard.
    const realNow = Date.now;
    let offset = 0;
    Date.now = () => realNow.call(Date) + offset;

    try {
        for (let i = 0; i < 10; i++) {
            const res = await translate(`rate-limit probe number ${i}`, 'en', 'es');
            assert.ok(res.engine.startsWith('openai-'), `probe ${i} should reach OpenAI`);
            offset += 3000;
        }
        assert.equal(fetchCalls, 10, 'first 10 calls reached OpenAI');

        const throttled = await translate('rate-limit final probe', 'en', 'es');
        assert.equal(fetchCalls, 10, '11th call must not reach OpenAI');
        assert.equal(throttled.engine, 'procedural-linguistic-engine');
        assert.ok(throttled.translatedText.length > 0);
        assertInvariants(throttled, 'en', 'es', 'rate-limit final probe');
    } finally {
        Date.now = realNow;
    }
});

test('second identical call is served from cache without calling fetch', async () => {
    let fetchCalls = 0;
    global.fetch = async () => {
        fetchCalls++;
        return openAIResponse('Esta frase exacta se memoriza.', 0.96);
    };

    const text = 'This exact sentence will be cached for sure.';
    const before = store.translationStats().liveTranslations;

    const first = await translate(text, 'en', 'es');
    const mid = store.translationStats().liveTranslations;
    const second = await translate(text, 'en', 'es');
    const after = store.translationStats().liveTranslations;

    assert.equal(first.cached, false);
    assert.equal(second.cached, true);
    assert.equal(fetchCalls, 1, 'cache hit must not call fetch');
    assert.equal(second.inferenceLatencyMs, 3.2);
    assert.equal(second.translatedText, first.translatedText);
    assert.equal(mid, before + 1, 'first call logged');
    assert.equal(after, mid, 'cached call not logged again');
    assertInvariants(second, 'en', 'es', text);

    // resetStateForTests clears the cache: the same text hits the network again
    resetStateForTests();
    const third = await translate(text, 'en', 'es');
    assert.equal(third.cached, false);
    assert.equal(fetchCalls, 2);
});

test('glossary terms are matched, substituted and usage counts incremented', async () => {
    global.fetch = async () => statusResponse(400); // non-retryable -> fast fallback

    const eu50Before = glossaryUsage('EU 50');
    const durableBefore = glossaryUsage('durable');

    const text = 'Need a durable strap for EU 50.';
    const result = await translate(text, 'en', 'es');

    const eu50Entry = result.appliedGlossary.find(g => g.term === 'EU 50');
    const durableEntry = result.appliedGlossary.find(g => g.term === 'durable');
    assert.ok(eu50Entry, 'EU 50 should be in appliedGlossary');
    assert.ok(durableEntry, 'durable should be in appliedGlossary');
    assert.equal(eu50Entry.category, 'Product Sizing');
    assert.equal(eu50Entry.preferred, 'Talla europea 50 (equivale a US 40 / Grande)');
    assert.equal(durableEntry.category, 'Commercial Negotiation');
    assert.equal(durableEntry.preferred, 'resistente de alta durabilidad garantizada');

    assert.equal(glossaryUsage('EU 50'), eu50Before + 1, 'EU 50 usageCount incremented');
    assert.equal(glossaryUsage('durable'), durableBefore + 1, 'durable usageCount incremented');

    // Preferred target-language terms substituted into the translated text
    assert.ok(result.translatedText.includes('Talla europea 50 (equivale a US 40 / Grande)'));
    assert.ok(result.translatedText.includes('resistente de alta durabilidad garantizada'));
    assertInvariants(result, 'en', 'es', text);
});

test('result invariants hold on every pipeline path', async () => {
    // Path 1: curated corpus
    global.fetch = async () => { throw new Error('no network expected'); };
    const corpus = await translate('where is my order?', 'en', 'ar');
    assertInvariants(corpus, 'en', 'ar', 'where is my order?');

    // Path 2: OpenAI success
    resetStateForTests();
    global.fetch = async () => openAIResponse('Traducción de prueba.', 0.99);
    const openai = await translate('An entirely different sentence for the test.', 'en', 'es');
    assertInvariants(openai, 'en', 'es', 'An entirely different sentence for the test.');
    assert.ok(openai.engine.startsWith('openai-'));

    // Path 3: procedural fallback (HTTP 400, no retry)
    resetStateForTests();
    global.fetch = async () => statusResponse(400);
    const fallback = await translate('Yet another sentence nobody has seen.', 'en', 'it');
    assertInvariants(fallback, 'en', 'it', 'Yet another sentence nobody has seen.');
    assert.equal(fallback.engine, 'procedural-linguistic-engine');

    // Path 4: catastrophic — fetch explodes AND fallback must still resolve
    resetStateForTests();
    global.fetch = async () => { throw new Error('hard failure'); };
    const hardFail = await translate('Nothing can break this sentence.', 'en', 'ja');
    assertInvariants(hardFail, 'en', 'ja', 'Nothing can break this sentence.');
    assert.equal(hardFail.engine, 'procedural-linguistic-engine');
});

test('OPENAI_CONFIG is a frozen, lazily-read diagnostics view', () => {
    assert.ok(Object.isFrozen(OPENAI_CONFIG));
    assert.equal(OPENAI_CONFIG.maxRequestsPerMinute, 10);
    assert.equal(OPENAI_CONFIG.minIntervalMs, 2500);
    assert.equal(OPENAI_CONFIG.apiKey, process.env.OPENAI_API_KEY);

    const previousModel = process.env.OPENAI_MODEL;
    process.env.OPENAI_MODEL = 'gpt-test-lazy';
    try {
        assert.equal(OPENAI_CONFIG.model, 'gpt-test-lazy', 'model must be read from env at access time');
    } finally {
        if (previousModel === undefined) delete process.env.OPENAI_MODEL;
        else process.env.OPENAI_MODEL = previousModel;
    }
    assert.equal(OPENAI_CONFIG.model, 'gpt-4o-mini');
    assert.ok(Array.isArray(OPENAI_CONFIG.requestTimestamps));
    assert.equal(typeof OPENAI_CONFIG.lastCallTimestamp, 'number');
});
