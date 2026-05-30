import {
  createChatError,
  errorFromUnknown,
} from './errors.js';
import { createDebugLogger } from './debug.js';
import { createEscalationController } from './escalation-controller.js';
import { normalizeCortexMessage } from './normalize.js';
import { createTranscriptStore } from './transcript-store.js';
import type {
  ChatAuthState,
  ChatController,
  ChatControllerEvent,
  ChatControllerOptions,
  ChatErrorViewModel,
  ChatMessageViewModel,
  ChatState,
  EscalationReplyContent,
  QuestionField,
  QuestionOption,
  QuestionState,
  SendMessageResult,
  WorkerState,
  WorkerStateName,
} from './types.js';
import {
  TERMINAL_SESSION_STATES,
  asNonEmptyString,
  asPayload,
  cloneEscalation,
  cloneMessage,
  isRecord,
} from './utils.js';

const MESSAGE_SEND_TIMEOUT_MS = 15_000;
const LIFECYCLE_SESSION_STATE_MAP: Record<string, string> = {
  active: 'ACTIVE',
  waiting: 'WAITING',
  completed: 'COMPLETED',
  failed: 'FAILED',
  stopped: 'STOPPED',
  timeout: 'TIMEOUT',
  cancelled: 'CANCELLED',
};

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, msg: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(msg)), timeoutMs);
        unrefTimer(timer);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function unrefTimer(timer: ReturnType<typeof setTimeout> | undefined): void {
  if (timer && typeof (timer as { unref?: () => void }).unref === 'function') {
    (timer as { unref: () => void }).unref();
  }
}

function generateClientMsgId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function normalizeQuestionOptions(value: unknown): QuestionOption[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is Record<string, unknown> => isRecord(item))
    .map((item): QuestionOption => ({
      id: String(item['id'] ?? ''),
      label: String(item['label'] ?? ''),
    }))
    .filter((option) => option.id !== '' && option.label !== '');
}

function normalizeQuestionFields(value: unknown): QuestionField[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const supportedTypes = new Set(['select', 'radio', 'text', 'boolean', 'date', 'email']);
  return value
    .filter((item): item is Record<string, unknown> => isRecord(item))
    .map((item): QuestionField | null => {
      const key = asNonEmptyString(item['key']);
      const rawType = asNonEmptyString(item['type']);
      if (!key || !rawType || !supportedTypes.has(rawType)) {
        return null;
      }
      return {
        key,
        label: asNonEmptyString(item['label']) ?? key,
        type: rawType as QuestionField['type'],
        required: item['required'] === true,
        options: normalizeQuestionOptions(item['options']),
      };
    })
    .filter((item): item is QuestionField => item !== null);
}

function choiceOptionsFromQuestions(questions: QuestionField[]): QuestionOption[] {
  if (questions.length !== 1) {
    return [];
  }
  const [question] = questions;
  if (question.type !== 'select' && question.type !== 'radio') {
    return [];
  }
  return question.options;
}

// Build QuestionOptions from ask_user's {key, label} choices format when no typed questions exist.
function buildAskUserOptions(rawQuestions: unknown): QuestionOption[] {
  if (!Array.isArray(rawQuestions)) {
    return [];
  }
  const options: QuestionOption[] = [];
  for (const item of rawQuestions) {
    if (!isRecord(item) || item['type'] != null) {
      return [];
    }
    const id = asNonEmptyString(item['key']);
    const label = asNonEmptyString(item['label']) ?? id;
    if (id && label) {
      options.push({ id, label });
    }
  }
  return options;
}

function getSessionContextCorrespondent(client: ChatControllerOptions['client']): ChatState['session']['correspondent'] {
  const rawSessionContext = client.sessionContext;
  if (isRecord(rawSessionContext) && isRecord(rawSessionContext['correspondent'])) {
    const contextCorrespondent = rawSessionContext['correspondent'];
    const name = asNonEmptyString(contextCorrespondent['name']);
    if (name) {
      return {
        kind: asNonEmptyString(contextCorrespondent['kind']) ?? undefined,
        id: asNonEmptyString(contextCorrespondent['id']) ?? null,
        name,
        title: asNonEmptyString(contextCorrespondent['title']) ?? null,
        subtitle: asNonEmptyString(contextCorrespondent['subtitle']) ?? null,
        avatarUrl:
          asNonEmptyString(contextCorrespondent['avatarUrl'])
          ?? asNonEmptyString(contextCorrespondent['avatar_url'])
          ?? null,
      };
    }
  }
  return null;
}

function summarizeSendPayload(payload: {
  content?: unknown;
  attachments?: unknown[];
  meta?: Record<string, unknown>;
}) {
  return {
    contentKind: Array.isArray(payload.content) ? 'array' : typeof payload.content,
    contentLength: Array.isArray(payload.content) ? payload.content.length : undefined,
    hasAttachments: Boolean(payload.attachments?.length),
    attachmentCount: payload.attachments?.length ?? 0,
    metaKeys: payload.meta ? Object.keys(payload.meta) : [],
    clientMsgId:
      payload.meta && typeof payload.meta.client_msg_id === 'string'
        ? payload.meta.client_msg_id
        : undefined,
  };
}

export function createChatController(options: ChatControllerOptions): ChatController {
  const listeners = new Set<(state: ChatState) => void>();
  const transcriptStore = createTranscriptStore();
  const debug = createDebugLogger(options.debug);
  let unsubscribeFromClient: (() => void) | null = null;
  let destroyed = false;
  let lastError: ChatErrorViewModel | null = null;
  let activeQuestion: QuestionState | null = null;
  let workerState: WorkerState = { state: 'idle' };
  let workerStateTtlTimer: ReturnType<typeof setTimeout> | null = null;
  let awaitingAnswer = false;
  let sessionCorrespondent: ChatState['session']['correspondent'] = null;
  let sessionStateOverride: string | null = null;
  let authState: ChatAuthState = { state: 'none' };

  const escalationController = createEscalationController({
    client: options.client,
    replyRequestBuilder: options.replyRequestBuilder,
    onEvent: (event) => {
      if (event.type === 'error') {
        lastError = event.error;
      }
      emit(event);
      emitStateChanged();
    },
  });

  function getChannelState(): string {
    return options.client.channelState ?? 'CLOSED';
  }

  function getSessionState(): string {
    return sessionStateOverride ?? options.client.sessionState ?? 'CREATED';
  }

  function getSessionId(): string | null {
    return options.client.sessionId ?? options.client.sessionContext?.sessionId ?? null;
  }

  function isSessionReady(): boolean {
    return getChannelState() === 'OPEN' && getSessionId() !== null;
  }

  function defaultInputLockPolicy() {
    if (
      authState.state === 'required'
      || authState.state === 'submitting'
      || authState.state === 'denied'
    ) {
      return { locked: true, reason: 'auth_required' };
    }

    const sessionState = getSessionState();
    const escalation = escalationController.getState();

    if (getChannelState() === 'CONNECTING' || getChannelState() === 'RECONNECTING') {
      return {
        locked: true,
        reason: 'session_opening',
      };
    }

    if (!isSessionReady()) {
      return {
        locked: true,
        reason: 'session_not_ready',
      };
    }

    if (TERMINAL_SESSION_STATES.has(sessionState)) {
      return {
        locked: true,
        reason: `session_${sessionState.toLowerCase()}`,
      };
    }

    if (awaitingAnswer) {
      return {
        locked: true,
        reason: 'awaiting_answer',
      };
    }

    if (options.mode !== 'operator' && escalation?.status === 'pending') {
      return {
        locked: true,
        reason: 'pending_escalation',
      };
    }

    return { locked: false };
  }

  function computeState(): ChatState {
    const channelState = getChannelState();
    const sessionState = getSessionState();
    const sessionId = getSessionId();
    const sessionReady = isSessionReady();
    const escalation = escalationController.getState();
    const input = options.inputLockPolicy
      ? options.inputLockPolicy({
          mode: options.mode ?? 'end_user',
          channelState,
          sessionState,
          sessionId,
          isSessionReady: sessionReady,
          escalation,
        })
      : defaultInputLockPolicy();

    return {
      session: {
        correspondent: sessionCorrespondent ? { ...sessionCorrespondent } : null,
      },
      connection: {
        channelState,
        sessionState,
        sessionId,
        isSessionReady: sessionReady,
        isConnected: channelState === 'OPEN',
        isStale: channelState === 'STALE' || channelState === 'RECONNECTING',
      },
      transcript: transcriptStore.getSnapshot().map((message) => cloneMessage(message)),
      input,
      auth: { ...authState },
      escalation: cloneEscalation(escalation),
      lastError,
      activeQuestion: activeQuestion
        ? {
            ...activeQuestion,
            questions: (activeQuestion.questions ?? []).map((question) => ({
              ...question,
              options: [...question.options],
            })),
            options: [...activeQuestion.options],
          }
        : null,
      workerState: { ...workerState },
    };
  }

  function emit(event: ChatControllerEvent) {
    options.onEvent?.(event);
  }

  function emitStateChanged() {
    const state = computeState();
    for (const listener of Array.from(listeners)) {
      listener(state);
    }
    options.onStateChange?.(state);
    emit({ type: 'state_changed', state });
  }

  function setError(error: ChatErrorViewModel) {
    lastError = error;
    emit({ type: 'error', error });
  }

  function clearWorkerStateTtl(): void {
    if (workerStateTtlTimer !== null) {
      clearTimeout(workerStateTtlTimer);
      workerStateTtlTimer = null;
    }
  }

  function applyWorkerState(next: WorkerState): void {
    clearWorkerStateTtl();
    workerState = next;
    if (next.expiresAt !== undefined) {
      const remaining = next.expiresAt - Date.now();
      if (remaining <= 0) {
        workerState = { state: 'idle' };
        return;
      }
      workerStateTtlTimer = setTimeout(() => {
        workerState = { state: 'idle' };
        workerStateTtlTimer = null;
        emitStateChanged();
      }, remaining);
      unrefTimer(workerStateTtlTimer);
    }
  }

  function resetWorkerStateToIdle(): void {
    clearWorkerStateTtl();
    workerState = { state: 'idle' };
  }

  function applySessionStateOverride(nextState: string | null): void {
    if (nextState === null) {
      sessionStateOverride = null;
      return;
    }
    if (TERMINAL_SESSION_STATES.has(getSessionState()) && getSessionState() !== nextState) {
      return;
    }
    sessionStateOverride = nextState;
  }

  function resolveLifecycleStatus(message: Parameters<typeof options.client.onMessage>[0] extends (arg: infer T) => void ? T : never): string | null {
    const payload = asPayload(message);
    const payloadMeta = isRecord(payload['meta']) ? payload['meta'] : null;
    return (
      asNonEmptyString(payload['status'])
      ?? asNonEmptyString(payload['state'])
      ?? asNonEmptyString(payloadMeta?.['status'])
      ?? asNonEmptyString(payloadMeta?.['state'])
    )?.toLowerCase() ?? null;
  }

  function handleSystemOpened(): void {
    const openedCorrespondent = getSessionContextCorrespondent(options.client);
    if (openedCorrespondent) {
      sessionCorrespondent = openedCorrespondent;
    }
    applySessionStateOverride('ACTIVE');
  }

  function handleSystemLifecycle(message: Parameters<typeof options.client.onMessage>[0] extends (arg: infer T) => void ? T : never): boolean {
    const status = resolveLifecycleStatus(message);
    if (!status) {
      return false;
    }

    const nextSessionState = LIFECYCLE_SESSION_STATE_MAP[status] ?? null;
    if (nextSessionState) {
      applySessionStateOverride(nextSessionState);
    }

    if (status === 'active') {
      resetWorkerStateToIdle();
      return true;
    }

    if (status === 'busy') {
      applyWorkerState({ state: 'working' });
      return true;
    }

    if (status === 'idle') {
      resetWorkerStateToIdle();
      escalationController.clearEscalation();
      return true;
    }

    if (status === 'waiting') {
      applyWorkerState({ state: 'waiting' });
      return true;
    }

    if (TERMINAL_SESSION_STATES.has((nextSessionState ?? '').toUpperCase())) {
      awaitingAnswer = false;
      resetWorkerStateToIdle();
      return true;
    }

    return nextSessionState !== null;
  }

  function ensureClientSubscription() {
    if (destroyed || unsubscribeFromClient) {
      return;
    }
    unsubscribeFromClient = options.client.onMessage(handleMessage);
  }

  function teardownClientSubscription() {
    if (!unsubscribeFromClient) {
      return;
    }
    unsubscribeFromClient();
    unsubscribeFromClient = null;
  }

  function shouldClearEscalationOnVisibleTranscriptMessage(message: ChatMessageViewModel): boolean {
    if (!escalationController.getState()) return false;
    if (message.type === 'escalation::request') return false;
    if (message.role === 'user') return false;
    return true;
  }

  function handleMessage(message: Parameters<typeof options.client.onMessage>[0] extends (arg: infer T) => void ? T : never) {
    if (message.type === 'system::opened') {
      handleSystemOpened();
      emitStateChanged();
      return;
    }

    if (message.type === 'system::lifecycle') {
      if (handleSystemLifecycle(message)) {
        emitStateChanged();
      }
      return;
    }

    if (message.type === 'system::state') {
      const payload = asPayload(message);
      const meta = isRecord(payload['meta']) ? payload['meta'] : null;
      const stateName = (asNonEmptyString(meta?.['state']) ?? 'idle') as WorkerStateName;
      const label = asNonEmptyString(meta?.['label']) ?? undefined;
      const ttlMs = typeof meta?.['ttl_ms'] === 'number' ? (meta['ttl_ms'] as number) : undefined;
      const correlationId = asNonEmptyString(meta?.['correlation_id']) ?? undefined;
      const expiresAt = ttlMs !== undefined ? Date.now() + ttlMs : undefined;
      applyWorkerState({ state: stateName, label, expiresAt, correlation_id: correlationId });
      if (stateName === 'idle') {
        escalationController.clearEscalation();
      }
      emitStateChanged();
      return;
    }

    if (
      message.type === 'system::pong'
      || message.type === 'system::telemetry'
      || message.type === 'system::billing'
    ) {
      return;
    }

    if (message.type === 'system::auth') {
      const payload = asPayload(message);
      const state = asNonEmptyString(payload['state']);
      if (state === 'required' || state === 'denied' || state === 'accepted') {
        const msg = asNonEmptyString(payload['message']) ?? undefined;
        const method = asNonEmptyString(payload['method']);
        authState = {
          state,
          message: msg,
          method: method === 'login_password' ? 'login_password' : undefined,
        };
        emitStateChanged();
      }
      return;
    }

    const result = transcriptStore.ingest(message);
    if (result.mutation) {
      emit({
        type: result.mutation.type,
        message: cloneMessage(result.mutation.message),
      });
    }
    if (result.error) {
      lastError = result.error;
      emit({ type: 'error', error: result.error });
    }

    const escalation = escalationController.ingest(message);
    if (message.type === 'escalation::request' && escalation) {
      emit({ type: 'escalation_opened', escalation: cloneEscalation(escalation)! });
    }

    if (result.mutation && shouldClearEscalationOnVisibleTranscriptMessage(result.mutation.message)) {
      escalationController.clearEscalation();
    }

    if (message.type === 'chat::question') {
      awaitingAnswer = false;
      resetWorkerStateToIdle();
      const payload = asPayload(message);
      const meta = isRecord(payload['meta']) ? payload['meta'] : null;
      const questionRef = meta
        ? (asNonEmptyString(meta['question_ref']) ?? asNonEmptyString(meta['question_id']))
        : null;
      const legacyQuestionId = questionRef && meta && !asNonEmptyString(meta['question_ref'])
        ? asNonEmptyString(meta['question_id'])
        : null;
      if (questionRef) {
        const questions = normalizeQuestionFields(meta?.['questions']);
        const options = questions.length > 0
          ? choiceOptionsFromQuestions(questions)
          : buildAskUserOptions(meta?.['questions']);
        activeQuestion = {
          question_ref: questionRef,
          ...(legacyQuestionId ? { question_id: legacyQuestionId } : {}),
          input_type: asNonEmptyString(meta?.['input_type']) ?? 'radio',
          allow_reply: meta?.['allow_reply'] === true,
          questions,
          options,
          turn_id: asNonEmptyString(payload['turn_id']) ?? null,
        };
      }
    }

    if (message.type === 'chat::answer' || message.type === 'system::error') {
      awaitingAnswer = false;
      activeQuestion = null;
      resetWorkerStateToIdle();
      if (message.type === 'system::error') {
        escalationController.clearEscalation();
      }
    }

    if (message.type === 'sandbox::lifecycle') {
      const payload = asPayload(message);
      const status = asNonEmptyString(payload['status'])?.toLowerCase() ?? null;
      if (status && ['completed', 'failed', 'stopped', 'timeout', 'cancelled'].includes(status)) {
        awaitingAnswer = false;
      }
    }

    if (message.type === 'system::error') {
      const payload = asPayload(message);
      lastError = createChatError(
        typeof payload['code'] === 'string' ? payload['code'] : 'system_error',
        typeof payload['message'] === 'string' ? payload['message'] : 'Runtime error',
        'system::error',
      );
    }

    emitStateChanged();
  }

  async function runAction(action: () => Promise<void>) {
    try {
      await action();
    } catch (error) {
      if (!(error instanceof Error)) {
        setError(errorFromUnknown(error));
      }
      throw error;
    }
  }

  return {
    getState() {
      return computeState();
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async connect() {
      ensureClientSubscription();
      await options.client.connect();
      emitStateChanged();
    },

    async disconnect() {
      awaitingAnswer = false;
      sessionStateOverride = null;
      authState = { state: 'none' };
      if (options.client.disconnect) {
        await options.client.disconnect();
      }
      teardownClientSubscription();
      emitStateChanged();
    },

    async sendMessage(message: { content: unknown; attachments?: unknown[]; meta?: Record<string, unknown> }): Promise<SendMessageResult> {
      ensureClientSubscription();
      const clientMsgId = generateClientMsgId();
      const id = `client:${clientMsgId}`;

      const sendPayload = {
        content: message.content,
        attachments: message.attachments,
        meta: {
          ...(message.meta ?? {}),
          client_msg_id: clientMsgId,
        },
      };

      const optimistic: ChatMessageViewModel = {
        id,
        type: 'chat::message',
        role: 'user',
        content: message.content,
        status: 'final',
        deliveryStatus: 'sending',
        ts: new Date().toISOString(),
        clientMsgId,
        retryable: false,
        meta: {
          ...(message.meta ?? {}),
          ...(message.attachments ? { attachments: message.attachments } : {}),
          client_msg_id: clientMsgId,
          timestamp_source: 'client',
        },
        originalPayload: sendPayload,
      };

      transcriptStore.upsertLocalMessage(optimistic);
      emitStateChanged();

      try {
      debug.log('[sdk-ui] sendMessage -> client.sendMessage start', summarizeSendPayload(sendPayload));
      await withTimeout(
        options.client.sendMessage(sendPayload),
        MESSAGE_SEND_TIMEOUT_MS,
          'Message was not sent',
        );
        transcriptStore.upsertLocalMessage({
          ...optimistic,
          deliveryStatus: 'sent',
          retryable: false,
          sendError: undefined,
        });
        awaitingAnswer = true;
        debug.log('[sdk-ui] sendMessage -> client.sendMessage done', {
          clientMsgId,
          ok: true,
        });
        emitStateChanged();
        return { ok: true, messageId: id, clientMsgId };
      } catch (err) {
        awaitingAnswer = false;
        debug.log('[sdk-ui] sendMessage -> client.sendMessage failed', {
          clientMsgId,
          error: err instanceof Error ? err.message : String(err),
        });
        const sendError = err instanceof Error ? err.message : 'Message was not sent';
        transcriptStore.upsertLocalMessage({ ...optimistic, deliveryStatus: 'failed', retryable: true, sendError });
        emitStateChanged();
        return { ok: false, messageId: id, clientMsgId, error: sendError };
      }
    },

    async retryMessage(messageId: string): Promise<SendMessageResult | null> {
      const snapshot = transcriptStore.getSnapshot();
      const msg = snapshot.find(
        (m) => m.id === messageId && m.role === 'user' && m.retryable === true && m.originalPayload !== undefined,
      );
      if (!msg?.originalPayload || !msg.clientMsgId) return null;

      const clientMsgId = msg.clientMsgId;
      const updated: ChatMessageViewModel = {
        ...msg,
        deliveryStatus: 'sending',
        retryable: false,
        sendError: undefined,
      };
      transcriptStore.upsertLocalMessage(updated);
      emitStateChanged();

      try {
        debug.log('[sdk-ui] retryMessage -> client.sendMessage start', summarizeSendPayload(msg.originalPayload));
        await withTimeout(
          options.client.sendMessage(msg.originalPayload),
          MESSAGE_SEND_TIMEOUT_MS,
          'Message was not sent',
        );
        transcriptStore.upsertLocalMessage({
          ...updated,
          deliveryStatus: 'sent',
          retryable: false,
          sendError: undefined,
        });
        awaitingAnswer = true;
        debug.log('[sdk-ui] retryMessage -> client.sendMessage done', {
          clientMsgId,
          ok: true,
        });
        emitStateChanged();
        return { ok: true, messageId, clientMsgId };
      } catch (err) {
        awaitingAnswer = false;
        debug.log('[sdk-ui] retryMessage -> client.sendMessage failed', {
          clientMsgId,
          error: err instanceof Error ? err.message : String(err),
        });
        const sendError = err instanceof Error ? err.message : 'Message was not sent';
        transcriptStore.upsertLocalMessage({ ...updated, deliveryStatus: 'failed', retryable: true, sendError });
        emitStateChanged();
        return { ok: false, messageId, clientMsgId, error: sendError };
      }
    },

    async submitLogin(credentials: { login: string; password: string }): Promise<{ ok: boolean; error?: string }> {
      if (!options.client.sendLogin) {
        return { ok: false, error: 'auth_not_supported' };
      }
      authState = { ...authState, state: 'submitting' };
      emitStateChanged();
      try {
        await options.client.sendLogin(credentials);
        return { ok: true };
      } catch (err) {
        authState = {
          state: 'denied',
          message: 'Login failed',
          method: authState.method,
        };
        emitStateChanged();
        return { ok: false, error: err instanceof Error ? err.message : 'Login failed' };
      }
    },

    async replyToUser(content: EscalationReplyContent) {
      ensureClientSubscription();
      await runAction(() => escalationController.replyToUser(content));
    },

    async returnToWorker(content: EscalationReplyContent) {
      ensureClientSubscription();
      await runAction(() => escalationController.returnToWorker(content));
    },

    async continueWorker(content?: EscalationReplyContent) {
      ensureClientSubscription();
      await runAction(() => escalationController.continueWorker(content));
    },

    destroy() {
      if (destroyed) {
        return;
      }
      destroyed = true;
      clearWorkerStateTtl();
      teardownClientSubscription();
      listeners.clear();
    },
  };
}
