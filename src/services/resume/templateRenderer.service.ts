import puppeteer, { Browser } from 'puppeteer';
import { logger } from '../../utils/logger';
import { PUPPETEER_HEADLESS } from '../../config/constants';
import { IUser } from '../../models/User';

/**
 * Renderer for the admin-uploaded resume templates.
 *
 * Two outputs:
 *   - `renderTemplatePdf(html, user)`    → PDF buffer (user fills slots)
 *   - `renderTemplateThumbnail(html)`     → PNG buffer (~600px wide,
 *      used as the listing card preview)
 *
 * Why a separate browser instance from `resumePdf.service.ts`: the
 * branded-resume browser is hot-pathed by user PDF downloads; running
 * admin enhancements + thumbnail renders against the same browser
 * occasionally tipped it past memory caps on the dev box. Separate
 * lifecycle is cheap and isolates failure modes.
 */

let browser: Browser | null = null;
const getBrowser = async (): Promise<Browser> => {
  if (browser && browser.connected) return browser;
  browser = await puppeteer.launch({
    headless: PUPPETEER_HEADLESS,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
    ],
  });
  return browser;
};

export const closeTemplateRendererBrowser = async (): Promise<void> => {
  if (browser) {
    try {
      await browser.close();
    } catch (err) {
      logger.warn(`templateRenderer close failed: ${(err as Error).message}`);
    }
    browser = null;
  }
};

const escHtml = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const TOKEN_RE = /\{\{\s*([\w.-]+)\s*\}\}/g;

/// Sample values used when rendering a preview PDF without the seeker's
/// real profile attached (e.g. the "Download Sample" path on the
/// template preview screen). Keep in sync with `SAMPLE_VALUES` in
/// `templateEnhancer.service.ts` — admin previews on the upload screen
/// should look the same as the seeker-facing sample.
const SAMPLE_SLOTS: Record<string, string> = {
  fullname: 'Aarav Sharma',
  firstname: 'Aarav',
  lastname: 'Sharma',
  email: 'aarav.sharma@example.com',
  phone: '+91 98765 43210',
  location: 'Bengaluru, India',
  headline: 'Senior Full-Stack Engineer',
  profession: 'Senior Full-Stack Engineer',
  company: 'Acme Corp',
  summary:
    'Full-stack engineer with 8 years building scalable web platforms. Led a 6-person team to ship a fintech product that grew to 250K users in 18 months. Reduced infra spend 38% via service consolidation.',
  skills:
    'TypeScript, React, Node.js, Postgres, AWS, Docker, Kubernetes, GraphQL, Redis, CI/CD',
  experience:
    '<div><strong>Senior Software Engineer</strong> · Acme Corp<br><em>Jan 2022 – Present (current)</em></div><br>' +
    '<div><strong>Software Engineer</strong> · Initech<br><em>Jul 2018 – Dec 2021</em></div>',
  education:
    '<div><strong>B.Tech, Computer Science</strong>, IIT Madras (2014 – 2018)</div>',
  projects:
    '<div><strong>Mongo Migrator CLI</strong> — Open-source tool with 1.2K GitHub stars.</div><br>' +
    '<div><strong>Code-switch Translator</strong> — Tamil-English BLEU 92%.</div>',
  certifications: 'AWS Certified Solutions Architect — Associate (2023)',
  linkedin: 'linkedin.com/in/aarav-sharma',
  github: 'github.com/aarav',
  portfolio: 'aaravsharma.dev',
};

/// Fills `{{placeholders}}` with stable sample data. Used for the
/// public-facing "preview" PDF so the seeker can see what a finished
/// resume looks like *before* committing their own data.
export const fillWithSample = (html: string): string =>
  html.replace(TOKEN_RE, (_match, raw: string) => {
    const key = String(raw).toLowerCase();
    return SAMPLE_SLOTS[key] ?? '';
  });

/**
 * Substitutes `{{placeholders}}` (Mustache-style) with the user's
 * profile values. Case-insensitive: `{{FullName}}` and `{{fullName}}`
 * resolve to the same slot. Missing slots collapse to an empty string —
 * we never leave a stray `{{token}}` in the rendered output.
 *
 * **Fallback chain** — the structured `resumeProfile` subdoc is the
 * preferred source for the long-form sections (experience / education
 * / projects), but a freshly-onboarded user typically hasn't filled
 * those yet. To avoid rendering a near-empty PDF, every long-form slot
 * falls back to whatever signal we have:
 *
 *   summary       ← resumeProfile.profileSummary | resumeText | headline
 *   experience    ← resumeProfile.employments    | "{N} years…" copy
 *   education     ← resumeProfile.educations     | (empty)
 *   skills        ← profile.skills + resumeProfile.itSkills (merged)
 *   projects      ← resumeProfile.projects       | (empty)
 *   certifications ← resumeProfile.accomplishments
 */
/// Optional slot overrides — used by the AI-enhanced fill path to
/// replace the long-form sections (summary / experience / etc.) with
/// LLM-polished copy while still letting the deterministic name/email/
/// phone/skills slots flow from the user document. Any override key
/// missing or blank falls back to the deterministic value.
export interface SlotOverrides {
  summary?: string;
  experience?: string;
  education?: string;
  projects?: string;
  certifications?: string;
  skills?: string;
}

export const fillPlaceholders = (
  html: string,
  user: IUser,
  overrides: SlotOverrides = {},
): string => {
  const p = user.profile ?? ({} as IUser['profile']);
  const rp = p.resumeProfile;

  // Merge `profile.skills` (chosen during onboarding) with the deeper
  // `resumeProfile.itSkills` so the resume reflects everything the
  // seeker has told us, in either screen.
  const skillSet = new Set<string>();
  for (const s of Array.isArray(p.skills) ? p.skills : []) {
    if (s) skillSet.add(s);
  }
  for (const s of rp?.itSkills ?? []) {
    if (s?.skill) skillSet.add(s.skill);
  }
  const skills = [...skillSet].join(', ');

  const summary =
    rp?.profileSummary?.trim() ||
    p.resumeText?.trim() ||
    p.headline?.trim() ||
    '';

  const fmtEmployment = (
    e: { designation: string; company: string; period: string; current: boolean },
  ): string =>
    `<div><strong>${escHtml(e.designation)}</strong> · ${escHtml(e.company)}<br>` +
    `<em>${escHtml(e.period)}${e.current ? ' (current)' : ''}</em></div>`;

  let employments: string;
  if (rp?.employments && rp.employments.length > 0) {
    employments = rp.employments.map(fmtEmployment).join('<br>');
  } else if (p.experienceYears && p.experienceYears > 0) {
    // Last-ditch: render a one-line stub so the section isn't blank for
    // a seeker who's filled the basics but not the long-form profile.
    employments = `<div><em>${escHtml(
      `${p.experienceYears}+ years of professional experience.`,
    )}</em></div>`;
  } else {
    employments = '';
  }

  const educations = (rp?.educations ?? [])
    .map(
      (e) =>
        `<div><strong>${escHtml(e.degree)}</strong>, ${escHtml(e.institute)} (${escHtml(e.period)})</div>`,
    )
    .join('<br>');

  const projects = (rp?.projects ?? [])
    .map(
      (e) =>
        `<div><strong>${escHtml(e.title)}</strong> — ${escHtml(e.description)}</div>`,
    )
    .join('<br>');

  const certifications = (rp?.accomplishments ?? [])
    .map((a) => escHtml([a.label, a.value].filter(Boolean).join(' — ')))
    .filter(Boolean)
    .join('; ');

  const fullName = p.fullName || 'Candidate';
  const parts = fullName.split(/\s+/);

  const headlineOrFallback =
    p.headline?.trim() ||
    rp?.careerProfile?.jobRole?.trim() ||
    rp?.careerProfile?.roleCategory?.trim() ||
    '';

  const location =
    Array.isArray(p.preferredLocations) && p.preferredLocations.length > 0
      ? p.preferredLocations[0]
      : rp?.careerProfile?.preferredLocation || '';

  // Pick override when it's a non-empty string, else the deterministic
  // value. Treating "  " as empty so a careless LLM space doesn't blank
  // out a section.
  const pick = (override: string | undefined, fallback: string): string =>
    override && override.trim().length > 0 ? override : fallback;

  const slots: Record<string, string> = {
    fullname: fullName,
    firstname: parts[0] ?? '',
    lastname: parts.slice(1).join(' '),
    email: user.email || '',
    phone: p.phone || '',
    headline: headlineOrFallback,
    profession: headlineOrFallback,
    company: '',
    location,
    skills: pick(overrides.skills, skills),
    summary: pick(overrides.summary, summary),
    experience: pick(overrides.experience, employments),
    education: pick(overrides.education, educations),
    projects: pick(overrides.projects, projects),
    certifications: pick(overrides.certifications, certifications),
    linkedin: '',
    github: '',
    portfolio: '',
  };

  return html.replace(TOKEN_RE, (_match, raw: string) => {
    const key = raw.toLowerCase();
    return slots[key] ?? '';
  });
};

/**
 * Renders the (already-placeholder-filled) HTML to a PDF buffer using
 * a print-friendly viewport.
 */
export const renderTemplatePdf = async (
  filledHtml: string,
): Promise<Buffer> => {
  const b = await getBrowser();
  const page = await b.newPage();
  try {
    await page.setContent(filledHtml, { waitUntil: 'networkidle0' });
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: '0mm', bottom: '0mm', left: '0mm', right: '0mm' },
    });
    return Buffer.from(pdf);
  } finally {
    try {
      await page.close();
    } catch {
      /* page may already be closed */
    }
  }
};

/**
 * Renders an HTML template to a fixed-size PNG screenshot. Used as the
 * card thumbnail for the user-facing template picker, so it intentionally
 * uses sample-y placeholder values rather than per-user data: it gives a
 * stable preview, and the admin only has to publish once for everyone to
 * see the right image.
 */
export const renderTemplateThumbnail = async (
  html: string,
): Promise<Buffer> => {
  const b = await getBrowser();
  const page = await b.newPage();
  try {
    await page.setViewport({ width: 600, height: 840, deviceScaleFactor: 1.5 });
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const png = await page.screenshot({
      type: 'png',
      fullPage: false,
      omitBackground: false,
    });
    return Buffer.from(png);
  } finally {
    try {
      await page.close();
    } catch {
      /* page may already be closed */
    }
  }
};
