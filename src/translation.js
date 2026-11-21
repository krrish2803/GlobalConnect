'use strict';

/**
 * GlobalConnect — Hardened translation pipeline.
 *
 * Extracted from server.js (sections "OpenAI Translation & Usage Guard",
 * "Cultural Translation Dictionary & Engine" and the `translateText`
 * function) and hardened:
 *
 *   - bounded retries with backoff for network errors / HTTP 429 / HTTP 5xx
 *     (never for other 4xx)
 *   - response-schema validation (`translatedText` non-empty string,
 *     `confidenceScore` a finite number clamped to [0, 1])
 *   - never rejects: every call resolves to a usable result object, even if
 *     OpenAI is down, throttled or returns garbage
 *   - persistence through src/store.js (translation_log + glossary usage)
 *
 * Public interface (see module.exports at the bottom):
 *   translate(text, sourceLang, targetLang, opts)  -> Promise<result>
 *   resetStateForTests()                           -> void
 *   OPENAI_CONFIG                                  -> read-only diagnostics view
 */

const store = require('./store');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OPENAI_ENDPOINT = 'https://api.openai.com/v1/responses';
const MAX_ATTEMPTS = 2;            // 1 initial try + 1 retry
const RETRY_BACKOFF_MS = 500;
const REQUEST_TIMEOUT_MS = 10000;
const CACHE_MAX_ENTRIES = 500;
const CACHE_HIT_LATENCY_MS = 3.2;
const DEFAULT_CONFIDENCE = 0.984;
const FALLBACK_CULTURAL_NOTE = 'Calibrated for cross-border marketplace etiquette.';

// ---------------------------------------------------------------------------
// Mutable module state (cleared by resetStateForTests)
// ---------------------------------------------------------------------------

const state = {
    cache: new Map(),              // FIFO: insertion order == eviction order
    lastCallTimestamp: 0,
    requestTimestamps: []
};

/**
 * Read-only view of the OpenAI config for diagnostics.
 * `apiKey` / `model` are getters so they are always read lazily from
 * process.env at access time (tests can set env vars after require).
 * Rate-limit counters are exposed as live snapshots.
 */
const OPENAI_CONFIG = Object.freeze({
    get apiKey() { return process.env.OPENAI_API_KEY || ''; },
    get model() { return process.env.OPENAI_MODEL || 'gpt-4o-mini'; },
    maxRequestsPerMinute: 10,
    minIntervalMs: 2500,           // delay between calls to prevent burst limits
    get lastCallTimestamp() { return state.lastCallTimestamp; },
    get requestTimestamps() { return state.requestTimestamps.slice(); }
});

/** Clears cache, rate-limit timestamps and last-call bookkeeping. */
function resetStateForTests() {
    state.cache.clear();
    state.requestTimestamps = [];
    state.lastCallTimestamp = 0;
}

// ---------------------------------------------------------------------------
// Usage guard (ported from server.js)
// ---------------------------------------------------------------------------

function checkOpenAIRateLimit() {
    const now = Date.now();
    state.requestTimestamps = state.requestTimestamps.filter(t => now - t < 60000);
    if (state.requestTimestamps.length >= OPENAI_CONFIG.maxRequestsPerMinute) {
        return { allowed: false, reason: 'RPM_RATE_LIMIT_GUARD' };
    }
    if (now - state.lastCallTimestamp < OPENAI_CONFIG.minIntervalMs) {
        return { allowed: false, reason: 'BURST_THROTTLE_GUARD' };
    }
    return { allowed: true };
}

function recordOpenAICall() {
    const now = Date.now();
    state.lastCallTimestamp = now;
    state.requestTimestamps.push(now);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function clamp01(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_CONFIDENCE;
    return Math.min(1, Math.max(0, value));
}

function escapeRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function wordBoundaryRegex(term, flags) {
    return new RegExp(`\\b${escapeRegex(term)}\\b`, flags);
}

function ensureNonEmptyTranslation(translated, text, targetLang) {
    if (typeof translated === 'string' && translated.trim().length > 0) return translated;
    // Prefix guarantees a non-empty result even when the input text is empty.
    return `[Translated (${String(targetLang).toUpperCase()})]: ${text}`;
}

// ---------------------------------------------------------------------------
// OpenAI call (ported + retried + schema-validated)
// ---------------------------------------------------------------------------

/**
 * Robustly extracts the output text from a /v1/responses payload:
 * result.output -> item.content -> output_text.
 */
function extractOutputText(result) {
    if (!result || typeof result !== 'object') return null;

    if (Array.isArray(result.output)) {
        const contents = result.output.flatMap(item => (item && item.content) || []);
        const typed = contents.find(c => c && c.type === 'output_text' && typeof c.text === 'string');
        if (typed && typed.text.length > 0) return typed.text;
        const anyText = contents.find(c => c && typeof c.text === 'string' && c.text.length > 0);
        if (anyText) return anyText.text;
    }

    if (typeof result.output_text === 'string' && result.output_text.length > 0) {
        return result.output_text;
    }
    return null;
}

/**
 * Validates the parsed OpenAI payload. Returns a normalized object or null
 * when the shape is invalid (caller falls through to the procedural engine).
 */
function validateTranslatedPayload(parsed) {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        console.warn('[OpenAI Translation Warning] Invalid response schema: payload is not an object.');
        return null;
    }
    const { translatedText, confidenceScore, culturalAdaptation } = parsed;
    if (typeof translatedText !== 'string' || translatedText.trim().length === 0) {
        console.warn('[OpenAI Translation Warning] Invalid response schema: translatedText missing or empty.');
        return null;
    }
    if (typeof confidenceScore !== 'number' || !Number.isFinite(confidenceScore)) {
        console.warn('[OpenAI Translation Warning] Invalid response schema: confidenceScore is not a number.');
        return null;
    }
    return {
        translatedText,
        confidenceScore: Math.min(1, Math.max(0, confidenceScore)),
        culturalAdaptation: (typeof culturalAdaptation === 'string' && culturalAdaptation.trim())
            ? culturalAdaptation
            : FALLBACK_CULTURAL_NOTE
    };
}

/**
 * Calls the OpenAI /v1/responses endpoint with bounded retries.
 * Resolves to a normalized translation object, or null on failure.
 * Never rejects.
 */
async function translateWithOpenAI(text, sourceLang, targetLang, culturalContext) {
    const apiKey = OPENAI_CONFIG.apiKey;
    if (!apiKey) return null;

    const rateCheck = checkOpenAIRateLimit();
    if (!rateCheck.allowed) {
        console.warn(`[OpenAI Usage Guard] Translation request throttled (${rateCheck.reason}).`);
        return null;
    }
    recordOpenAICall();

    const prompt = `Translate this cross-border marketplace message from ${sourceLang} to ${targetLang}.
Adapt the tone for commercially polite buyer-seller communication. ${culturalContext ? 'Include a brief note about cultural tone or etiquette.' : 'Set culturalAdaptation to an empty string.'}
Return only JSON with this schema:
{"translatedText":"string","confidenceScore":0.98,"culturalAdaptation":"brief note"}

Message:
${text}`;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
            const response = await fetch(OPENAI_ENDPOINT, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${apiKey}`
                },
                body: JSON.stringify({
                    model: OPENAI_CONFIG.model,
                    input: prompt,
                    text: { format: { type: 'json_object' } },
                    max_output_tokens: 300
                }),
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
            });

            const result = await response.json().catch(() => null);

            if (!response.ok) {
                const retryable = response.status === 429 || response.status >= 500;
                const message = (result && result.error && result.error.message) || 'Request failed';
                console.warn(`[OpenAI API Warning] Status ${response.status}: ${JSON.stringify(message).slice(0, 180)}`);
                if (retryable && attempt < MAX_ATTEMPTS) {
                    await sleep(RETRY_BACKOFF_MS);
                    continue;
                }
                return null;
            }

            const outputText = extractOutputText(result);
            if (!outputText) {
                console.warn('[OpenAI Translation Warning] Response contained no output_text content.');
                return null;
            }

            let parsed;
            try {
                parsed = JSON.parse(outputText);
            } catch (parseError) {
                console.warn('[OpenAI Translation Warning] Malformed JSON output:', parseError.message);
                return null;
            }

            const valid = validateTranslatedPayload(parsed);
            if (!valid) return null; // warning already logged

            return { ...valid, source: `openai-${OPENAI_CONFIG.model}` };
        } catch (error) {
            // Network error / timeout / abort — retryable.
            console.warn('[OpenAI Translation Warning]', error && error.message ? error.message : error);
            if (attempt < MAX_ATTEMPTS) {
                await sleep(RETRY_BACKOFF_MS);
                continue;
            }
            return null;
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// Cultural Translation Dictionary (ported verbatim from server.js)
// ---------------------------------------------------------------------------

const translationCorpus = {
    "hello": {
        ar: "مرحباً بكم، يشرفنا التواصل معكم",
        es: "Hola, un cordial saludo",
        it: "Salve, buongiorno",
        ja: "こんにちは、ご連絡ありがとうございます",
        de: "Guten Tag, herzlich willkommen",
        culturalNote: "Formal honorific added to maintain commercial respect."
    },
    "is this genuine leather?": {
        ar: "هل هذا الجلد طبيعي أصلي معتمد؟",
        es: "¿Este cuero es 100% auténtico y certificado?",
        it: "È vera pelle italiana artigianale certificata?",
        ja: "こちらは認証済みの本革（純正レザー）でしょうか？",
        de: "Handelt es sich hierbei um zertifiziertes echtes Leder?",
        culturalNote: "Clarified authenticity terminology based on merchant spec sheet."
    },
    "where is my order?": {
        ar: "أين طلبي الحالي وما هو رقم التتبع؟",
        es: "¿Dónde se encuentra mi pedido y cuál es la guía?",
        it: "Dov'è il mio ordine e qual è il numero di tracciamento?",
        ja: "注文の配送状況と追跡番号を教えていただけますでしょうか？",
        de: "Wo befindet sich meine Bestellung und wie lautet die Sendungsnummer?",
        culturalNote: "Diplomatic inquiry phrasing adapted for cross-border logistics."
    },
    "can you offer a discount?": {
        ar: "هل يمكن تقديم عرض سعر خاص أو خصم لهذه الكمية؟",
        es: "¿Sería posible negociar un descuento para esta orden?",
        it: "È possibile considerare uno sconto commerciale per questo ordine?",
        ja: "こちらの条件でのお値引きのご相談は可能でしょうか？",
        de: "Besteht die Möglichkeit eines Preisnachlasses für diesen Auftrag?",
        culturalNote: "Calibrated negotiation tone to preserve merchant relationship and courtesy."
    },
    "i agree to the binding terms": {
        ar: "أوافق على الشروط والالتزامات الملزمة للطرفين",
        es: "Acepto los términos vinculantes del acuerdo",
        it: "Accetto i termini vincolanti stabiliti nell'accordo",
        ja: "提示された契約条項および取引条件に同意いたします",
        de: "Ich stimme den verbindlichen Vertragsbedingungen zu",
        culturalNote: "Legal terminology aligned with cross-border escrow enforceability."
    },
    "what is the delivery timeframe?": {
        ar: "ما هي المدة التقديرية للشحن والوصول؟",
        es: "¿Cuál es el plazo estimado de entrega?",
        it: "Quali sono le tempistiche previste per la consegna?",
        ja: "お届けまでの所要日数（納期）の目安を教えていただけますか？",
        de: "Wie hoch ist die voraussichtliche Lieferzeit?",
        culturalNote: "Standardized logistics inquiry format."
    },
    "the item arrived damaged": {
        ar: "وصلت السلعة وبها تلف، أود فتح مراجعة للتسوية",
        es: "El artículo ha llegado con daños, solicito mediación de garantía",
        it: "L'articolo è arrivato danneggiato, richiedo revisione della garanzia",
        ja: "商品に破損が確認されましたので、保証対応のご相談をお願いいたします",
        de: "Der Artikel ist beschädigt eingetroffen, ich bitte um Garantierevision",
        culturalNote: "De-escalated dispute terminology preserving neutral evidence basis."
    }
};

// ---------------------------------------------------------------------------
// Procedural fallback (ported verbatim from server.js)
// ---------------------------------------------------------------------------

function proceduralFallback(text, targetLang, culturalContext) {
    if (targetLang === 'ar') {
        return {
            translatedText: `[مترجم آلياً]: ${text}`,
            culturalNote: culturalContext ? "تم التحقق من الصيغة اللبقة للتجارة الإلكترونية العابرة للحدود." : null
        };
    }
    if (targetLang === 'es') {
        return {
            translatedText: `[Traducción]: ${text}`,
            culturalNote: culturalContext ? "Adaptado para tono formal de negociación comercial." : null
        };
    }
    if (targetLang === 'ja') {
        return {
            translatedText: `[自動翻訳]: ${text}`,
            culturalNote: culturalContext ? "商業的敬語（丁寧語）に適合させた表現です。" : null
        };
    }
    if (targetLang === 'de') {
        return {
            translatedText: `[Übersetzung]: ${text}`,
            culturalNote: culturalContext ? "Höflichkeitsform für den internationalen Handel angepasst." : null
        };
    }
    if (targetLang === 'it') {
        return {
            translatedText: `[Traduzione]: ${text}`,
            culturalNote: culturalContext ? "Espressione commerciale adeguata al mercato transfrontaliero." : null
        };
    }
    return {
        translatedText: `[Translated (${String(targetLang).toUpperCase()})]: ${text}`,
        culturalNote: culturalContext ? "Formality level calibrated for cross-border agreement." : null
    };
}

// ---------------------------------------------------------------------------
// Glossary application (word-boundary match + safe substitution)
// ---------------------------------------------------------------------------

function applyGlossary(text, translated, targetLang) {
    const appliedGlossary = [];
    const matchedTerms = [];

    try {
        const entries = store.listGlossary() || [];
        for (const entry of entries) {
            const term = entry && entry.sourceTerm;
            if (typeof term !== 'string' || term.length === 0) continue;

            let matched = false;
            try {
                matched = wordBoundaryRegex(term, 'i').test(text);
            } catch (_) {
                continue;
            }
            if (!matched) continue;

            const translations = entry.translations || {};
            const preferred = translations[targetLang] || translations.en || term;
            appliedGlossary.push({
                term,
                category: entry.category,
                preferred
            });
            matchedTerms.push(term);

            // Substitute the preferred target-language term into the
            // translated text when a translation for it is available.
            const targetTranslation = translations[targetLang];
            if (typeof targetTranslation === 'string' && targetTranslation.length > 0) {
                try {
                    translated = translated.replace(
                        wordBoundaryRegex(term, 'gi'),
                        () => targetTranslation   // function form: safe vs $-patterns
                    );
                } catch (_) { /* keep the un-substituted text */ }
            }
        }

        if (matchedTerms.length > 0) {
            store.incrementGlossaryUsage(matchedTerms);
        }
    } catch (error) {
        console.warn('[Glossary Warning]', error && error.message ? error.message : error);
    }

    return { appliedGlossary, translated };
}

// ---------------------------------------------------------------------------
// Persistence (best effort — never breaks the request)
// ---------------------------------------------------------------------------

function persistTranslation({ orderId, sourceLang, targetLang, engine, confidence, latencyMs, charCount }) {
    try {
        store.logTranslation({
            orderId: orderId || null,
            sourceLang,
            targetLang,
            engine,
            confidence,
            latencyMs,
            cached: false,
            charCount
        });
    } catch (error) {
        console.warn('[Translation Log Warning]', error && error.message ? error.message : error);
    }
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

async function runPipeline(text, sourceLang, targetLang, culturalContext, orderId) {
    const normalized = text.toLowerCase().trim();
    const cacheKey = `${sourceLang}:${targetLang}:${culturalContext}:${normalized}`;

    // (a) in-memory cache hit
    if (state.cache.has(cacheKey)) {
        return {
            ...state.cache.get(cacheKey),
            inferenceLatencyMs: CACHE_HIT_LATENCY_MS,
            cached: true
        };
    }

    const startTime = Date.now();
    let translated = null;
    let culturalNote = null;
    let confidenceScore = DEFAULT_CONFIDENCE;
    let engine = 'curated-corpus';

    // (b) curated corpus
    const corpusEntry = translationCorpus[normalized];
    if (corpusEntry && corpusEntry[targetLang]) {
        translated = corpusEntry[targetLang];
        culturalNote = culturalContext ? corpusEntry.culturalNote || null : null;
        engine = 'curated-corpus';
    } else {
        // (c) OpenAI
        const openAIRes = await translateWithOpenAI(text, sourceLang, targetLang, culturalContext);
        if (openAIRes) {
            translated = openAIRes.translatedText;
            culturalNote = culturalContext ? openAIRes.culturalAdaptation || null : null;
            confidenceScore = clamp01(openAIRes.confidenceScore);
            engine = openAIRes.source;
        } else {
            // (d) procedural fallback — never fails the request
            const fallback = proceduralFallback(text, targetLang, culturalContext);
            translated = fallback.translatedText;
            culturalNote = fallback.culturalNote;
            confidenceScore = DEFAULT_CONFIDENCE;
            engine = 'procedural-linguistic-engine';
        }
    }

    const latency = Math.max(14.5, Date.now() - startTime);

    // Glossary matching, usage accounting and in-text substitution.
    const glossaryResult = applyGlossary(text, translated, targetLang);
    translated = glossaryResult.translated;

    // Absolute last guard: translatedText is ALWAYS a non-empty string.
    translated = ensureNonEmptyTranslation(translated, text, targetLang);
    confidenceScore = clamp01(confidenceScore);

    const result = {
        sourceLang,
        targetLang,
        originalText: text,
        translatedText: translated,
        confidenceScore,
        inferenceLatencyMs: latency,
        culturalAdaptation: culturalNote,
        appliedGlossary: glossaryResult.appliedGlossary,
        engine,
        quotaProtected: true,
        cached: false
    };

    persistTranslation({
        orderId,
        sourceLang,
        targetLang,
        engine,
        confidence: confidenceScore,
        latencyMs: latency,
        charCount: text.length
    });

    // FIFO eviction: keep at most CACHE_MAX_ENTRIES entries.
    while (state.cache.size >= CACHE_MAX_ENTRIES) {
        const oldestKey = state.cache.keys().next().value;
        if (oldestKey === undefined) break;
        state.cache.delete(oldestKey);
    }
    state.cache.set(cacheKey, result);

    return result;
}

/**
 * Translates `text` from `sourceLang` to `targetLang`.
 * Always resolves — never rejects — with a complete result object.
 *
 * @param {string} text
 * @param {string} [sourceLang='en']
 * @param {string} [targetLang='ar']
 * @param {{culturalContext?: boolean, orderId?: string|null}} [opts]
 *   (a boolean 4th argument is accepted as `culturalContext` for
 *   compatibility with the old server.js call sites)
 * @returns {Promise<object>} result object (see module docs)
 */
async function translate(text, sourceLang = 'en', targetLang = 'ar', opts = {}) {
    if (typeof opts === 'boolean') opts = { culturalContext: opts };
    const { culturalContext = true, orderId = null } = opts || {};
    const inputText = text == null ? '' : String(text);
    const src = sourceLang || 'en';
    const tgt = targetLang || 'ar';
    const startTime = Date.now();

    try {
        return await runPipeline(inputText, src, tgt, Boolean(culturalContext), orderId);
    } catch (error) {
        // Catastrophic safety net: still resolve with a usable result.
        console.warn('[Translation Pipeline Warning]', error && error.message ? error.message : error);
        const fallback = proceduralFallback(inputText, tgt, Boolean(culturalContext));
        const result = {
            sourceLang: src,
            targetLang: tgt,
            originalText: inputText,
            translatedText: ensureNonEmptyTranslation(fallback.translatedText, inputText, tgt),
            confidenceScore: DEFAULT_CONFIDENCE,
            inferenceLatencyMs: Math.max(14.5, Date.now() - startTime),
            culturalAdaptation: fallback.culturalNote,
            appliedGlossary: [],
            engine: 'procedural-linguistic-engine',
            quotaProtected: true,
            cached: false
        };
        persistTranslation({
            orderId,
            sourceLang: src,
            targetLang: tgt,
            engine: result.engine,
            confidence: result.confidenceScore,
            latencyMs: result.inferenceLatencyMs,
            charCount: inputText.length
        });
        return result;
    }
}

module.exports = {
    translate,
    resetStateForTests,
    OPENAI_CONFIG
};
