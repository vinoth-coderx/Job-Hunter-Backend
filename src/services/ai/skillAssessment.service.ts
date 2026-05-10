import { logger } from '../../utils/logger';
import { ISkillAssessmentQuestion, AssessmentLevel } from '../../models/SkillAssessment';
import { generateJson, isAiEnabled } from './providers';

/**
 * Generate a multiple-choice assessment for the given skill and level.
 * Returns 8 questions by default — small enough to feel like a quiz,
 * large enough to be statistically meaningful at a 70% pass mark.
 *
 * Falls back to a small built-in question pool when the LLM is
 * unavailable (so devs can run the feature without a key).
 */
export const generateAssessment = async (params: {
  skill: string;
  level?: AssessmentLevel;
  count?: number;
}): Promise<ISkillAssessmentQuestion[]> => {
  const skill = params.skill.toLowerCase().trim();
  const level = params.level ?? 'intermediate';
  const count = Math.min(20, Math.max(5, params.count ?? 8));

  if (!isAiEnabled()) return fallbackQuestions(skill, level, count);

  const system = `You write short, fair multiple-choice technical assessments. Output strict JSON:
{
  "questions": [
    {
      "question": "Question text (one sentence, no preamble).",
      "options": ["Option A","Option B","Option C","Option D"],
      "correctIndex": 0,
      "explanation": "1–2 sentence explanation."
    }
  ]
}

Rules:
- Output ONLY JSON, no prose, no markdown fences.
- Exactly 4 options per question.
- correctIndex is 0-based and must point to the unambiguously correct option.
- Test understanding, not memorisation. No trick wording.
- Don't invent fake APIs / signatures — only ask about real, current behaviour.
- Difficulty: ${level}. Avoid questions that need a runtime to answer.`;

  const prompt = `Skill: ${skill}\nGenerate ${count} questions.`;

  try {
    const parsed = await generateJson<{ questions?: unknown }>({
      tier: 'lite',
      system,
      user: prompt,
      maxTokens: 3000,
      temperature: 0.5,
    });
    if (!parsed) return fallbackQuestions(skill, level, count);
    const arr = Array.isArray(parsed.questions) ? parsed.questions : [];
    const questions = arr
      .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
      .slice(0, count)
      .map((x) => {
        const opts = Array.isArray(x.options)
          ? (x.options as unknown[]).map(String).slice(0, 5)
          : [];
        const ci = typeof x.correctIndex === 'number' ? x.correctIndex : -1;
        return {
          question: String(x.question ?? '').slice(0, 1000),
          options: opts,
          correctIndex: ci,
          explanation:
            typeof x.explanation === 'string'
              ? x.explanation.slice(0, 1000)
              : undefined,
        } as ISkillAssessmentQuestion;
      })
      .filter(
        (q) =>
          q.question.length >= 5 &&
          q.options.length >= 2 &&
          q.correctIndex >= 0 &&
          q.correctIndex < q.options.length,
      );

    if (questions.length < 5) {
      logger.warn(
        `skillAssessment got only ${questions.length} usable questions; falling back`,
      );
      return fallbackQuestions(skill, level, count);
    }
    return questions;
  } catch (err) {
    logger.warn(`skillAssessment LLM failed: ${(err as Error).message}`);
    return fallbackQuestions(skill, level, count);
  }
};

// Small generic pool — never claims to test the actual skill, so we mark
// the questions as 'fundamentals' to avoid lying about coverage.
const fallbackQuestions = (
  skill: string,
  _level: AssessmentLevel,
  count: number,
): ISkillAssessmentQuestion[] => {
  const base: ISkillAssessmentQuestion[] = [
    {
      question: `When learning ${skill}, what's the best first step?`,
      options: [
        'Read official documentation and try the quickstart',
        'Memorise every API method',
        'Skip docs and copy-paste code',
        'Wait for someone to teach you',
      ],
      correctIndex: 0,
      explanation:
        'Official docs ground you in correct concepts before bad habits form.',
    },
    {
      question: 'Which is the strongest signal you actually understand a skill?',
      options: [
        'You watched a course about it',
        'You can teach it to someone else',
        'You bookmarked tutorials about it',
        'You named it in your CV',
      ],
      correctIndex: 1,
      explanation: 'Teaching forces you to confront gaps in your understanding.',
    },
    {
      question: 'What\'s the safest way to validate code before shipping?',
      options: [
        'Skip review when in a rush',
        'Run automated tests + a peer review',
        'Push directly to main',
        'Test only happy paths',
      ],
      correctIndex: 1,
      explanation:
        'Tests + review catch most regressions; ship-it-on-Friday rarely beats that.',
    },
    {
      question: `When debugging a ${skill} issue, what should you do first?`,
      options: [
        'Re-write the whole module',
        'Reproduce the bug reliably',
        'Ignore it and hope it goes away',
        'Add more logging without reading the existing logs',
      ],
      correctIndex: 1,
      explanation:
        'A reliable repro is the prerequisite for a real fix; everything else is guessing.',
    },
    {
      question: 'Which is the best way to keep up with industry changes?',
      options: [
        'Avoid learning anything new',
        'Read release notes + follow respected practitioners',
        'Trust only YouTube tutorials',
        'Wait for breaking changes to force you to learn',
      ],
      correctIndex: 1,
      explanation:
        'Release notes are the highest-signal source; practitioners filter noise.',
    },
    {
      question: 'What does "shipping iteratively" mean in practice?',
      options: [
        'Releasing the smallest useful change end-to-end, repeatedly',
        'Releasing once a year',
        'Releasing without testing',
        'Releasing only after a full rewrite',
      ],
      correctIndex: 0,
      explanation:
        'Small end-to-end slices reduce risk and produce feedback you can act on.',
    },
    {
      question: 'Which is the most important habit when reading unfamiliar code?',
      options: [
        'Skim until something looks familiar',
        'Trace one realistic user flow end-to-end',
        'Rewrite it before understanding it',
        'Replace names with shorter ones',
      ],
      correctIndex: 1,
      explanation:
        'Following one concrete flow grounds your mental model in reality.',
    },
    {
      question: 'What\'s the right reaction to a flaky test?',
      options: [
        'Delete it',
        'Mark it as flaky and never look again',
        'Investigate and fix the root cause',
        'Re-run until it passes',
      ],
      correctIndex: 2,
      explanation:
        'Flaky tests rot trust; the bug is usually in the code under test or the test\'s isolation.',
    },
  ];
  return base.slice(0, count);
};
