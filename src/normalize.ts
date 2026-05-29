import type {
  ChatActor,
  ChatActorKind,
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

function buildAttachmentMeta(payload: Record<string, unknown>): Record<string, unknown> {
  return Array.isArray(payload['attachments'])
    ? { attachments: payload['attachments'] }
    : {};
}

function getClientMsgId(meta: Record<string, unknown>): string | undefined {
  return asNonEmptyString(meta['client_msg_id']) ?? undefined;
}

function resolveVisibleContent(payload: Record<string, unknown>): unknown {
  if (payload['content'] !== undefined) {
    return payload['content'];
  }

  const message = payload['message'];
  if (isRecord(message) && message['text'] !== undefined) {
    return message['text'];
  }

  return message ?? null;
}

function withoutInternalRefs(meta: Record<string, unknown>): Record<string, unknown> {
  const cleaned = { ...meta };
  delete cleaned['resume_event_ref'];
  return cleaned;
}

const KNOWN_ACTOR_KINDS: ReadonlySet<string> = new Set(['user', 'operator', 'digital_worker', 'system']);

function extractActor(
  message: CortexTransportMessage,
  payload: Record<string, unknown>,
): ChatActor | null {
  // Explicit priority: payload.meta.actor > payload.actor > message.meta.actor
  const payloadMeta = isRecord(payload['meta']) ? payload['meta'] as Record<string, unknown> : undefined;
  const messageMeta = isRecord(message.meta) ? message.meta as Record<string, unknown> : undefined;

  const raw =
    (isRecord(payloadMeta?.['actor']) ? payloadMeta!['actor'] as Record<string, unknown> : null) ??
    (isRecord(payload['actor']) ? payload['actor'] as Record<string, unknown> : null) ??
    (isRecord(messageMeta?.['actor']) ? messageMeta!['actor'] as Record<string, unknown> : null);

  if (!raw) return null;

  const kind = asNonEmptyString(raw['kind']);
  const name = asNonEmptyString(raw['name']);

  if (!kind || !name || !KNOWN_ACTOR_KINDS.has(kind)) return null;

  return {
    kind: kind as ChatActorKind,
    id: asNonEmptyString(raw['id']) ?? null,
    name,
    title: asNonEmptyString(raw['title']) ?? null,
    subtitle: asNonEmptyString(raw['subtitle']) ?? null,
    avatarUrl: asNonEmptyString(raw['avatarUrl']) ?? asNonEmptyString(raw['avatar_url']) ?? null,
  };
}

export function normalizeCortexMessage(message: CortexTransportMessage): ChatMessageViewModel {
  const payload = asPayload(message);
  const payloadMeta = isRecord(payload['meta']) ? payload['meta'] : undefined;
  const mergedMeta: Record<string, unknown> = withoutInternalRefs({
    ...(isRecord(message.meta) ? message.meta : {}),
    ...(payloadMeta ?? {}),
  });

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
        actor: null,
        clientMsgId: getClientMsgId(mergedMeta),
        meta: {
          ...mergedMeta,
          ...buildAttachmentMeta(payload),
        },
      };

    case 'chat::echo':
      return {
        id: buildMessageId(message, 'echo'),
        seq: message.seq ?? null,
        type: message.type,
        role: mapRole(payload['role'], 'user'),
        content: resolveVisibleContent(payload),
        status: 'final',
        ts: message.ts ?? null,
        actor: extractActor(message, payload),
        clientMsgId: getClientMsgId(mergedMeta),
        meta: {
          ...mergedMeta,
          ...buildAttachmentMeta(payload),
          ...(asNonEmptyString(payload['turn_id']) ? { turnId: asNonEmptyString(payload['turn_id']) } : {}),
        },
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
        actor: extractActor(message, payload),
        meta: {
          ...mergedMeta,
          ...buildAttachmentMeta(payload),
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
        actor: extractActor(message, payload),
        meta: {
          ...mergedMeta,
          ...buildAttachmentMeta(payload),
          ...(asNonEmptyString(payload['turn_id']) ? { turnId: asNonEmptyString(payload['turn_id']) } : {}),
          ...(asNonEmptyString(payload['answer_kind']) ? { answerKind: asNonEmptyString(payload['answer_kind']) } : {}),
        },
      };

    case 'chat::forward':
    case 'chat::hail':
      return {
        id: buildMessageId(message, message.type === 'chat::forward' ? 'forward' : 'hail'),
        seq: message.seq ?? null,
        type: message.type,
        role: mapRole(payload['role'], 'assistant'),
        content: resolveVisibleContent(payload),
        status: 'final',
        ts: message.ts ?? null,
        actor: extractActor(message, payload),
        clientMsgId: getClientMsgId(mergedMeta),
        meta: {
          ...mergedMeta,
          ...buildAttachmentMeta(payload),
          ...(asNonEmptyString(payload['turn_id']) ? { turnId: asNonEmptyString(payload['turn_id']) } : {}),
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
        actor: null,
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
        actor: extractActor(message, payload),
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
        content: asNonEmptyString(payload['message']) ?? 'Runtime error',
        status: 'error',
        ts: message.ts ?? null,
        actor: null,
        meta: {
          ...mergedMeta,
          code: asNonEmptyString(payload['code']) ?? undefined,
        },
      };

    case 'chat::question':
      return {
        id: buildMessageId(message, 'question'),
        seq: message.seq ?? null,
        type: message.type,
        role: mapRole(payload['role'], 'assistant'),
        content: payload['content'],
        status: 'final',
        ts: message.ts ?? null,
        actor: extractActor(message, payload),
        meta: {
          ...mergedMeta,
          ...(asNonEmptyString(payload['turn_id']) ? { turnId: asNonEmptyString(payload['turn_id']) } : {}),
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
        actor: null,
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
        actor: null,
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
