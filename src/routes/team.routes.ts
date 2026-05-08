import { Router } from 'express';
import {
  inviteTeamMember,
  listTeam,
  acceptInvite,
  removeMember,
  updateMemberRole,
  revokeInvite,
  inviteSchema,
  acceptSchema,
  updateRoleSchema,
} from '../controllers/team.controller';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validate';

const router = Router();
router.use(authenticate);

router.get('/', listTeam);
router.post('/invite', validate(inviteSchema), inviteTeamMember);
router.post('/accept', validate(acceptSchema), acceptInvite);
router.delete('/invites/:id', revokeInvite);
router.delete('/members/:userId', removeMember);
router.put('/members/:userId/role', validate(updateRoleSchema), updateMemberRole);

export default router;
