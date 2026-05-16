import { logger } from '../../utils/logger';

/**
 * Best-effort prompt-injection guard for user-supplied text that ends
 * up inside an AI prompt (chat messages, resume rewriter input, JD
 * polish input, skill-extract input, etc).
 *
 * What we DO defend against:
 *   - "ignore previous instructions" + variants
 *   - role-overrides ("you are now …")
 *   - system-prompt resets ("</system>", "[/system]")
 *   - obvious tool-output spoofing ("Assistant:", "AI:")
 *
 * What we DON'T pretend to defend against (no LLM-based defence is
 * watertight):
 *   - encoded / multi-language jailbreaks
 *   - persona-shifting via flattery
 *   - data-exfiltration via crafted role-play
 *
 * The contract: input is sanitised IN-PLACE — patterns are replaced
 * with a `[blocked]` marker so the downstream model still sees the
 * surrounding context but loses the override token. We never throw,
 * because that would punish the legitimate user whose phrasing
 * accidentally tripped a heuristic. The hit is logged for telemetry.
 */

interface InjectionPattern {
  /** Stable id used in logs + telemetry. */
  id: string;
  /** Regex; the `g` and `i` flags are added automatically. */
  regex: RegExp;
}

const PATTERNS: InjectionPattern[] = [
  // System override classics
  {
    id: 'ignore_previous',
    regex:
      /\b(ignore|disregard|forget|override|bypass)\s+(all\s+)?(previous|prior|above|earlier|the)\s+(instructions?|prompts?|rules?|directives?|context)\b/gi,
  },
  {
    id: 'role_override',
    regex:
      /\byou\s+are\s+now\s+(an?|the)\s+\w+/gi,
  },
  {
    id: 'pretend_to_be',
    regex:
      /\b(pretend|act|behave|roleplay|role-play)\s+(to\s+be|as)\s+(an?|the)\s+\w+/gi,
  },
  // System / tool tag spoofing
  { id: 'system_tag_close', regex: /<\s*\/?\s*system\s*>/gi },
  { id: 'system_bracket', regex: /\[\s*\/?\s*system\s*\]/gi },
  { id: 'instruction_tag', regex: /<\s*\/?\s*(instruction|prompt)s?\s*>/gi },
  // Conversation spoofing — tries to make the model think the user is
  // "Assistant:" speaking inside a transcript.
  { id: 'role_speaker', regex: /^(assistant|ai|system)\s*:/gim },
  // Common "developer mode" / "DAN" jailbreak markers
  {
    id: 'developer_mode',
    regex: /\b(developer|dev|jailbreak|dan|sudo)\s+mode\b/gi,
  },
  // Direct meta-prompts asking the model to reveal its system prompt
  {
    id: 'reveal_prompt',
    regex:
      /\b(what|show|reveal|print|repeat|tell\s+me)\s+(is\s+)?(your|the)\s+(system|hidden|secret)\s+(prompt|instructions?)\b/gi,
  },
];

/** Replacement marker. Short on purpose — visible to the model + the
 *  user without bloating the surrounding sentence. */
const REDACTION = '[blocked]';

export interface SanitizeResult {
  text: string;
  hits: string[];
  changed: boolean;
}

/**
 * Sanitise `input` for inclusion in an LLM prompt. Returns the cleaned
 * string + a list of pattern ids that were redacted (empty when the
 * input was clean). Never throws.
 *
 * Pass `feature` for telemetry — hits are logged as warnings so the
 * admin can monitor injection attempts without scanning raw bodies.
 */
export const sanitizeForPrompt = (
  input: string | null | undefined,
  feature: string,
  userId?: string,
): SanitizeResult => {
  const original = (input || '').toString();
  if (!original) return { text: '', hits: [], changed: false };

  let text = original;
  const hits: string[] = [];
  for (const pattern of PATTERNS) {
    const before = text;
    text = text.replace(pattern.regex, REDACTION);
    if (text !== before) hits.push(pattern.id);
  }

  if (hits.length > 0) {
    logger.warn(
      `[promptGuard] feature=${feature} userId=${userId ?? '-'} hits=${hits.join(',')}`,
    );
  }
  return { text, hits, changed: hits.length > 0 };
};

/**
 * Convenience wrapper — drops the metadata, just returns the cleaned
 * string. Use when the call site doesn't care whether anything was
 * redacted.
 */
export const cleanPromptText = (
  input: string | null | undefined,
  feature: string,
  userId?: string,
): string => sanitizeForPrompt(input, feature, userId).text;
