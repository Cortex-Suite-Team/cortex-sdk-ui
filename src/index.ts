export { createChatController } from './chat-controller.js';
export { createEscalationController } from './escalation-controller.js';
export { createTranscriptStore } from './transcript-store.js';
export { normalizeCortexMessage } from './normalize.js';
export { ControllerError } from './errors.js';

export type {
  ChatController,
  ChatControllerEvent,
  ChatControllerOptions,
  ChatErrorViewModel,
  ChatMessageDeliveryStatus,
  ChatMessageRole,
  ChatMessageStatus,
  ChatMessageViewModel,
  ChatState,
  CortexClientLike,
  CortexTransportMessage,
  EscalationAction,
  EscalationController,
  EscalationControllerOptions,
  EscalationReplyContent,
  EscalationState,
  QuestionOption,
  QuestionState,
  ReplyEscalationRequest,
  ReplyRequestBuilderArgs,
  SendMessageResult,
  TranscriptStore,
  TranscriptStoreOptions,
  TranscriptStoreResult,
} from './types.js';
