export type ChatMessageRole =
  | 'user'
  | 'assistant'
  | 'system'
  | 'operator'
  | 'escalation'
  | 'error';

export type ChatMessageStatus = 'streaming' | 'final' | 'error';

export type ChatMessageDeliveryStatus = 'sending' | 'sent' | 'failed';

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

export interface QuestionState {
  question_id: string;
  input_type: string;
  allow_reply: boolean;
  options: QuestionOption[];
  turn_id?: string | null;
}

export interface CortexClientLike {
  connect(): Promise<void>;
  disconnect?(): Promise<void>;
  sendMessage(options: { content: unknown; attachments?: unknown[]; meta?: Record<string, unknown> }): Promise<void>;
  replyEscalation?(options: ReplyEscalationRequest): Promise<void>;
  onMessage(handler: (message: CortexTransportMessage) => void): () => void;
  sessionId?: string | null;
  sessionState?: string;
  channelState?: string;
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
  connection: {
    channelState: string;
    sessionState: string;
    isConnected: boolean;
    isStale: boolean;
  };
  transcript: ChatMessageViewModel[];
  input: {
    locked: boolean;
    reason?: string;
  };
  escalation: EscalationState | null;
  lastError: ChatErrorViewModel | null;
  activeQuestion: QuestionState | null;
  workerState: WorkerState;
}

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
  onStateChange?: (state: ChatState) => void;
  onEvent?: (event: ChatControllerEvent) => void;
  replyRequestBuilder?: (args: ReplyRequestBuilderArgs) => ReplyEscalationRequest;
  inputLockPolicy?: (args: {
    mode: 'end_user' | 'operator';
    channelState: string;
    sessionState: string;
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
  ingest(message: CortexTransportMessage): EscalationState | null;
  replyToUser(content: EscalationReplyContent): Promise<void>;
  returnToWorker(content: EscalationReplyContent): Promise<void>;
  continueWorker(content?: EscalationReplyContent): Promise<void>;
}

export interface ChatController {
  getState(): ChatState;
  subscribe(listener: (state: ChatState) => void): () => void;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  sendMessage(options: { content: unknown; attachments?: unknown[]; meta?: Record<string, unknown> }): Promise<void>;
  retryMessage(messageId: string): Promise<void>;
  replyToUser(content: EscalationReplyContent): Promise<void>;
  returnToWorker(content: EscalationReplyContent): Promise<void>;
  continueWorker(content?: EscalationReplyContent): Promise<void>;
  destroy(): void;
}
