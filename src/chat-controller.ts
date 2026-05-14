import {
  createChatError,
  errorFromUnknown,
} from './errors.js';
import { createEscalationController } from './escalation-controller.js';
import { createTranscriptStore } from './transcript-store.js';
import type {
  ChatController,
  ChatControllerEvent,
  ChatControllerOptions,
  ChatErrorViewModel,
  ChatMessageViewModel,
  ChatState,
  EscalationReplyContent,
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

function getSessionCorrespondent(client: ChatControllerOptions['client']): ChatState['session']['correspondent'] {
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
        avatarUrl: asNonEmptyString(contextCorrespondent['avatarUrl']) ?? null,
      };
    }
  }

  const rawMeta = client.sessionMeta;
  if (!isRecord(rawMeta)) {
    return null;
  }

  const rawCorrespondent = rawMeta['chat_correspondent'];
  if (!isRecord(rawCorrespondent)) {
    return null;
  }

  const name = asNonEmptyString(rawCorrespondent['name']);
  if (!name) {
    return null;
  }

  return {
    kind: asNonEmptyString(rawCorrespondent['kind']) ?? undefined,
    id: asNonEmptyString(rawCorrespondent['id']) ?? null,
    name,
    title: asNonEmptyString(rawCorrespondent['title']) ?? null,
    subtitle: asNonEmptyString(rawCorrespondent['subtitle']) ?? null,
    avatarUrl: asNonEmptyString(rawCorrespondent['avatar_url']) ?? null,
  };
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
  let unsubscribeFromClient: (() => void) | null = null;
  let destroyed = false;
  let lastError: ChatErrorViewModel | null = null;
  let activeQuestion: QuestionState | null = null;
  let workerState: WorkerState = { state: 'idle' };
  let workerStateTtlTimer: ReturnType<typeof setTimeout> | null = null;
  let awaitingAnswer = false;

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
    return options.client.sessionState ?? 'CREATED';
  }

  function getSessionId(): string | null {
    return options.client.sessionId ?? options.client.sessionContext?.sessionId ?? null;
  }

  function isSessionReady(): boolean {
    return getChannelState() === 'OPEN' && getSessionId() !== null;
  }

  function defaultInputLockPolicy() {
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
        correspondent: getSessionCorrespondent(options.client),
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
      escalation: cloneEscalation(escalation),
      lastError,
      activeQuestion: activeQuestion
        ? { ...activeQuestion, options: [...activeQuestion.options] }
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

  function handleMessage(message: Parameters<typeof options.client.onMessage>[0] extends (arg: infer T) => void ? T : never) {
    if (message.type === 'system::state') {
      const payload = asPayload(message);
      const meta = isRecord(payload['meta']) ? payload['meta'] : null;
      const stateName = (asNonEmptyString(meta?.['state']) ?? 'idle') as WorkerStateName;
      const label = asNonEmptyString(meta?.['label']) ?? undefined;
      const ttlMs = typeof meta?.['ttl_ms'] === 'number' ? (meta['ttl_ms'] as number) : undefined;
      const correlationId = asNonEmptyString(meta?.['correlation_id']) ?? undefined;
      const expiresAt = ttlMs !== undefined ? Date.now() + ttlMs : undefined;
      applyWorkerState({ state: stateName, label, expiresAt, correlation_id: correlationId });
      emitStateChanged();
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

    if (message.type === 'chat::question') {
      awaitingAnswer = false;
      resetWorkerStateToIdle();
      const payload = asPayload(message);
      const meta = isRecord(payload['meta']) ? payload['meta'] : null;
      const questionId = meta ? asNonEmptyString(meta['question_id']) : null;
      if (questionId) {
        const rawOptions = Array.isArray(meta?.['options']) ? meta['options'] as unknown[] : [];
        activeQuestion = {
          question_id: questionId,
          input_type: asNonEmptyString(meta?.['input_type']) ?? 'radio',
          allow_reply: meta?.['allow_reply'] === true,
          options: (rawOptions as unknown[])
            .filter((o): o is Record<string, unknown> => isRecord(o))
            .map((o): QuestionOption => ({ id: String(o['id'] ?? ''), label: String(o['label'] ?? '') }))
            .filter((o) => o.id !== '' && o.label !== ''),
          turn_id: asNonEmptyString(payload['turn_id']) ?? null,
        };
      }
    }

    if (message.type === 'chat::answer' || message.type === 'system::error') {
      awaitingAnswer = false;
      activeQuestion = null;
      resetWorkerStateToIdle();
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
        console.debug('[sdk-ui] sendMessage -> client.sendMessage start', summarizeSendPayload(sendPayload));
        await withTimeout(
          options.client.sendMessage(sendPayload),
          MESSAGE_SEND_TIMEOUT_MS,
          'Message was not sent',
        );
        awaitingAnswer = true;
        console.debug('[sdk-ui] sendMessage -> client.sendMessage done', {
          clientMsgId,
          ok: true,
        });
        emitStateChanged();
        return { ok: true, messageId: id, clientMsgId };
      } catch (err) {
        awaitingAnswer = false;
        console.debug('[sdk-ui] sendMessage -> client.sendMessage failed', {
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
        console.debug('[sdk-ui] retryMessage -> client.sendMessage start', summarizeSendPayload(msg.originalPayload));
        await withTimeout(
          options.client.sendMessage(msg.originalPayload),
          MESSAGE_SEND_TIMEOUT_MS,
          'Message was not sent',
        );
        awaitingAnswer = true;
        console.debug('[sdk-ui] retryMessage -> client.sendMessage done', {
          clientMsgId,
          ok: true,
        });
        emitStateChanged();
        return { ok: true, messageId, clientMsgId };
      } catch (err) {
        awaitingAnswer = false;
        console.debug('[sdk-ui] retryMessage -> client.sendMessage failed', {
          clientMsgId,
          error: err instanceof Error ? err.message : String(err),
        });
        const sendError = err instanceof Error ? err.message : 'Message was not sent';
        transcriptStore.upsertLocalMessage({ ...updated, deliveryStatus: 'failed', retryable: true, sendError });
        emitStateChanged();
        return { ok: false, messageId, clientMsgId, error: sendError };
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
