import { Router } from 'express';
import {
  listConversations,
  getConversation,
  startConversation,
  listMessages,
  sendMessage,
  markRead,
  startConversationSchema,
  sendMessageSchema,
} from '../controllers/chat.controller';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validate';

const router = Router();
router.use(authenticate);

router.get('/', listConversations);
router.post('/', validate(startConversationSchema), startConversation);
router.get('/:id', getConversation);
router.get('/:id/messages', listMessages);
router.post('/:id/messages', validate(sendMessageSchema), sendMessage);
router.put('/:id/read', markRead);

export default router;
