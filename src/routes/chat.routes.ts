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
import { uploadChatAttachment } from '../middleware/upload';

const router = Router();
router.use(authenticate);

router.get('/', listConversations);
router.post('/', validate(startConversationSchema), startConversation);
router.get('/:id', getConversation);
router.get('/:id/messages', listMessages);
// Multer runs first so multipart bodies are parsed into req.body / req.file
// before zod validation. JSON requests skip multer's body-handling and fall
// straight through to validate() unchanged.
router.post(
  '/:id/messages',
  uploadChatAttachment,
  validate(sendMessageSchema),
  sendMessage,
);
router.put('/:id/read', markRead);

export default router;
