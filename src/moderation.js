/**
 * GlobalConnect — Contact Masking / Security Guard
 *
 * Regex-based redaction of phone numbers, emails and off-platform payment or
 * messaging channels, with persistent security-event recording.
 */

const store = require('./store');

const phonePattern = /(?:(?:\+?1\s*(?:[.-]\s*)?)?(?:\(\s*([2-9]1[02-9]|[2-9][02-8]1|[2-9][02-8][02-9])\s*\)|([2-9]1[02-9]|[2-9][02-8]1|[2-9][02-8][02-9]))\s*(?:[.-]\s*)?)?([2-9]1[02-9]|[2-9][02-9]1|[2-9][02-9]{2})\s*(?:[.-]\s*)?([0-9]{4})(?:\s*(?:#|x\.?|ext\.?|extension)\s*(\d+))?/gi;
const emailPattern = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi;
const platformKeywords = /\b(whatsapp|telegram|wechat|paypal|venmo|cashapp|zelle|wire transfer)\b/gi;

/**
 * Scan and redact a message.
 * @returns {{originalText:string, sanitizedText:string, isClean:boolean,
 *            isMasked:boolean, violationsBlocked:string[], policyComplianceScore:number}}
 */
function moderateText(text, channelId = 'LIVE_SCANNER') {
    const violations = [];
    let maskedText = String(text);

    // Reset lastIndex — these are shared /g regexes used with .test()
    [phonePattern, emailPattern, platformKeywords].forEach(re => { re.lastIndex = 0; });
    if (phonePattern.test(maskedText)) violations.push('PHONE_NUMBER_DETECTED');
    [phonePattern, emailPattern, platformKeywords].forEach(re => { re.lastIndex = 0; });
    if (emailPattern.test(maskedText)) violations.push('EMAIL_DETECTED');
    [phonePattern, emailPattern, platformKeywords].forEach(re => { re.lastIndex = 0; });
    if (platformKeywords.test(maskedText)) violations.push('EXTERNAL_PAYMENT_PLATFORM');

    if (violations.includes('PHONE_NUMBER_DETECTED')) {
        maskedText = maskedText.replace(phonePattern, '[REDACTED PHONE]');
    }
    if (violations.includes('EMAIL_DETECTED')) {
        maskedText = maskedText.replace(emailPattern, '[REDACTED EMAIL]');
    }
    if (violations.includes('EXTERNAL_PAYMENT_PLATFORM')) {
        maskedText = maskedText.replace(platformKeywords, '[OFF-PLATFORM CHANNEL REDACTED]');
    }

    const isClean = violations.length === 0;

    if (!isClean) {
        try {
            store.addSecurityEvent({
                channel: channelId,
                eventType: violations.includes('EXTERNAL_PAYMENT_PLATFORM')
                    ? 'DIRECT_PAYMENT_BYPASS_BLOCKED'
                    : 'OFF_PLATFORM_CONTACT_BLOCKED',
                redactedPattern: violations.join(', '),
                details: `Contact Masking Guard intercepted: ${violations.join(', ')}`,
                severity: violations.includes('EXTERNAL_PAYMENT_PLATFORM') ? 'HIGH' : 'MEDIUM'
            });
        } catch (error) {
            console.warn('[moderation] failed to persist security event:', error.message);
        }
    }

    return {
        originalText: text,
        sanitizedText: maskedText,
        isClean,
        isMasked: !isClean,
        violationsBlocked: violations,
        policyComplianceScore: isClean ? 100 : 35
    };
}

module.exports = { moderateText };
