"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.cleanPromptText = exports.sanitizeForPrompt = void 0;
const logger_1 = require("../../utils/logger");
const PATTERNS = [
    {
        id: 'ignore_previous',
        regex: /\b(ignore|disregard|forget|override|bypass)\s+(all\s+)?(previous|prior|above|earlier|the)\s+(instructions?|prompts?|rules?|directives?|context)\b/gi,
    },
    {
        id: 'role_override',
        regex: /\byou\s+are\s+now\s+(an?|the)\s+\w+/gi,
    },
    {
        id: 'pretend_to_be',
        regex: /\b(pretend|act|behave|roleplay|role-play)\s+(to\s+be|as)\s+(an?|the)\s+\w+/gi,
    },
    { id: 'system_tag_close', regex: /<\s*\/?\s*system\s*>/gi },
    { id: 'system_bracket', regex: /\[\s*\/?\s*system\s*\]/gi },
    { id: 'instruction_tag', regex: /<\s*\/?\s*(instruction|prompt)s?\s*>/gi },
    { id: 'role_speaker', regex: /^(assistant|ai|system)\s*:/gim },
    {
        id: 'developer_mode',
        regex: /\b(developer|dev|jailbreak|dan|sudo)\s+mode\b/gi,
    },
    {
        id: 'reveal_prompt',
        regex: /\b(what|show|reveal|print|repeat|tell\s+me)\s+(is\s+)?(your|the)\s+(system|hidden|secret)\s+(prompt|instructions?)\b/gi,
    },
];
const REDACTION = '[blocked]';
const sanitizeForPrompt = (input, feature, userId) => {
    const original = (input || '').toString();
    if (!original)
        return { text: '', hits: [], changed: false };
    let text = original;
    const hits = [];
    for (const pattern of PATTERNS) {
        const before = text;
        text = text.replace(pattern.regex, REDACTION);
        if (text !== before)
            hits.push(pattern.id);
    }
    if (hits.length > 0) {
        logger_1.logger.warn(`[promptGuard] feature=${feature} userId=${userId ?? '-'} hits=${hits.join(',')}`);
    }
    return { text, hits, changed: hits.length > 0 };
};
exports.sanitizeForPrompt = sanitizeForPrompt;
const cleanPromptText = (input, feature, userId) => (0, exports.sanitizeForPrompt)(input, feature, userId).text;
exports.cleanPromptText = cleanPromptText;
