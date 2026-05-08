import { Router } from 'express';
import {
  getCompanyProfile,
  listCompanyJobs,
  followCompany,
  unfollowCompany,
  listFollowedCompanies,
  submitReview,
  listReviews,
  reviewSchema,
} from '../controllers/company.controller';
import { authenticate, optionalAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';

const router = Router();

// Static segments before `/:id` matchers.
router.get('/followed', authenticate, listFollowedCompanies);

// Public — anyone can browse a company profile.
router.get('/:id', optionalAuth, getCompanyProfile);
router.get('/:id/jobs', optionalAuth, listCompanyJobs);

// Auth — follow + review.
router.post('/:id/follow', authenticate, followCompany);
router.delete('/:id/follow', authenticate, unfollowCompany);

router.post('/:id/reviews', authenticate, validate(reviewSchema), submitReview);
router.get('/:id/reviews', optionalAuth, listReviews);

export default router;
