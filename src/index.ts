export { createChatController } from './chat-controller.js';
export {
  renderAssistantMarkdown,
  renderChatMessageContent,
  renderUserText,
} from './content-render.js';
export { createEscalationController } from './escalation-controller.js';
export { createTranscriptStore } from './transcript-store.js';
export {
  DEFAULT_TRANSCRIPT_TTL_MS,
  createIndexedDbTranscriptPersistence,
  sanitizeTranscriptMessage,
} from './transcript-persistence.js';
export { normalizeCortexMessage, parseRawActor } from './normalize.js';
export { ControllerError } from './errors.js';
export { TRANSCRIPT_SCHEMA_VERSION } from './types.js';

export type {
  ChatActor,
  ChatActorKind,
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
  QuestionField,
  QuestionOption,
  QuestionState,
  QuestionType,
  ReplyEscalationRequest,
  ReplyRequestBuilderArgs,
  RenderedChatContent,
  SendMessageResult,
  TranscriptStore,
  TranscriptStoreOptions,
  TranscriptStoreResult,
  PersistedTranscript,
  PersistedTranscriptMessage,
  TranscriptPersistence,
} from './types.js';
