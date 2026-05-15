export { createChatController } from './chat-controller.js';
export {
  renderAssistantMarkdown,
  renderChatMessageContent,
  renderUserText,
} from './content-render.js';
export { createEscalationController } from './escalation-controller.js';
export { createTranscriptStore } from './transcript-store.js';
export { normalizeCortexMessage } from './normalize.js';
export { ControllerError } from './errors.js';

export type {
  ChatController,
  ChatControllerEvent,
  ChatControllerOptions,
  ChatCorrespondent,
  ChatErrorViewModel,
  ChatMessageViewModel,
  ChatMessageRole,
  ChatMessageStatus,
  ChatMessageDeliveryStatus,
  ChatSessionState,
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
  RenderedChatContent,
  SendMessageResult,
  TranscriptStore,
  TranscriptStoreOptions,
  TranscriptStoreResult,
} from './types.js';
