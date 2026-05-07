import type {
  ChatMessageRole,
  ChatMessageViewModel,
  CortexTransportMessage,
  EscalationAction,
  EscalationState,
} from './types.js';

export const TERMINAL_SESSION_STATES = new Set([
  'COMPLETED',
  'FAILED',
  'STOPPED',
  'TIMEOUT',
  'CANCELLED',
]);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asPayload(message: CortexTransportMessage): Record<string, unknown> {
  return isRecord(message.payload) ? message.payload : {};
}

export function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

export function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => entry !== '');
}

export function buildMessageId(message: CortexTransportMessage, fallbackPrefix?: string): string {
  const payload = asPayload(message);
  const turnId = asNonEmptyString(payload['turn_id']);
  if (turnId && (message.type === 'chat::partial' || message.type === 'chat::answer')) {
    return `turn:${turnId}`;
  }

  const escalationId = asNonEmptyString(payload['escalation_id']);
  if (escalationId && message.type === 'escalation::request') {
    return `escalation:${escalationId}`;
  }
  if (escalationId && message.type === 'escalation::reply') {
    const action = asNonEmptyString(payload['action']) ?? 'reply';
    const seqSuffix = typeof message.seq === 'number' ? String(message.seq) : asNonEmptyString(message.ts) ?? 'unknown';
    return `escalation-reply:${escalationId}:${action}:${seqSuffix}`;
  }

  if (typeof message.seq === 'number') {
    return `seq:${message.seq}`;
  }
  if (asNonEmptyString(message.session_id) && asNonEmptyString(message.ts)) {
    return `${message.session_id}:${message.type}:${message.ts}`;
  }
  if (asNonEmptyString(message.ts)) {
    return `${message.type}:${message.ts}`;
  }
  return `${fallbackPrefix ?? message.type}:unknown`;
}

export function mapRole(value: unknown, fallback: ChatMessageRole): ChatMessageRole {
  switch (value) {
    case 'user':
    case 'assistant':
    case 'system':
    case 'operator':
    case 'escalation':
    case 'error':
      return value;
    default:
      return fallback;
  }
}

export function cloneMessage(message: ChatMessageViewModel): ChatMessageViewModel {
  return {
    ...message,
    meta: message.meta ? { ...message.meta } : undefined,
  };
}

export function cloneEscalation(state: EscalationState | null): EscalationState | null {
  if (!state) {
    return null;
  }
  return {
    ...state,
    allowedActions: [...state.allowedActions],
  };
}

export function toEscalationActions(value: unknown): EscalationAction[] {
  return asStringArray(value).filter((action): action is EscalationAction => (
    action === 'continue'
    || action === 'operator_input'
    || action === 'reply_user'
  ));
}
