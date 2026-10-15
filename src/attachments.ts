import type { ChatAttachment, ChatMessageViewModel, CortexTransportMessage } from './types.js';
import { asNonEmptyString, asPayload, isRecord, turnRef } from './utils.js';

// Public session-file descriptor contract: @cortex-suite/sdk
// contracts/session_file_attachments_v1.json (SDK #2).
const FILE_REF_PATTERN = /^sf_[A-Za-z0-9][A-Za-z0-9_-]*$/;
const OWNER_ROLES = new Set(['user', 'assistant', 'operator', 'system']);
const DIRECTIONS = new Set(['inbound', 'outbound', 'internal']);
const STATES = new Set(['available', 'expired', 'deleted', 'quarantined']);
const MESSAGE_REF_KINDS = new Set(['client_msg_id', 'turn']);
// EA public attachment ceiling per message (SDK MAX_ATTACHMENTS_PER_MESSAGE).
const MAX_ATTACHMENTS_PER_MESSAGE = 8;
// An identity field must never carry an internal File Layer identity.
const INTERNAL_VALUE_PREFIXES = ['fi_', 'sn_'];

interface AttachmentBinding {
  ownerRole: 'user' | 'assistant';
  direction: 'inbound' | 'outbound';
  messageRefKind: 'client_msg_id' | 'turn';
  messageRef: string | null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isPublicIdentity(value: unknown): value is string {
  return isNonEmptyString(value) && !INTERNAL_VALUE_PREFIXES.some((prefix) => value.startsWith(prefix));
}

function isSize(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Explicit public projection of one server-confirmed session-file descriptor.
 * Only the nine public fields survive; a descriptor with a missing or invalid
 * public field is not a public file and yields null.
 */
export function parsePublicAttachment(value: unknown): ChatAttachment | null {
  if (!isRecord(value)) return null;
  const {
    file_ref: fileRef, filename, content_type: contentType, size,
    owner_role: ownerRole, direction, state, message_ref: messageRef, message_ref_kind: messageRefKind,
  } = value;
  if (typeof fileRef !== 'string' || !FILE_REF_PATTERN.test(fileRef)) return null;
  if (!isNonEmptyString(filename) || !isNonEmptyString(contentType) || !isSize(size)) return null;
  if (typeof ownerRole !== 'string' || !OWNER_ROLES.has(ownerRole)) return null;
  if (typeof direction !== 'string' || !DIRECTIONS.has(direction)) return null;
  if (typeof state !== 'string' || !STATES.has(state)) return null;
  const attachment: ChatAttachment = {
    file_ref: fileRef,
    filename,
    content_type: contentType,
    size,
    owner_role: ownerRole as ChatAttachment['owner_role'],
    direction: direction as ChatAttachment['direction'],
    state: state as ChatAttachment['state'],
  };
  if (messageRef !== undefined && messageRef !== null) {
    if (!isPublicIdentity(messageRef)) return null;
    attachment.message_ref = messageRef;
  }
  if (messageRefKind !== undefined && messageRefKind !== null) {
    if (typeof messageRefKind !== 'string' || !MESSAGE_REF_KINDS.has(messageRefKind)) return null;
    attachment.message_ref_kind = messageRefKind as ChatAttachment['message_ref_kind'];
  }
  return attachment;
}

/**
 * Not-yet-confirmed attachment of a locally sent user message: a canonical sf_
 * reference plus the caller's optional display metadata, nothing else.
 */
function parsePendingAttachment(value: unknown): ChatAttachment | null {
  if (typeof value === 'string') return FILE_REF_PATTERN.test(value) ? { file_ref: value } : null;
  if (!isRecord(value)) return null;
  if (value['owner_role'] !== undefined) return parsePublicAttachment(value);
  const fileRef = value['file_ref'];
  if (typeof fileRef !== 'string' || !FILE_REF_PATTERN.test(fileRef)) return null;
  const attachment: ChatAttachment = { file_ref: fileRef };
  if (isNonEmptyString(value['filename'])) attachment.filename = value['filename'];
  if (isNonEmptyString(value['content_type'])) attachment.content_type = value['content_type'];
  if (isSize(value['size'])) attachment.size = value['size'];
  return attachment;
}

// Exact ownership: both binding fields present and equal to the message's
// trusted identity. A message without a trusted identity owns no files.
function belongsTo(attachment: ChatAttachment, binding: AttachmentBinding | null): boolean {
  return binding !== null
    && binding.messageRef !== null
    && attachment.owner_role === binding.ownerRole
    && attachment.direction === binding.direction
    && attachment.message_ref_kind === binding.messageRefKind
    && attachment.message_ref === binding.messageRef;
}

function project(
  raw: unknown,
  parse: (value: unknown) => ChatAttachment | null,
  accept: (attachment: ChatAttachment) => boolean,
): ChatAttachment[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const result: ChatAttachment[] = [];
  for (const item of raw) {
    if (result.length >= MAX_ATTACHMENTS_PER_MESSAGE) break;
    const attachment = parse(item);
    if (!attachment || seen.has(attachment.file_ref) || !accept(attachment)) continue;
    seen.add(attachment.file_ref);
    result.push(attachment);
  }
  return result;
}

function transportBinding(message: CortexTransportMessage): AttachmentBinding | null {
  const payload = asPayload(message);
  if (message.type === 'chat::answer' || message.type === 'chat::partial') {
    return { ownerRole: 'assistant', direction: 'outbound', messageRefKind: 'turn', messageRef: turnRef(payload) };
  }
  if (message.type === 'chat::echo' || message.type === 'chat::message') {
    const meta = isRecord(payload['meta']) ? payload['meta'] : {};
    return {
      ownerRole: 'user', direction: 'inbound', messageRefKind: 'client_msg_id',
      messageRef: asNonEmptyString(meta['client_msg_id']),
    };
  }
  return null;
}

/**
 * Public attachments a transport message owns, from the canonical
 * `payload.meta.attachments` only, in server order, at most 8. An answer keeps
 * only assistant/outbound files bound to String(turn); a user message only
 * user/inbound files bound to its client_msg_id. Both binding fields must be
 * present and match exactly; an answer without turn, a user message without
 * client_msg_id and every other message type own no files.
 */
export function projectTransportAttachments(message: CortexTransportMessage): ChatAttachment[] {
  const payload = asPayload(message);
  const meta = isRecord(payload['meta']) ? payload['meta'] : {};
  const binding = transportBinding(message);
  return project(meta['attachments'], parsePublicAttachment, (attachment) => belongsTo(attachment, binding));
}

function viewBinding(message: ChatMessageViewModel): AttachmentBinding | null {
  const meta = message.meta ?? {};
  if (message.type === 'chat::answer' || message.type === 'chat::partial') {
    return { ownerRole: 'assistant', direction: 'outbound', messageRefKind: 'turn', messageRef: asNonEmptyString(meta['turnRef']) };
  }
  if (message.type === 'chat::echo' || message.type === 'chat::message') {
    return {
      ownerRole: 'user', direction: 'inbound', messageRefKind: 'client_msg_id',
      messageRef: message.clientMsgId ?? asNonEmptyString(meta['client_msg_id']),
    };
  }
  return null;
}

/**
 * Re-project `meta.attachments` of a view model (local, persisted or restored).
 * A local user message may hold pending refs (no owner_role) that the server
 * has not confirmed yet; every confirmed descriptor must be bound exactly to
 * the message (answers by meta.turnRef, user messages by client_msg_id).
 */
export function projectViewAttachments(message: ChatMessageViewModel): ChatMessageViewModel {
  const meta = message.meta;
  if (!meta || !('attachments' in meta)) return message;
  const binding = viewBinding(message);
  const pendingAllowed = message.type === 'chat::message' && message.role === 'user';
  const attachments = project(
    meta['attachments'],
    pendingAllowed ? parsePendingAttachment : parsePublicAttachment,
    (attachment) => (pendingAllowed && attachment.owner_role === undefined)
      || belongsTo(attachment, binding),
  );
  const nextMeta = { ...meta };
  if (attachments.length > 0) nextMeta['attachments'] = attachments;
  else delete nextMeta['attachments'];
  return { ...message, meta: nextMeta };
}

/** Optimistic attachments for a message the user is sending. */
export function pendingAttachments(attachments: unknown[] | undefined): ChatAttachment[] {
  return project(attachments, parsePendingAttachment, () => true);
}

/**
 * Merge a later delivery of the same message into what is already known:
 * every file keeps its first position, a re-delivered file takes the newer
 * descriptor (for example a changed state), new files are appended, and a
 * delivery without attachments never erases accepted ones.
 */
export function mergeAttachments(existing: unknown, incoming: unknown): ChatAttachment[] {
  const merged: ChatAttachment[] = Array.isArray(existing) ? [...existing as ChatAttachment[]] : [];
  const positions = new Map(merged.map((attachment, index) => [attachment.file_ref, index]));
  for (const attachment of Array.isArray(incoming) ? incoming as ChatAttachment[] : []) {
    const index = positions.get(attachment.file_ref);
    if (index === undefined) {
      positions.set(attachment.file_ref, merged.length);
      merged.push(attachment);
    } else {
      merged[index] = attachment;
    }
  }
  return merged;
}

/** Shallow meta merge that treats `attachments` with mergeAttachments. */
export function mergeMessageMeta(
  existing: Record<string, unknown> | undefined,
  incoming: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...(existing ?? {}), ...(incoming ?? {}) };
  const attachments = mergeAttachments(existing?.['attachments'], incoming?.['attachments']);
  if (attachments.length > 0) merged['attachments'] = attachments;
  else delete merged['attachments'];
  return merged;
}
