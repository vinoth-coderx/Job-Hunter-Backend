"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.renderTemplateThumbnail = exports.renderTemplatePdf = exports.fillPlaceholders = exports.fillWithSample = exports.closeTemplateRendererBrowser = void 0;
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
const closeTemplateRendererBrowser = async () => {
    if (browser) {
        try {
            await browser.close();
        }
        catch (err) {
            logger_1.logger.warn(`templateRenderer close failed: ${err.message}`);
        }
        browser = null;
    }
};
exports.closeTemplateRendererBrowser = closeTemplateRendererBrowser;
const escHtml = (s) => s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
const TOKEN_RE = /\{\{\s*([\w.-]+)\s*\}\}/g;
const SAMPLE_SLOTS = {
    fullname: 'Aarav Sharma',
    firstname: 'Aarav',
    lastname: 'Sharma',
    email: 'aarav.sharma@example.com',
    phone: '+91 98765 43210',
    location: 'Bengaluru, India',
    headline: 'Senior Full-Stack Engineer',
    profession: 'Senior Full-Stack Engineer',
    company: 'Acme Corp',
    summary: 'Full-stack engineer with 8 years building scalable web platforms. Led a 6-person team to ship a fintech product that grew to 250K users in 18 months. Reduced infra spend 38% via service consolidation.',
    skills: 'TypeScript, React, Node.js, Postgres, AWS, Docker, Kubernetes, GraphQL, Redis, CI/CD',
    experience: '<div><strong>Senior Software Engineer</strong> · Acme Corp<br><em>Jan 2022 – Present (current)</em></div><br>' +
        '<div><strong>Software Engineer</strong> · Initech<br><em>Jul 2018 – Dec 2021</em></div>',
    education: '<div><strong>B.Tech, Computer Science</strong>, IIT Madras (2014 – 2018)</div>',
    projects: '<div><strong>Mongo Migrator CLI</strong> — Open-source tool with 1.2K GitHub stars.</div><br>' +
        '<div><strong>Code-switch Translator</strong> — Tamil-English BLEU 92%.</div>',
    certifications: 'AWS Certified Solutions Architect — Associate (2023)',
    linkedin: 'linkedin.com/in/aarav-sharma',
    github: 'github.com/aarav',
    portfolio: 'aaravsharma.dev',
};
const fillWithSample = (html) => html.replace(TOKEN_RE, (_match, raw) => {
    const key = String(raw).toLowerCase();
    return SAMPLE_SLOTS[key] ?? '';
});
exports.fillWithSample = fillWithSample;
const fillPlaceholders = (html, user, overrides = {}) => {
    const p = user.profile ?? {};
    const rp = p.resumeProfile;
    const skillSet = new Set();
    for (const s of Array.isArray(p.skills) ? p.skills : []) {
        if (s)
            skillSet.add(s);
    }
    for (const s of rp?.itSkills ?? []) {
        if (s?.skill)
            skillSet.add(s.skill);
    }
    const skills = [...skillSet].join(', ');
    const summary = rp?.profileSummary?.trim() ||
        p.resumeText?.trim() ||
        p.headline?.trim() ||
        '';
    const fmtEmployment = (e) => `<div><strong>${escHtml(e.designation)}</strong> · ${escHtml(e.company)}<br>` +
        `<em>${escHtml(e.period)}${e.current ? ' (current)' : ''}</em></div>`;
    let employments;
    if (rp?.employments && rp.employments.length > 0) {
        employments = rp.employments.map(fmtEmployment).join('<br>');
    }
    else if (p.experienceYears && p.experienceYears > 0) {
        employments = `<div><em>${escHtml(`${p.experienceYears}+ years of professional experience.`)}</em></div>`;
    }
    else {
        employments = '';
    }
    const educations = (rp?.educations ?? [])
        .map((e) => `<div><strong>${escHtml(e.degree)}</strong>, ${escHtml(e.institute)} (${escHtml(e.period)})</div>`)
        .join('<br>');
    const projects = (rp?.projects ?? [])
        .map((e) => `<div><strong>${escHtml(e.title)}</strong> — ${escHtml(e.description)}</div>`)
        .join('<br>');
    const certifications = (rp?.accomplishments ?? [])
        .map((a) => escHtml([a.label, a.value].filter(Boolean).join(' — ')))
        .filter(Boolean)
        .join('; ');
    const fullName = p.fullName || 'Candidate';
    const parts = fullName.split(/\s+/);
    const headlineOrFallback = p.headline?.trim() ||
        rp?.careerProfile?.jobRole?.trim() ||
        rp?.careerProfile?.roleCategory?.trim() ||
        '';
    const location = Array.isArray(p.preferredLocations) && p.preferredLocations.length > 0
        ? p.preferredLocations[0]
        : rp?.careerProfile?.preferredLocation || '';
    const pick = (override, fallback) => override && override.trim().length > 0 ? override : fallback;
    const slots = {
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
    return html.replace(TOKEN_RE, (_match, raw) => {
        const key = raw.toLowerCase();
        return slots[key] ?? '';
    });
};
exports.fillPlaceholders = fillPlaceholders;
const renderTemplatePdf = async (filledHtml) => {
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
    }
    finally {
        try {
            await page.close();
        }
        catch {
        }
    }
};
exports.renderTemplatePdf = renderTemplatePdf;
const renderTemplateThumbnail = async (html) => {
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
    }
    finally {
        try {
            await page.close();
        }
        catch {
        }
    }
};
exports.renderTemplateThumbnail = renderTemplateThumbnail;
