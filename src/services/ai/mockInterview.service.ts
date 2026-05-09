import Anthropic from '@anthropic-ai/sdk';
import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import {
  ICandidateProfileSnapshot,
  IMockInterviewTurn,
  MockInterviewType,
} from '../../models/MockInterview';

const client = env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })
  : null;

const MODEL = 'claude-haiku-4-5-20251001';

const SYSTEM_BY_TYPE: Record<MockInterviewType, string> = {
  hr: 'You are conducting an HR / fit interview. Focus on motivation, communication, teamwork, and resilience. Avoid coding questions.',
  behavioural:
    'You are conducting a behavioural interview using the STAR framework. Probe for specific past situations, never accept generic answers.',
  technical:
    'You are conducting a technical interview. Ask realistic role-relevant problems. Probe for trade-offs and edge cases. Never give the answer prematurely.',
  system_design:
    'You are conducting a senior system-design interview. Ask one open-ended design question, then drill down into scaling, storage, consistency trade-offs.',
};

interface NextQuestionResult {
  question: string;
  feedback?: IMockInterviewTurn['feedback'];
  shouldFinish: boolean;
  /// True when the candidate's last answer didn't address the question
  /// at all (off-topic, gibberish, "I don't know" with zero substance).
  /// The controller uses this to NOT advance the question counter and
  /// re-ask the same question rather than wasting a slot.
  answerWasIrrelevant?: boolean;
}

/// Render the candidate profile snapshot into a compact prompt block.
/// Skips empty fields so the model isn't tempted to invent details. The
/// resume excerpt is hard-capped to keep token use predictable.
const renderCandidateProfile = (p?: ICandidateProfileSnapshot): string => {
  if (!p) return '';
  const lines: string[] = [];
  if (p.fullName) lines.push(`Name: ${p.fullName}`);
  if (p.headline) lines.push(`Headline: ${p.headline}`);
  if (typeof p.experienceYears === 'number') {
    lines.push(`Experience: ${p.experienceYears} years`);
  }
  if (p.skills && p.skills.length) {
    lines.push(`Skills: ${p.skills.slice(0, 25).join(', ')}`);
  }
  if (p.preferredRoles && p.preferredRoles.length) {
    lines.push(`Target roles: ${p.preferredRoles.slice(0, 5).join(', ')}`);
  }
  if (p.resumeExcerpt) {
    lines.push(`Resume excerpt:\n${p.resumeExcerpt.slice(0, 1500)}`);
  }
  if (lines.length === 0) return '';
  return `\nCandidate profile (use this to ground every question — don't ask things the candidate hasn't claimed any familiarity with, and DO probe specifics from their stated skills/experience):\n${lines.join('\n')}\n`;
};

/**
 * Decide what the interviewer says next. Given the conversation so far,
 * returns the next interviewer question + (when the last turn was a
 * candidate answer) per-answer feedback. Sets `shouldFinish=true` when
 * the model decides to wrap.
 *
 * Falls back to a small canned bank if no LLM key is configured.
 */
export const nextInterviewerTurn = async (params: {
  role: string;
  interviewType: MockInterviewType;
  turns: IMockInterviewTurn[];
  questionsTarget: number;
  candidateProfile?: ICandidateProfileSnapshot;
}): Promise<NextQuestionResult> => {
  const { role, interviewType, turns, questionsTarget, candidateProfile } =
    params;
  const questionsAsked = turns.filter((t) => t.role === 'interviewer').length;

  if (!client) {
    return fallbackTurn(role, interviewType, questionsAsked, questionsTarget);
  }

  const transcript = turns
    .map((t) => `${t.role === 'interviewer' ? 'Q' : 'A'}: ${t.text}`)
    .join('\n');

  const system = `${SYSTEM_BY_TYPE[interviewType]}

You are interviewing for: ${role}.
${renderCandidateProfile(candidateProfile)}
Output strict JSON:
{
  "question": "Your next interview question (one paragraph, no numbering).",
  "feedback": {                             // OMIT when no candidate answer to score yet
    "relevance": 0-100,
    "depth": 0-100,
    "communication": 0-100,
    "suggestion": "1-sentence improvement tip"
  },
  "shouldFinish": false,
  "answerWasIrrelevant": false              // TRUE when the candidate's answer was completely off-topic, gibberish, or zero-substance — see rule below
}

Rules:
- ONLY JSON, no prose, no markdown fences.
- Cap to ${questionsTarget} questions total. Currently asked: ${questionsAsked}.
- If asked >= ${questionsTarget} OR the candidate is clearly cooked, set shouldFinish=true and ask a final wrap-up.
- Probe weak answers; don't repeat the same theme twice in a row.
- Don't include feedback on the very first turn (no answer yet).
- Never output multiple questions per turn.
- Set "answerWasIrrelevant": true when the answer is completely unrelated to the question (e.g. asked about React state management, candidate replied "what's the weather?"), gibberish, or just "idk/no" with zero attempt. When TRUE: also set "question" to a short polite re-ask of the SAME question (e.g. "Let's stay on the previous question — could you address it directly?"). A weak-but-relevant answer is NOT irrelevant; just give low feedback scores.`;

  const prompt = transcript.length === 0
    ? 'Open the interview now.'
    : `Conversation so far:\n${transcript}\n\nGive the next interviewer turn.`;

  try {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 800,
      system,
      messages: [{ role: 'user', content: prompt }],
    });
    const block = res.content[0];
    const raw =
      block && block.type === 'text' && typeof block.text === 'string'
        ? block.text.trim()
        : '';
    const parsed = JSON.parse(raw) as {
      question?: string;
      feedback?: {
        relevance?: number;
        depth?: number;
        communication?: number;
        suggestion?: string;
      };
      shouldFinish?: boolean;
      answerWasIrrelevant?: boolean;
    };
    const question = String(parsed.question ?? '').trim();
    if (!question) {
      return fallbackTurn(role, interviewType, questionsAsked, questionsTarget);
    }
    const irrelevant = !!parsed.answerWasIrrelevant;
    return {
      question,
      feedback:
        parsed.feedback && typeof parsed.feedback === 'object'
          ? {
              relevance: clamp(parsed.feedback.relevance),
              depth: clamp(parsed.feedback.depth),
              communication: clamp(parsed.feedback.communication),
              suggestion:
                typeof parsed.feedback.suggestion === 'string'
                  ? parsed.feedback.suggestion.slice(0, 1000)
                  : undefined,
            }
          : undefined,
      // An irrelevant answer never finishes the interview — we want
      // the candidate to actually attempt the question first.
      shouldFinish: irrelevant
        ? false
        : !!parsed.shouldFinish || questionsAsked + 1 >= questionsTarget,
      answerWasIrrelevant: irrelevant,
    };
  } catch (err) {
    logger.warn(`mockInterview LLM failed: ${(err as Error).message}`);
    return fallbackTurn(role, interviewType, questionsAsked, questionsTarget);
  }
};

const clamp = (n: unknown): number | undefined => {
  if (typeof n !== 'number') return undefined;
  return Math.max(0, Math.min(100, Math.round(n)));
};

const FALLBACK_BANK: Record<MockInterviewType, string[]> = {
  hr: [
    'Walk me through your career so far in three minutes.',
    'Why are you looking to leave your current role?',
    'Tell me about a time you disagreed with a manager. How did you handle it?',
    'What kind of work environment lets you do your best?',
    'Where do you see yourself in 2–3 years?',
    'What are 2 things you wish you\'d learned earlier in your career?',
  ],
  behavioural: [
    'Tell me about the project you\'re most proud of and why.',
    'Describe a time you missed a deadline. What did you do?',
    'Tell me about a piece of feedback that changed how you work.',
    'Describe the hardest decision you made on a team this year.',
    'Walk me through a time you had to influence without authority.',
    'When did you ship something you weren\'t fully ready to ship?',
  ],
  technical: [
    'Walk me through a technical decision you regret.',
    'How would you debug a production issue you\'ve never seen before?',
    'Explain a system you\'ve worked on, what scaled and what didn\'t.',
    'Give me an example of a trade-off you made between speed and correctness.',
    'How do you decide whether to write a test for a piece of code?',
    'Describe a refactor that paid off — and one that didn\'t.',
  ],
  system_design: [
    'Design a URL shortener that handles 10k writes/sec.',
    'How would you design a notification fanout for 1M users?',
    'Walk me through how you\'d build a "jobs near me" feed.',
    'Design rate limiting for a public API. What\'s your storage choice?',
    'How would you build search across 500M job listings with filters?',
    'Design a system that auto-applies to jobs on behalf of users.',
  ],
};

const fallbackTurn = (
  _role: string,
  type: MockInterviewType,
  questionsAsked: number,
  target: number,
): NextQuestionResult => {
  const bank = FALLBACK_BANK[type];
  const idx = questionsAsked % bank.length;
  return {
    question: bank[idx],
    shouldFinish: questionsAsked + 1 >= target,
  };
};

interface FinalSummaryResult {
  finalScore: number;
  finalSummary: string;
}

export const summariseInterview = async (params: {
  role: string;
  interviewType: MockInterviewType;
  turns: IMockInterviewTurn[];
  candidateProfile?: ICandidateProfileSnapshot;
}): Promise<FinalSummaryResult> => {
  const { role, interviewType, turns, candidateProfile } = params;

  // Heuristic from per-answer scores when LLM is unavailable.
  const heuristic = (): FinalSummaryResult => {
    const scored = turns.filter((t) => t.feedback);
    if (scored.length === 0) {
      return {
        finalScore: 0,
        finalSummary:
          'Practice complete. Submit answers next time so we can give you per-answer feedback.',
      };
    }
    const avg = (key: 'relevance' | 'depth' | 'communication') => {
      const xs = scored.map((t) => t.feedback?.[key]).filter((n): n is number => typeof n === 'number');
      if (xs.length === 0) return 0;
      return Math.round(xs.reduce((s, n) => s + n, 0) / xs.length);
    };
    const r = avg('relevance');
    const d = avg('depth');
    const c = avg('communication');
    return {
      finalScore: Math.round((r + d + c) / 3),
      finalSummary:
        `Relevance ${r}, depth ${d}, communication ${c}. ` +
        'Focus next round on the dimension with the lowest score.',
    };
  };

  if (!client) return heuristic();

  const transcript = turns
    .map((t) => `${t.role === 'interviewer' ? 'Q' : 'A'}: ${t.text}`)
    .join('\n');

  const system = `Score this mock ${interviewType} interview for a ${role} candidate.
${renderCandidateProfile(candidateProfile)}
When scoring, weigh answers against the candidate's stated experience level — penalise vague answers more harshly for senior candidates than juniors.

Output strict JSON:
{"finalScore": 0-100, "finalSummary": "3-5 sentences. Lead with biggest strength, then biggest gap, then concrete next step. No fluff."}`;

  try {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 600,
      system,
      messages: [{ role: 'user', content: transcript }],
    });
    const block = res.content[0];
    const raw =
      block && block.type === 'text' && typeof block.text === 'string'
        ? block.text.trim()
        : '';
    const parsed = JSON.parse(raw) as {
      finalScore?: number;
      finalSummary?: string;
    };
    const score = typeof parsed.finalScore === 'number'
      ? Math.max(0, Math.min(100, Math.round(parsed.finalScore)))
      : 0;
    return {
      finalScore: score,
      finalSummary: String(parsed.finalSummary ?? '').slice(0, 4000),
    };
  } catch (err) {
    logger.warn(`mockInterview summary failed: ${(err as Error).message}`);
    return heuristic();
  }
};
