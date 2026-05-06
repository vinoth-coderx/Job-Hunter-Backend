import { Router } from 'express';
import healthRoutes from './health.routes';
import authRoutes from './auth.routes';
import userRoutes from './user.routes';
import jobRoutes from './job.routes';
import appliedRoutes from './applied.routes';
import subscriptionRoutes from './subscription.routes';

const router = Router();

router.use('/', healthRoutes);
router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/jobs', jobRoutes);
router.use('/applied', appliedRoutes);
router.use('/subscriptions', subscriptionRoutes);

export default router;
