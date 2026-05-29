export type ChatMessageRole =
  | 'user'
  | 'assistant'
  | 'system'
  | 'operator'
  | 'escalation'
  | 'error';

export type ChatMessageStatus = 'streaming' | 'final' | 'error';

// Delivery status is transport/runtime progress for optimistic user messages.
// Do not infer `delivered` without an explicit protocol ack.
// Current semantics:
// - `sent`: client.sendMessage() / WebSocket send resolved
// - `processed`: chat::echo received from Runtime
// - `delivered`: reserved for a future explicit server-side acceptance ack
export type ChatMessageDeliveryStatus = 'sending' | 'sent' | 'delivered' | 'processed' | 'failed';

export type EscalationAction =
  | 'continue'
  | 'operator_input'
  | 'reply_user';

export type EscalationReplyContent = string | Record<string, unknown>;

export interface CortexTransportMessage {
  type: string;
  schema?: string;
  session_id?: string;
  seq?: number;
  payload?: Record<string, unknown>;
  meta?: Record<string, unknown>;
  ts?: string;
  [key: string]: unknown;
}

export interface ReplyEscalationRequest {
  escalationId: string;
  waitToken?: string;
  action: EscalationAction;
  content?: EscalationReplyContent;
  meta?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface QuestionOption {
  id: string;
  label: string;
}

export type QuestionType = 'select' | 'radio' | 'text' | 'boolean' | 'date' | 'email';

export interface QuestionField {
  key: string;
  label: string;
  type: QuestionType;
  required: boolean;
  options: QuestionOption[];
}

export interface QuestionState {
  /** Canonical transport correlation key for chat::question replies. */
  question_ref: string;
  /** Legacy fallback accepted on inbound chat::question during transition. */
  question_id?: string;
  input_type: string;
  allow_reply: boolean;
  /** Canonical interactive question objects from payload.meta.questions. */
  questions?: QuestionField[];
  /** Present only for normalized single-question compatibility helpers. */
  options: QuestionOption[];
  turn_id?: string | null;
}

export interface CortexClientLike {
  connect(): Promise<void>;
  disconnect?(): Promise<void>;
  sendMessage(options: { content: unknown; attachments?: unknown[]; meta?: Record<string, unknown> }): Promise<void>;
  sendLogin?(credentials: { login: string; password: string }): Promise<void>;
  replyEscalation?(options: ReplyEscalationRequest): Promise<void>;
  onMessage(handler: (message: CortexTransportMessage) => void): () => void;
  sessionId?: string | null;
  sessionMeta?: Record<string, unknown> | null;
  sessionContext?: {
    sessionId: string;
    identity?: Record<string, unknown> | null;
    correspondent?: {
      kind?: string | null;
      id?: string | null;
      name: string;
      title?: string | null;
      subtitle?: string | null;
      avatarUrl?: string | null;
    } | null;
  } | null;
  sessionState?: string;
  channelState?: string;
  accessToken?: string | null;
  cpApiUrl?: string | null;
}

export interface ChatAuthState {
  state: 'none' | 'required' | 'submitting' | 'denied' | 'accepted';
  message?: string;
  method?: 'login_password';
}

export interface ChatCorrespondent {
  kind?: string;
  id?: string | null;
  name: string;
  title?: string | null;
  subtitle?: string | null;
  avatarUrl?: string | null;
}

export interface ChatSessionState {
  correspondent: ChatCorrespondent | null;
}

export type ChatActorKind = 'user' | 'operator' | 'digital_worker' | 'system';

export interface ChatActor {
  kind: ChatActorKind;
  id?: string | null;
  name: string;
  title?: string | null;
  subtitle?: string | null;
  avatarUrl?: string | null;
}

export interface ChatMessageViewModel {
  id: string;
  seq?: number | null;
  type: string;
  role: ChatMessageRole;
  content: unknown;
  status?: ChatMessageStatus;
  ts?: string | null;
  meta?: Record<string, unknown>;
  actor?: ChatActor | null;
  clientMsgId?: string;
  deliveryStatus?: ChatMessageDeliveryStatus;
  retryable?: boolean;
  sendError?: string;
  originalPayload?: {
    content: unknown;
    attachments?: unknown[];
    meta?: Record<string, unknown>;
  };
}

export interface EscalationState {
  escalationId: string;
  reason?: string;
  message?: string;
  content?: unknown;
  allowedActions: EscalationAction[];
  waitToken?: string;
  status: 'pending' | 'replied' | 'expired' | 'cancelled';
}

export interface ChatErrorViewModel {
  code: string;
  message: string;
  source?: string;
  details?: Record<string, unknown>;
}

export type WorkerStateName = 'idle' | 'working' | 'waiting' | 'error';

export interface WorkerState {
  state: WorkerStateName;
  label?: string;
  expiresAt?: number;
  canRetry?: boolean;
  correlation_id?: string;
}

export interface ChatState {
  session: ChatSessionState;
  connection: {
    channelState: string;
    sessionState: string;
    sessionId: string | null;
    isSessionReady: boolean;
    isConnected: boolean;
    isStale: boolean;
  };
  transcript: ChatMessageViewModel[];
  input: {
    locked: boolean;
    reason?: string;
  };
  auth: ChatAuthState;
  escalation: EscalationState | null;
  lastError: ChatErrorViewModel | null;
  activeQuestion: QuestionState | null;
  workerState: WorkerState;
}

export type RenderedChatContent =
  | { format: 'html'; html: string; kind: 'assistant_markdown' }
  | {
    format: 'text';
    text: string;
    style: 'plain' | 'preformatted';
    kind: 'plain_text' | 'structured_fallback';
  };

export type ChatControllerEvent =
  | { type: 'state_changed'; state: ChatState }
  | { type: 'message_added'; message: ChatMessageViewModel }
  | { type: 'message_updated'; message: ChatMessageViewModel }
  | { type: 'escalation_opened'; escalation: EscalationState }
  | { type: 'escalation_replied'; action: EscalationAction }
  | { type: 'error'; error: ChatErrorViewModel };

export interface ReplyRequestBuilderArgs {
  escalation: EscalationState;
  action: EscalationAction;
  content?: EscalationReplyContent;
}

export interface EscalationControllerOptions {
  client: CortexClientLike;
  initialState?: EscalationState | null;
  replyRequestBuilder?: (args: ReplyRequestBuilderArgs) => ReplyEscalationRequest;
  onEvent?: (event: ChatControllerEvent) => void;
}

export interface ChatControllerOptions {
  client: CortexClientLike;
  mode?: 'end_user' | 'operator';
  debug?: boolean;
  onStateChange?: (state: ChatState) => void;
  onEvent?: (event: ChatControllerEvent) => void;
  replyRequestBuilder?: (args: ReplyRequestBuilderArgs) => ReplyEscalationRequest;
  inputLockPolicy?: (args: {
    mode: 'end_user' | 'operator';
    channelState: string;
    sessionState: string;
    sessionId: string | null;
    isSessionReady: boolean;
    escalation: EscalationState | null;
  }) => { locked: boolean; reason?: string };
}

export interface TranscriptStoreMutation {
  type: 'message_added' | 'message_updated';
  message: ChatMessageViewModel;
}

export interface TranscriptStoreResult {
  transcript: ChatMessageViewModel[];
  mutation?: TranscriptStoreMutation;
  error?: ChatErrorViewModel;
}

export interface TranscriptStoreOptions {
  initialTranscript?: ChatMessageViewModel[];
}

export interface TranscriptStore {
  getSnapshot(): ChatMessageViewModel[];
  subscribe(listener: (transcript: ChatMessageViewModel[]) => void): () => void;
  ingest(message: CortexTransportMessage): TranscriptStoreResult;
  reset(): void;
  upsertLocalMessage(message: ChatMessageViewModel): TranscriptStoreResult;
}

export interface EscalationController {
  getState(): EscalationState | null;
  setState(state: EscalationState | null): void;
  clearEscalation(): void;
  ingest(message: CortexTransportMessage): EscalationState | null;
  replyToUser(content: EscalationReplyContent): Promise<void>;
  returnToWorker(content: EscalationReplyContent): Promise<void>;
  continueWorker(content?: EscalationReplyContent): Promise<void>;
}

export type SendMessageResult =
  | { ok: true; messageId: string; clientMsgId: string }
  | { ok: false; messageId: string; clientMsgId: string; error: string };

export interface ChatController {
  getState(): ChatState;
  subscribe(listener: (state: ChatState) => void): () => void;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  sendMessage(options: { content: unknown; attachments?: unknown[]; meta?: Record<string, unknown> }): Promise<SendMessageResult>;
  retryMessage(messageId: string): Promise<SendMessageResult | null>;
  submitLogin(credentials: { login: string; password: string }): Promise<{ ok: boolean; error?: string }>;
  replyToUser(content: EscalationReplyContent): Promise<void>;
  returnToWorker(content: EscalationReplyContent): Promise<void>;
  continueWorker(content?: EscalationReplyContent): Promise<void>;
  destroy(): void;
}
