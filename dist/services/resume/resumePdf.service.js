"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateBrandedResumePdf = exports.closeResumePdfBrowser = void 0;
const puppeteer_1 = __importDefault(require("puppeteer"));
const logger_1 = require("../../utils/logger");
const constants_1 = require("../../config/constants");
let browser = null;
const getBrowser = async () => {
    if (browser && browser.connected)
        return browser;
    browser = await puppeteer_1.default.launch({
        headless: constants_1.PUPPETEER_HEADLESS,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
        ],
    });
    return browser;
};
const closeResumePdfBrowser = async () => {
    if (browser) {
        try {
            await browser.close();
        }
        catch (err) {
            logger_1.logger.warn(`resumePdf browser close failed: ${err.message}`);
        }
        browser = null;
    }
};
exports.closeResumePdfBrowser = closeResumePdfBrowser;
const esc = (s) => {
    if (!s)
        return '';
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
};
const renderHtml = (user) => {
    const p = user.profile;
    const rp = p.resumeProfile ?? {};
    const fullName = p.fullName || 'Candidate';
    const headline = p.headline || '';
    const summary = rp.profileSummary || '';
    const skills = (p.skills || []).slice(0, 40);
    const employments = (rp.employments || []).slice(0, 12);
    const educations = (rp.educations || []).slice(0, 8);
    const projects = (rp.projects || []).slice(0, 8);
    const languages = (rp.languages || []).slice(0, 8);
    const accomplishments = (rp.accomplishments || []).slice(0, 10);
    const careerProfile = rp.careerProfile ?? null;
    const skillsRow = skills
        .map((s) => `<span class="chip">${esc(s)}</span>`)
        .join('');
    const employmentsHtml = employments
        .map((e) => `
        <div class="entry">
          <div class="entry-head">
            <div class="entry-title">${esc(e.designation)}</div>
            <div class="entry-period">${esc(e.period)}${e.current ? ' · Current' : ''}</div>
          </div>
          <div class="entry-sub">${esc(e.company)}</div>
        </div>`)
        .join('');
    const educationsHtml = educations
        .map((e) => `
        <div class="entry">
          <div class="entry-head">
            <div class="entry-title">${esc(e.degree)}</div>
            <div class="entry-period">${esc(e.period)}</div>
          </div>
          <div class="entry-sub">${esc(e.institute)} · ${esc(e.type)}</div>
          ${e.projects && e.projects.length > 0
        ? `<ul>${e.projects
            .map((pr) => `<li>${esc(pr)}</li>`)
            .join('')}</ul>`
        : ''}
        </div>`)
        .join('');
    const projectsHtml = projects
        .map((pr) => `
        <div class="entry">
          <div class="entry-head">
            <div class="entry-title">${esc(pr.title)}</div>
            <div class="entry-period">${esc(pr.period)}</div>
          </div>
          <div class="entry-sub">${esc(pr.company)} · ${esc(pr.type)}</div>
          ${pr.description ? `<div class="entry-body">${esc(pr.description)}</div>` : ''}
        </div>`)
        .join('');
    const languagesHtml = languages
        .map((l) => `<span class="chip">${esc(l.language)}${l.proficiency ? ` · ${esc(l.proficiency)}` : ''}</span>`)
        .join('');
    const accomplishmentsHtml = accomplishments
        .map((a) => `
        <li>
          <b>${esc(a.label || a.type)}</b>${a.value ? ` — ${esc(a.value)}` : ''}
        </li>`)
        .join('');
    const careerHtml = careerProfile
        ? `
      <section>
        <h2>Career profile</h2>
        <div class="grid">
          ${careerProfile.currentIndustry ? `<div><span class="k">Industry</span><span class="v">${esc(careerProfile.currentIndustry)}</span></div>` : ''}
          ${careerProfile.department ? `<div><span class="k">Department</span><span class="v">${esc(careerProfile.department)}</span></div>` : ''}
          ${careerProfile.jobRole ? `<div><span class="k">Role</span><span class="v">${esc(careerProfile.jobRole)}</span></div>` : ''}
          ${careerProfile.desiredJobType ? `<div><span class="k">Job type</span><span class="v">${esc(careerProfile.desiredJobType)}</span></div>` : ''}
          ${careerProfile.preferredLocation ? `<div><span class="k">Location</span><span class="v">${esc(careerProfile.preferredLocation)}</span></div>` : ''}
          ${careerProfile.expectedSalary ? `<div><span class="k">Expected</span><span class="v">${esc(careerProfile.expectedSalary)}</span></div>` : ''}
        </div>
      </section>`
        : '';
    return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8" />
<title>Resume — ${esc(fullName)}</title>
<style>
  @page { size: A4; margin: 18mm 16mm; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Arial, sans-serif; color: #0b1320; font-size: 11.5pt; line-height: 1.45; }
  header { border-bottom: 2px solid #2D7BFF; padding-bottom: 10px; margin-bottom: 14px; display: flex; justify-content: space-between; align-items: flex-end; }
  header .name { font-size: 22pt; font-weight: 800; letter-spacing: -0.01em; }
  header .headline { color: #4a5364; font-size: 12pt; font-weight: 500; margin-top: 2px; }
  header .contact { font-size: 9.5pt; color: #4a5364; text-align: right; }
  header .contact div { margin-top: 2px; }
  section { margin-top: 14px; }
  section h2 { font-size: 11pt; text-transform: uppercase; letter-spacing: 0.07em; color: #2D7BFF; border-bottom: 1px solid #e1e6ef; padding-bottom: 4px; margin: 0 0 8px 0; font-weight: 800; }
  .summary { color: #20283a; }
  .chip { display: inline-block; background: #eef4ff; color: #0c3aa6; border-radius: 6px; padding: 3px 8px; font-size: 9.5pt; font-weight: 600; margin: 2px 4px 2px 0; }
  .entry { margin-bottom: 10px; }
  .entry-head { display: flex; justify-content: space-between; gap: 10px; align-items: baseline; }
  .entry-title { font-weight: 700; font-size: 11pt; }
  .entry-period { font-size: 9.5pt; color: #6b7280; white-space: nowrap; }
  .entry-sub { color: #374151; font-size: 10pt; margin-top: 2px; }
  .entry-body { margin-top: 4px; color: #1f2937; font-size: 10pt; }
  ul { margin: 4px 0 0 18px; padding: 0; }
  ul li { margin-bottom: 2px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 16px; }
  .grid .k { display: inline-block; min-width: 92px; color: #6b7280; font-size: 9.5pt; }
  .grid .v { color: #0b1320; font-weight: 600; font-size: 10pt; }
  footer { margin-top: 18px; padding-top: 8px; border-top: 1px dashed #cdd5e2; color: #94a3b8; font-size: 8.5pt; display: flex; justify-content: space-between; }
</style></head>
<body>
  <header>
    <div>
      <div class="name">${esc(fullName)}</div>
      <div class="headline">${esc(headline)}</div>
    </div>
    <div class="contact">
      ${user.email ? `<div>${esc(user.email)}</div>` : ''}
      ${p.phone ? `<div>${esc(p.phone)}</div>` : ''}
      ${p.preferredLocations && p.preferredLocations.length > 0
        ? `<div>${esc(p.preferredLocations.slice(0, 2).join(' · '))}</div>`
        : ''}
      ${p.experienceYears ? `<div>${p.experienceYears} years experience</div>` : ''}
    </div>
  </header>

  ${summary ? `<section><h2>Summary</h2><div class="summary">${esc(summary)}</div></section>` : ''}
  ${skillsRow ? `<section><h2>Skills</h2><div>${skillsRow}</div></section>` : ''}
  ${employmentsHtml ? `<section><h2>Experience</h2>${employmentsHtml}</section>` : ''}
  ${projectsHtml ? `<section><h2>Projects</h2>${projectsHtml}</section>` : ''}
  ${educationsHtml ? `<section><h2>Education</h2>${educationsHtml}</section>` : ''}
  ${accomplishmentsHtml ? `<section><h2>Accomplishments</h2><ul>${accomplishmentsHtml}</ul></section>` : ''}
  ${languagesHtml ? `<section><h2>Languages</h2><div>${languagesHtml}</div></section>` : ''}
  ${careerHtml}

  <footer>
    <span>Generated by Job Hunter</span>
    <span>${new Date().toISOString().slice(0, 10)}</span>
  </footer>
</body></html>`;
};
const generateBrandedResumePdf = async (user) => {
    const html = renderHtml(user);
    const b = await getBrowser();
    const page = await b.newPage();
    try {
        await page.setContent(html, { waitUntil: 'networkidle0' });
        const pdf = await page.pdf({
            format: 'A4',
            printBackground: true,
            preferCSSPageSize: true,
            margin: { top: '0mm', bottom: '0mm', left: '0mm', right: '0mm' },
        });
        const slug = (user.profile.fullName || 'resume')
            .replace(/[^a-zA-Z0-9]+/g, '_')
            .replace(/^_+|_+$/g, '')
            .toLowerCase()
            .slice(0, 60);
        return {
            buffer: Buffer.from(pdf),
            filename: `${slug || 'resume'}_jobhunter.pdf`,
        };
    }
    finally {
        try {
            await page.close();
        }
        catch {
        }
    }
};
exports.generateBrandedResumePdf = generateBrandedResumePdf;
