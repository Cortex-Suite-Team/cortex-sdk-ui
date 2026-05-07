import type {
  ChatMessageViewModel,
  CortexTransportMessage,
  EscalationState,
} from './types.js';
import {
  asNonEmptyString,
  asPayload,
  buildMessageId,
  isRecord,
  mapRole,
  toEscalationActions,
} from './utils.js';

export function normalizeCortexMessage(message: CortexTransportMessage): ChatMessageViewModel {
  const payload = asPayload(message);
  const payloadMeta = isRecord(payload['meta']) ? payload['meta'] : undefined;
  const mergedMeta: Record<string, unknown> = {
    ...(isRecord(message.meta) ? message.meta : {}),
    ...(payloadMeta ?? {}),
  };

  switch (message.type) {
    case 'chat::message':
      return {
        id: buildMessageId(message),
        seq: message.seq ?? null,
        type: message.type,
        role: mapRole(payload['role'], 'user'),
        content: payload['content'],
        status: 'final',
        ts: message.ts ?? null,
        meta: mergedMeta,
      };

    case 'chat::partial':
      return {
        id: buildMessageId(message, 'partial'),
        seq: message.seq ?? null,
        type: message.type,
        role: mapRole(payload['role'], 'assistant'),
        content: payload['content'],
        status: 'streaming',
        ts: message.ts ?? null,
        meta: {
          ...mergedMeta,
          ...(asNonEmptyString(payload['turn_id']) ? { turnId: asNonEmptyString(payload['turn_id']) } : {}),
        },
      };

    case 'chat::answer':
      return {
        id: buildMessageId(message, 'answer'),
        seq: message.seq ?? null,
        type: message.type,
        role: mapRole(payload['role'], 'assistant'),
        content: payload['content'],
        status: 'final',
        ts: message.ts ?? null,
        meta: {
          ...mergedMeta,
          ...(asNonEmptyString(payload['turn_id']) ? { turnId: asNonEmptyString(payload['turn_id']) } : {}),
          ...(asNonEmptyString(payload['answer_kind']) ? { answerKind: asNonEmptyString(payload['answer_kind']) } : {}),
        },
      };

    case 'escalation::request':
      return {
        id: buildMessageId(message, 'escalation'),
        seq: message.seq ?? null,
        type: message.type,
        role: 'escalation',
        content: payload['content'] ?? payload['message'] ?? payload['reason'] ?? payload,
        status: 'final',
        ts: message.ts ?? null,
        meta: {
          ...mergedMeta,
          escalationId: asNonEmptyString(payload['escalation_id']),
          reason: asNonEmptyString(payload['reason']) ?? undefined,
          message: asNonEmptyString(payload['message']) ?? undefined,
          waitToken: asNonEmptyString(payload['wait_token']) ?? undefined,
          allowedActions: toEscalationActions(payload['allowed_actions']),
        },
      };

    case 'escalation::reply':
      return {
        id: buildMessageId(message, 'escalation-reply'),
        seq: message.seq ?? null,
        type: message.type,
        role: 'operator',
        content: payload['content'] ?? payload,
        status: 'final',
        ts: message.ts ?? null,
        meta: {
          ...mergedMeta,
          escalationId: asNonEmptyString(payload['escalation_id']),
          action: asNonEmptyString(payload['action']) ?? undefined,
          waitToken: asNonEmptyString(payload['wait_token']) ?? undefined,
        },
      };

    case 'system::error':
      return {
        id: buildMessageId(message, 'system-error'),
        seq: message.seq ?? null,
        type: message.type,
        role: 'error',
        content: payload['message'] ?? payload,
        status: 'error',
        ts: message.ts ?? null,
        meta: {
          ...mergedMeta,
          code: asNonEmptyString(payload['code']) ?? undefined,
        },
      };

    case 'sandbox::snapshot':
    case 'sandbox::lifecycle':
      return {
        id: buildMessageId(message),
        seq: message.seq ?? null,
        type: message.type,
        role: 'system',
        content: payload,
        status: 'final',
        ts: message.ts ?? null,
        meta: mergedMeta,
      };

    default:
      return {
        id: buildMessageId(message, 'unknown'),
        seq: message.seq ?? null,
        type: message.type,
        role: 'system',
        content: payload,
        status: 'final',
        ts: message.ts ?? null,
        meta: {
          ...mergedMeta,
          rawType: message.type,
        },
      };
  }
}

export function normalizeEscalationState(message: CortexTransportMessage): EscalationState | null {
  if (message.type !== 'escalation::request') {
    return null;
  }

  const payload = asPayload(message);
  const escalationId = asNonEmptyString(payload['escalation_id']);
  if (!escalationId) {
    return null;
  }

  return {
    escalationId,
    reason: asNonEmptyString(payload['reason']) ?? undefined,
    message: asNonEmptyString(payload['message']) ?? undefined,
    content: payload['content'],
    allowedActions: toEscalationActions(payload['allowed_actions']),
    waitToken: asNonEmptyString(payload['wait_token']) ?? undefined,
    status: 'pending',
  };
}
