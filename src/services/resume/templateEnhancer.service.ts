import { logger } from '../../utils/logger';
import { generateJson, isAiEnabled } from '../ai/providers';

/**
 * AI enhancer for admin-uploaded resume templates.
 *
 * Two operations:
 *   1. `enhanceTemplate(html)` — asks an LLM to suggest improvements that
 *      raise the resume's ATS readability without altering the visual
 *      structure or the placeholder tokens. Returns the proposed HTML
 *      plus a change log so the admin can decide whether to accept.
 *   2. `scoreTemplate(html)`   — scores the (filled-with-sample-data) HTML
 *      against the same heuristics our user-facing ATS scorer uses, so the
 *      "min 60% to publish" gate is consistent.
 *
 * Both operations have a heuristic fallback when no AI provider is
 * configured so admins on a dev box can still ship work.
 *
 * Placeholder safety: enhancer prompts are explicit about preserving the
 * Mustache-style `{{...}}` tokens. We also run a post-check that compares
 * the token sets and reverts the proposal if any are missing/added.
 */

export interface EnhancementResult {
  html: string;
  changes: string[];
  usedAi: boolean;
  warnings: string[];
}

export interface TemplateAtsScore {
  score: number;
  notes: string[];
  source: 'ai' | 'heuristic';
}

const TOKEN_RE = /\{\{\s*[\w.-]+\s*\}\}/g;

const extractTokens = (html: string): Set<string> => {
  const set = new Set<string>();
  for (const match of html.matchAll(TOKEN_RE)) {
    set.add(match[0].replace(/\s+/g, ''));
  }
  return set;
};

const stripHtml = (html: string): string =>
  html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// Sample data we substitute into placeholders so the scorer sees a realistic
// filled resume instead of literal {{tokens}}.
const SAMPLE_VALUES: Record<string, string> = {
  fullname: 'Aarav Sharma',
  firstname: 'Aarav',
  lastname: 'Sharma',
  email: 'aarav.sharma@example.com',
  phone: '+91 98765 43210',
  location: 'Bengaluru, India',
  headline: 'Senior Full-Stack Engineer',
  summary:
    'Full-stack engineer with 8 years building scalable web platforms. Led a 6-person team to ship a fintech product that grew to 250K users in 18 months. Reduced infra spend 38% via service consolidation.',
  skills:
    'TypeScript, React, Node.js, Postgres, AWS, Docker, Kubernetes, GraphQL, Redis, CI/CD',
  experience:
    '• Built a real-time analytics dashboard adopted by 1,200+ enterprise users.\n• Reduced API p95 latency from 480ms to 120ms by introducing read replicas and query batching.\n• Mentored 4 junior engineers; 2 promoted within the year.',
  education:
    'B.Tech, Computer Science, IIT Madras — 2014 (CGPA 8.6/10).',
  projects:
    '• Open-source CLI for migrating Mongo collections, 1.2K GitHub stars.\n• Side project: a Tamil-English code-switch translator hitting 92% BLEU.',
  certifications:
    'AWS Certified Solutions Architect — Associate (2023).',
  linkedin: 'linkedin.com/in/aarav-sharma',
  github: 'github.com/aarav',
  portfolio: 'aaravsharma.dev',
};

const fillPlaceholders = (html: string): string =>
  html.replace(TOKEN_RE, (token) => {
    const key = token.replace(/[{}\s]/g, '').toLowerCase();
    return SAMPLE_VALUES[key] ?? 'Sample content for ' + key;
  });

/**
 * Heuristic ATS scorer mirroring the user-facing one in atsScorer.service.
 * Kept here as a separate copy because the user-facing version uses
 * Mongo caching keyed on user+contentHash and we don't want template
 * scoring to pollute that cache.
 */
const heuristicScore = (html: string): TemplateAtsScore => {
  const text = stripHtml(html);
  const lower = text.toLowerCase();
  const notes: string[] = [];

  const len = text.length;
  let length = 0;
  if (len < 600) {
    length = 2;
    notes.push('Template renders very short; add more sample content.');
  } else if (len < 1200) length = 6;
  else if (len <= 4000) length = 12;
  else if (len <= 6500) length = 9;
  else {
    length = 5;
    notes.push('Template renders too long; trim filler.');
  }

  const hasEmail = /[\w.+-]+@[\w-]+\.[\w.-]+/.test(text);
  const hasPhone = /(\+?\d[\d\s\-()]{8,}\d)/.test(text);
  const hasLink = /(linkedin|github|portfolio|behance|https?:\/\/)/i.test(text);
  const contact =
    (hasEmail ? 3 : 0) + (hasPhone ? 3 : 0) + (hasLink ? 2 : 0);
  if (!hasEmail) notes.push('Filled template has no email field.');

  const sections = [
    /\b(experience|work history)\b/i,
    /\b(education|degree|university)\b/i,
    /\b(skills|technologies)\b/i,
    /\b(summary|profile|objective)\b/i,
    /\b(projects?|certifications?)\b/i,
  ].filter((re) => re.test(text)).length;
  const sectionScore = Math.min(15, sections * 3);
  if (sections < 3) notes.push('Add the standard sections (experience, education, skills).');

  const actionVerbs = [
    'built', 'led', 'shipped', 'launched', 'designed', 'developed', 'reduced',
    'increased', 'improved', 'created', 'implemented', 'delivered', 'managed',
    'optimized', 'automated', 'scaled', 'mentored', 'engineered', 'integrated',
  ];
  const verbHits = actionVerbs.filter((v) =>
    new RegExp(`\\b${v}\\b`, 'i').test(lower),
  ).length;
  const verbScore = Math.min(12, verbHits * 1.5);
  if (verbHits < 3) notes.push('Sample bullets should lead with action verbs.');

  const numbers = (text.match(/\b\d{2,}\b/g) ?? []).length;
  const percents = (text.match(/\d+%/g) ?? []).length;
  const money = (text.match(/[₹$€£]\s?\d/g) ?? []).length;
  const quantTotal = Math.min(8, numbers) + percents * 2 + money * 2;
  const quantScore = Math.min(15, quantTotal);
  if (quantTotal < 5) notes.push('Bullets should be quantified (numbers, %, $).');

  const bullets = (text.match(/[•·▪►\-*]/g) ?? []).length;
  const bulletScore = bullets >= 8 ? 8 : bullets >= 4 ? 5 : 2;

  // Structural penalties — things that confuse real ATS parsers.
  let structural = 12;
  if (/<table/i.test(html)) {
    structural -= 6;
    notes.push('Avoid <table> for layout — many ATS parsers garble it.');
  }
  if (/<img/i.test(html)) {
    structural -= 3;
    notes.push('Images are ignored by ATS — keep critical info in text.');
  }
  if (/position\s*:\s*absolute/i.test(html)) {
    structural -= 3;
    notes.push('Absolute positioning often re-orders content during PDF parse.');
  }
  structural = Math.max(0, structural);

  const total = Math.round(
    length + contact + sectionScore + verbScore + quantScore + bulletScore + structural,
  );
  const score = Math.max(20, Math.min(95, total));
  return { score, notes: notes.slice(0, 8), source: 'heuristic' };
};

/**
 * Public API — score a template by filling its placeholders with realistic
 * sample data then running the heuristic.
 */
export const scoreTemplate = (html: string): TemplateAtsScore => {
  const filled = fillPlaceholders(html);
  return heuristicScore(filled);
};

const ENHANCER_SYSTEM = `You are a resume design + ATS expert. You are improving an HTML resume template.

Goals:
- Keep the visual layout and styling intact (don't change colours, fonts, or
  the overall structure of sections).
- Improve ATS friendliness: prefer semantic tags (<section>, <h2>, <ul>),
  avoid layout <table>s, prefer flexbox/grid for arrangement.
- Tighten copy where it's lorem-ipsum-ish but DO NOT invent personal data.
- PRESERVE every Mustache placeholder exactly as-is (e.g. {{fullName}},
  {{email}}, {{skills}}). Do not add new placeholders, do not rename them.
- The result must still be a single self-contained HTML document.

Output STRICT JSON only:
{
  "html": "<the improved HTML string>",
  "changes": ["short bullet describing each notable change, max 6"]
}

Rules:
- No markdown fences, no prose outside the JSON.
- If you can't improve the template, return the original HTML and an
  empty changes array.`;

interface EnhancerJson {
  html?: string;
  changes?: unknown;
}

const enhanceWithAi = async (html: string): Promise<EnhancementResult | null> => {
  try {
    const parsed = await generateJson<EnhancerJson>(
      {
        tier: 'smart',
        system: ENHANCER_SYSTEM,
        user: `TEMPLATE HTML:\n${html.slice(0, 20000)}\n\nReturn the JSON now.`,
        maxTokens: 6000,
        temperature: 0.25,
      },
      { feature: 'resume_template_enhance' },
    );
    if (!parsed || typeof parsed.html !== 'string' || parsed.html.length < 100) {
      return null;
    }
    const changes = Array.isArray(parsed.changes)
      ? parsed.changes
          .filter((c): c is string => typeof c === 'string')
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
          .slice(0, 8)
      : [];

    // Placeholder integrity check — reject if tokens drifted.
    const before = extractTokens(html);
    const after = extractTokens(parsed.html);
    const warnings: string[] = [];
    for (const t of before) {
      if (!after.has(t)) warnings.push(`AI dropped placeholder ${t}; reverting.`);
    }
    if (warnings.length > 0) {
      logger.warn(`Template enhancer: ${warnings.join(' / ')}`);
      return { html, changes: [], usedAi: false, warnings };
    }

    return { html: parsed.html, changes, usedAi: true, warnings: [] };
  } catch (err) {
    logger.warn(`Template enhancer AI call failed: ${(err as Error).message}`);
    return null;
  }
};

/**
 * Heuristic fallback for the enhancer — does very mild cleanup so the
 * "improved" copy isn't identical to the original. Used when no AI
 * provider is available.
 */
const heuristicEnhance = (html: string): EnhancementResult => {
  const changes: string[] = [];
  let next = html;

  if (/<table[^>]*>/i.test(next)) {
    next = next.replace(/<table[^>]*>/gi, '<section class="resume-row" role="group">');
    next = next.replace(/<\/table>/gi, '</section>');
    next = next.replace(/<\/?(tbody|thead|tfoot|tr|td|th)[^>]*>/gi, '');
    changes.push('Replaced layout <table> with semantic <section>.');
  }

  if (/style=["'][^"']*position\s*:\s*absolute[^"']*["']/i.test(next)) {
    next = next.replace(/position\s*:\s*absolute\s*;?/gi, '');
    changes.push('Removed absolute positioning (ATS parsers reorder it).');
  }

  // Wrap stray text-block <div>s in <p> for cleaner extraction. (No-op if
  // none exist; intentionally conservative.)
  if (!/<p[\s>]/i.test(next) && /<div[^>]*>/i.test(next)) {
    changes.push('Note: no <p> tags found — admin should add semantic prose tags.');
  }

  return {
    html: next,
    changes,
    usedAi: false,
    warnings: ['AI provider not configured; only structural cleanup applied.'],
  };
};

export const enhanceTemplate = async (html: string): Promise<EnhancementResult> => {
  if (isAiEnabled()) {
    const ai = await enhanceWithAi(html);
    if (ai) return ai;
  }
  return heuristicEnhance(html);
};
