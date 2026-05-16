import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  runHeuristics,
  contentHash,
} from '../moderation.service';
import { trustBandLabel } from '../trustScore.service';
import type { IJob } from '../../../models/Job';

// Test harness: build a minimal IJob-shaped fixture. We only populate
// the fields runHeuristics inspects — title/description/responsibilities/
// salaryMin/salaryMax — and cast through `unknown` so the strict
// IJob type doesn't fight back over the missing mongoose-internal
// fields (timestamps, _id, etc.) that the heuristic never reads.
const job = (over: Partial<Pick<IJob, 'title' | 'description' | 'responsibilities' | 'salaryMin' | 'salaryMax' | 'company'>>): IJob =>
  ({
    title: 'Software Engineer',
    company: 'Acme',
    description: 'We are hiring a backend engineer.',
    responsibilities: [],
    salaryMin: undefined,
    salaryMax: undefined,
    ...over,
  }) as unknown as IJob;

describe('runHeuristics', () => {
  it('clean listing gets zero score + no flags', () => {
    const r = runHeuristics(
      job({
        title: 'Backend Engineer',
        description:
          'Join our team building scalable services. 3+ years experience required.',
      }),
    );
    assert.equal(r.score, 0);
    assert.deepEqual(r.flags, []);
  });

  it('detects "registration fee" scam keyword', () => {
    const r = runHeuristics(
      job({
        description:
          'Send your registration fee to join. Earn ₹50,000 daily working from home.',
      }),
    );
    assert.ok(r.flags.includes('scam_keywords'));
    assert.ok(r.score > 0);
  });

  it('detects WhatsApp-only contact', () => {
    // Two shapes the heuristic catches: contiguous digits after a
    // WhatsApp label, and the "ping me on whatsapp" phrase. Exercise
    // the phrase variant — it's the one users hit most often.
    const r = runHeuristics(
      job({
        description:
          'Apply by ping me on WhatsApp to discuss the offer.',
      }),
    );
    assert.ok(r.flags.includes('whatsapp_only_contact'));
  });

  it('detects payment ask', () => {
    const r = runHeuristics(
      job({
        description: 'Pay ₹500 to our UPI ID to confirm your interview slot.',
      }),
    );
    assert.ok(r.flags.includes('asks_payment'));
    assert.ok(r.score >= 25);
  });

  it('detects MLM pattern', () => {
    const r = runHeuristics(
      job({
        title: 'Network Marketing Associate',
        description:
          'Grow your downline in our MLM business and earn unlimited income from the pyramid structure.',
      }),
    );
    assert.ok(r.flags.includes('mlm_pattern'));
    assert.ok(r.flags.includes('scam_keywords'));
  });

  it('detects suspicious shortened URL', () => {
    const r = runHeuristics(
      job({
        description: 'Apply at https://bit.ly/3xyz4ab for fast processing.',
      }),
    );
    assert.ok(r.flags.includes('suspicious_url'));
  });

  it('flags unrealistic salary (> 50 LPA)', () => {
    const r = runHeuristics(
      job({
        title: 'Junior Data Entry',
        description: 'No experience required.',
        salaryMax: 60_00_000,
      }),
    );
    assert.ok(r.flags.includes('fake_salary'));
  });

  it('score is capped at 100', () => {
    const r = runHeuristics(
      job({
        title: 'MLM data entry pyramid scheme',
        description:
          'Pay your registration fee on WhatsApp +91 9876543210. Send to UPI ID. Earn ₹50,000 daily. Investment opportunity in our downline pyramid. Forex crypto investment guaranteed.',
        salaryMax: 90_00_000,
      }),
    );
    assert.equal(r.score, 100);
  });
});

describe('contentHash', () => {
  it('produces stable hash for same content', () => {
    const a = contentHash({
      title: 'Engineer',
      company: 'Acme',
      description: 'Build stuff.',
    } as IJob);
    const b = contentHash({
      title: 'Engineer',
      company: 'Acme',
      description: 'Build stuff.',
    } as IJob);
    assert.equal(a, b);
  });

  it('normalises whitespace differences', () => {
    const a = contentHash({
      title: 'Engineer',
      company: 'Acme',
      description: 'Build  stuff.',
    } as IJob);
    const b = contentHash({
      title: 'Engineer',
      company: 'Acme',
      description: 'Build stuff.',
    } as IJob);
    assert.equal(a, b);
  });

  it('normalises case differences', () => {
    const a = contentHash({
      title: 'engineer',
      company: 'acme',
      description: 'build stuff.',
    } as IJob);
    const b = contentHash({
      title: 'ENGINEER',
      company: 'ACME',
      description: 'BUILD STUFF.',
    } as IJob);
    assert.equal(a, b);
  });

  it('different content produces different hash', () => {
    const a = contentHash({
      title: 'Engineer',
      company: 'Acme',
      description: 'Build stuff.',
    } as IJob);
    const b = contentHash({
      title: 'Engineer',
      company: 'Acme',
      description: 'Different description.',
    } as IJob);
    assert.notEqual(a, b);
  });
});

describe('trustBandLabel', () => {
  it('returns high for >= 70', () => {
    assert.equal(trustBandLabel(70), 'high');
    assert.equal(trustBandLabel(100), 'high');
  });
  it('returns medium for 40-69', () => {
    assert.equal(trustBandLabel(40), 'medium');
    assert.equal(trustBandLabel(69), 'medium');
  });
  it('returns low for < 40', () => {
    assert.equal(trustBandLabel(0), 'low');
    assert.equal(trustBandLabel(39), 'low');
  });
});
