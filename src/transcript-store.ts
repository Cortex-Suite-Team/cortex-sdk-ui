import { createChatError } from './errors.js';
import { normalizeCortexMessage } from './normalize.js';
import type {
  ChatMessageViewModel,
  CortexTransportMessage,
  TranscriptStore,
  TranscriptStoreOptions,
  TranscriptStoreResult,
} from './types.js';
import {
  asNonEmptyString,
  asPayload,
  cloneMessage,
  isRecord,
} from './utils.js';

function isUserSafeSystemError(message: CortexTransportMessage): boolean {
  const payload = asPayload(message);
  const meta = isRecord(payload['meta']) ? payload['meta'] : null;
  return meta?.['user_safe'] === true;
}

function shouldStoreInTranscript(message: CortexTransportMessage): boolean {
  if (message.type === 'system::error') {
    return isUserSafeSystemError(message);
  }
  return !message.type.startsWith('system::');
}

export function createTranscriptStore(options: TranscriptStoreOptions = {}): TranscriptStore {
  const transcript = (options.initialTranscript ?? []).map((message) => cloneMessage(message));
  const indexById = new Map<string, number>();
  const listeners = new Set<(transcript: ChatMessageViewModel[]) => void>();

  for (const [index, message] of transcript.entries()) {
    indexById.set(message.id, index);
  }

  function snapshot(): ChatMessageViewModel[] {
    return transcript.map((message) => cloneMessage(message));
  }

  function notify() {
    const nextSnapshot = snapshot();
    for (const listener of Array.from(listeners)) {
      listener(nextSnapshot);
    }
  }

  function addMessage(message: ChatMessageViewModel): TranscriptStoreResult {
    transcript.push(message);
    indexById.set(message.id, transcript.length - 1);
    notify();
    return {
      transcript: snapshot(),
      mutation: {
        type: 'message_added',
        message: cloneMessage(message),
      },
    };
  }

  function updateMessage(index: number, message: ChatMessageViewModel): TranscriptStoreResult {
    const previous = transcript[index];
    transcript[index] = message;
    if (previous && previous.id !== message.id) {
      indexById.delete(previous.id);
    }
    indexById.set(message.id, index);
    notify();
    return {
      transcript: snapshot(),
      mutation: {
        type: 'message_updated',
        message: cloneMessage(message),
      },
    };
  }

  function isReconcileableOutgoingUserMessage(
    message: ChatMessageViewModel,
    clientMsgId: string,
  ): boolean {
    const originalPayloadMeta = isRecord(message.originalPayload?.meta)
      ? message.originalPayload.meta
      : null;

    return (
      message.id.startsWith('client:')
      && message.type === 'chat::message'
      && message.role === 'user'
      && message.clientMsgId === clientMsgId
      && (
        message.deliveryStatus === 'sending'
        || message.deliveryStatus === 'sent'
        || message.deliveryStatus === 'failed'
      )
      && originalPayloadMeta?.['client_msg_id'] === clientMsgId
    );
  }

  function findReconcileableOutgoingUserMessageIndex(clientMsgId: string | undefined): number | undefined {
    if (!clientMsgId) {
      return undefined;
    }
    for (const [index, message] of transcript.entries()) {
      if (isReconcileableOutgoingUserMessage(message, clientMsgId)) {
        return index;
      }
    }
    return undefined;
  }

  function reconcileOptimisticUserMessage(
    existing: ChatMessageViewModel,
    normalized: ChatMessageViewModel,
  ): ChatMessageViewModel {
    const hasServerTs = normalized.ts !== null && normalized.ts !== undefined;
    const nextMeta: Record<string, unknown> = {
      ...(existing.meta ?? {}),
      ...(normalized.meta ?? {}),
      timestamp_source: hasServerTs ? 'server' : existing.meta?.['timestamp_source'],
      echo_seq: normalized.seq ?? existing.meta?.['echo_seq'],
      echo_type: 'chat::echo',
      echo_ts: normalized.ts ?? existing.meta?.['echo_ts'],
    };

    return {
      ...existing,
      id: existing.id,
      type: existing.type,
      role: 'user',
      content: existing.content,
      seq: normalized.seq ?? existing.seq ?? null,
      ts: normalized.ts ?? existing.ts ?? null,
      clientMsgId: existing.clientMsgId ?? normalized.clientMsgId,
      deliveryStatus: 'processed',
      retryable: false,
      sendError: undefined,
      originalPayload: existing.originalPayload,
      meta: nextMeta,
    };
  }

  function buildMalformedPartialMessage(message: CortexTransportMessage): TranscriptStoreResult {
    const error = createChatError(
      'partial_missing_turn_id',
      'chat::partial is missing payload.turn_id',
      'chat::partial',
      { type: message.type },
    );

    const fallbackMessage: ChatMessageViewModel = {
      id: normalizeCortexMessage({
        ...message,
        type: 'system::error',
        payload: {
          code: error.code,
          message: error.message,
        },
      }).id,
      seq: message.seq ?? null,
      type: message.type,
      role: 'error',
      content: error.message,
      status: 'error',
      ts: message.ts ?? null,
      meta: {
        code: error.code,
        rawType: message.type,
      },
    };

    const result = addMessage(fallbackMessage);
    return {
      ...result,
      error,
    };
  }

  return {
    getSnapshot() {
      return snapshot();
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    ingest(message) {
      if (!shouldStoreInTranscript(message)) {
        return {
          transcript: snapshot(),
        };
      }

      const payload = asPayload(message);

      if (message.type === 'chat::partial' && !asNonEmptyString(payload['turn_id'])) {
        return buildMalformedPartialMessage(message);
      }

      const normalized = normalizeCortexMessage(message);
      const optimisticIndex = message.type === 'chat::echo' && normalized.role === 'user'
        ? findReconcileableOutgoingUserMessageIndex(normalized.clientMsgId)
        : undefined;
      const existingIndex = indexById.get(normalized.id);

      if (message.type === 'chat::echo' && normalized.role === 'user') {
        if (optimisticIndex !== undefined) {
          const existing = transcript[optimisticIndex];
          return updateMessage(optimisticIndex, reconcileOptimisticUserMessage(existing, normalized));
        }

        return addMessage({
          ...normalized,
          role: 'user',
          deliveryStatus: 'processed',
          retryable: false,
        });
      }

      if (message.type === 'chat::partial' && existingIndex !== undefined) {
        const existing = transcript[existingIndex];
        const nextMessage: ChatMessageViewModel = {
          ...existing,
          seq: normalized.seq,
          type: normalized.type,
          role: normalized.role,
          status: 'streaming',
          ts: normalized.ts,
          content: typeof existing.content === 'string' && typeof normalized.content === 'string'
            ? `${existing.content}${normalized.content}`
            : normalized.content,
          meta: {
            ...(existing.meta ?? {}),
            ...(normalized.meta ?? {}),
          },
        };
        return updateMessage(existingIndex, nextMessage);
      }

      if (message.type === 'chat::answer' && existingIndex !== undefined) {
        const existing = transcript[existingIndex];
        const nextMessage: ChatMessageViewModel = {
          ...existing,
          seq: normalized.seq,
          type: normalized.type,
          role: normalized.role,
          content: normalized.content,
          status: 'final',
          ts: normalized.ts,
          meta: {
            ...(existing.meta ?? {}),
            ...(normalized.meta ?? {}),
          },
        };
        return updateMessage(existingIndex, nextMessage);
      }

      if (existingIndex !== undefined) {
        return updateMessage(existingIndex, normalized);
      }

      return addMessage(normalized);
    },

    reset() {
      transcript.length = 0;
      indexById.clear();
      notify();
    },

    upsertLocalMessage(message: ChatMessageViewModel): TranscriptStoreResult {
      const existingIndex = indexById.get(message.id);
      if (existingIndex !== undefined) {
        return updateMessage(existingIndex, message);
      }
      return addMessage(message);
    },
  };
}
