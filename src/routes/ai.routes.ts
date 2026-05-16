import { Router } from 'express';
import {
  generateCoverLetterEndpoint,
  profileOptimizerEndpoint,
  skillGapEndpoint,
  quotaStatusEndpoint,
  jobInsightEndpoint,
  chatSendEndpoint,
  chatHistoryEndpoint,
  chatClearEndpoint,
  forYouEndpoint,
  fieldSuggestEndpoint,
  fieldSuggestSchema,
  coverLetterSchema,
  skillGapSchema,
  jobInsightSchema,
  chatSchema,
  atsScoreEndpoint,
  atsScoreSchema,
  atsHistoryEndpoint,
  resumeRewriteEndpoint,
  resumeRewriteSchema,
  skillExtractEndpoint,
  skillExtractSchema,
  aiFeedbackEndpoint,
  aiFeedbackSchema,
  chatStreamEndpoint,
  chatStreamSchema,
  usageHistoryEndpoint,
} from '../controllers/ai.controller';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validate';
import {
  listAiTopUpPacks,
  createAiTopUpOrder,
  createAiTopUpOrderSchema,
  verifyAiTopUpPayment,
  verifyAiTopUpSchema,
  aiTopUpHistory,
} from '../controllers/aiTopUp.controller';

const router = Router();
router.use(authenticate);

router.post(
  '/cover-letter',
  validate(coverLetterSchema),
  generateCoverLetterEndpoint,
);

router.get('/profile-optimizer', profileOptimizerEndpoint);
router.post('/skill-gap', validate(skillGapSchema), skillGapEndpoint);

router.get('/quota', quotaStatusEndpoint);
router.get('/usage/history', usageHistoryEndpoint);
router.post('/job-insight', validate(jobInsightSchema), jobInsightEndpoint);

router.post('/chat', validate(chatSchema), chatSendEndpoint);
router.post('/chat/stream', validate(chatStreamSchema), chatStreamEndpoint);
router.get('/chat', chatHistoryEndpoint);
router.delete('/chat', chatClearEndpoint);

router.post('/ats-score', validate(atsScoreSchema), atsScoreEndpoint);
router.get('/ats-score/history', atsHistoryEndpoint);
router.post(
  '/resume/rewrite',
  validate(resumeRewriteSchema),
  resumeRewriteEndpoint,
);
router.post(
  '/skills/extract',
  validate(skillExtractSchema),
  skillExtractEndpoint,
);
router.post('/feedback', validate(aiFeedbackSchema), aiFeedbackEndpoint);

// AI credit top-up — pay-as-you-go pack purchases via Razorpay.
router.get('/topup/packs', listAiTopUpPacks);
router.post(
  '/topup/order',
  validate(createAiTopUpOrderSchema),
  createAiTopUpOrder,
);
router.post(
  '/topup/verify',
  validate(verifyAiTopUpSchema),
  verifyAiTopUpPayment,
);
router.get('/topup/history', aiTopUpHistory);

router.get('/for-you', forYouEndpoint);
router.post(
  '/profile-field-suggest',
  validate(fieldSuggestSchema),
  fieldSuggestEndpoint,
);

export default router;
