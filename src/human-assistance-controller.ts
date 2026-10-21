import { createControllerError } from './errors.js';
import type {
  HumanAssistanceCard, HumanAssistanceClientLike, HumanAssistanceController,
  HumanAssistanceNotification, HumanAssistanceRequest, ReplyHumanAssistanceOptions,
  QuestionField,
} from './types.js';

const MAX_REQUESTS = 64;
const TERMINAL = new Set(['resolved', 'expired', 'revoked', 'delivery_failed']);

interface Entry {
  card: HumanAssistanceCard;
  submission: ReplyHumanAssistanceOptions | null;
  inFlight: boolean;
}

export interface HumanAssistanceControllerOptions {
  client: HumanAssistanceClientLike;
  /** Defaults to crypto.randomUUID; injectable for deterministic tests. */
  createClientReplyId?: () => string;
}

function fields(request: HumanAssistanceRequest): QuestionField[] {
  const result: QuestionField[] = [];
  if (request.options.length) {
    result.push({ key: 'option_id', label: request.question, type: 'select',
      required: !request.allow_text, options: request.options.map((option) => ({ ...option })) });
  }
  if (request.allow_text) {
    result.push({ key: 'text', label: request.question, type: 'text',
      required: !request.options.length, options: [] });
  }
  return result;
}

function copyCard(card: HumanAssistanceCard): HumanAssistanceCard {
  return {
    ...card,
    request: { ...card.request, options: card.request.options.map((option) => ({ ...option })) },
    fields: card.fields.map((field) => ({ ...field, options: field.options.map((option) => ({ ...option })) })),
  };
}

export function createHumanAssistanceController(options: HumanAssistanceControllerOptions): HumanAssistanceController {
  const entries = new Map<string, Entry>();
  const tombstones = new Set<string>();
  const listeners = new Set<(cards: HumanAssistanceCard[]) => void>();
  const createId = options.createClientReplyId ?? (() => crypto.randomUUID());
  let overflow = false;
  let destroyed = false;

  function cards(): HumanAssistanceCard[] {
    return [...entries.values()].map((entry) => copyCard(entry.card));
  }

  function emit(): void {
    const snapshot = cards();
    for (const listener of listeners) listener(snapshot.map(copyCard));
  }

  function rememberTerminal(requestId: string): void {
    if (tombstones.has(requestId)) return;
    if (tombstones.size >= MAX_REQUESTS) { overflow = true; return; }
    tombstones.add(requestId);
  }

  function ingestRequest(request: HumanAssistanceRequest): void {
    if (overflow || tombstones.has(request.request_id) || entries.has(request.request_id)) return;
    if (entries.size >= MAX_REQUESTS) {
      const terminal = [...entries].find(([, entry]) => TERMINAL.has(entry.card.status));
      if (terminal) { rememberTerminal(terminal[0]); entries.delete(terminal[0]); }
    }
    if (overflow || entries.size >= MAX_REQUESTS) return;
    const owned = { ...request, options: request.options.map((option) => ({ ...option })) };
    entries.set(request.request_id, {
      card: { request: owned, fields: fields(owned), optionId: null, text: '', status: 'pending', clientReplyId: null },
      submission: null, inFlight: false,
    });
    emit();
  }

  function ingest(event: HumanAssistanceNotification): void {
    if (destroyed) return;
    if (event.type === 'human_assistance::request') { ingestRequest(event.payload); return; }
    const status = event.payload;
    const entry = entries.get(status.request_id);
    if (!entry) {
      if (TERMINAL.has(status.status)) rememberTerminal(status.request_id);
      return;
    }
    if (TERMINAL.has(entry.card.status)) return;
    if (status.status === 'resolved' || status.status === 'expired'
        || status.status === 'revoked' || status.status === 'delivery_failed') {
      entry.card.status = status.status;
      entry.card.error = undefined;
      emit();
      return;
    }
    if (!entry.submission || entry.submission.clientReplyId !== status.client_reply_id) return;
    if (entry.card.status === 'accepted' || entry.card.status === 'rejected') return;
    entry.card.status = status.status === 'reply_accepted' ? 'accepted' : 'rejected';
    entry.card.reason = status.reason;
    entry.card.error = status.status === 'reply_rejected' ? status.reason : undefined;
    emit();
  }

  function pending(requestId: string): Entry {
    const entry = entries.get(requestId);
    if (!entry || entry.card.status !== 'pending')
      throw createControllerError('ha_request_inactive', 'Human Assistance request is not pending.', 'human_assistance');
    if (Date.now() >= Date.parse(entry.card.request.deadline_at)) {
      entry.card.error = 'Human Assistance request has expired.';
      emit();
      throw createControllerError('ha_request_expired', 'Human Assistance request has expired.', 'human_assistance');
    }
    return entry;
  }

  async function send(entry: Entry): Promise<void> {
    if (!entry.submission || entry.inFlight)
      throw createControllerError('ha_send_unavailable', 'Human Assistance reply cannot be sent.', 'human_assistance');
    entry.inFlight = true;
    entry.card.error = undefined;
    entry.card.status = 'sent';
    emit();
    try {
      await options.client.replyHumanAssistance({ ...entry.submission });
    } catch (error) {
      if (entry.card.status === 'sent') entry.card.error = error instanceof Error ? error.message : 'HA reply failed';
      emit();
      throw error;
    } finally {
      entry.inFlight = false;
    }
  }

  function begin(requestId: string, action: 'answer' | 'refuse'): Promise<void> {
    const entry = pending(requestId);
    const optionId = entry.card.optionId;
    const text = entry.card.text.trim();
    if (action === 'answer' && !optionId && !text) {
      entry.card.error = 'Choose an option or enter text.';
      emit();
      throw createControllerError('ha_answer_empty', 'Choose an option or enter text.', 'human_assistance');
    }
    const clientReplyId = createId();
    entry.submission = {
      requestId, clientReplyId, action,
      ...(action === 'answer' && optionId ? { optionId } : {}),
      ...(action === 'answer' && text ? { text } : {}),
    };
    entry.card.clientReplyId = clientReplyId;
    return send(entry);
  }

  const unsubscribe = options.client.onHumanAssistance(ingest);
  for (const request of options.client.humanAssistanceRequests) ingestRequest(request);

  return {
    getCards: cards,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    sync() { if (!destroyed) for (const request of options.client.humanAssistanceRequests) ingestRequest(request); },
    selectOption(requestId, optionId) {
      const entry = pending(requestId);
      if (optionId !== null && !entry.card.request.options.some((option) => option.id === optionId)) {
        entry.card.error = 'Unknown Human Assistance option.';
        emit();
        throw createControllerError('ha_option_invalid', 'Unknown Human Assistance option.', 'human_assistance');
      }
      entry.card.optionId = optionId;
      entry.card.error = undefined;
      emit();
    },
    setText(requestId, text) {
      const entry = pending(requestId);
      if (!entry.card.request.allow_text || typeof text !== 'string' || text.length > 4096) {
        entry.card.error = 'Text is not allowed or is too long.';
        emit();
        throw createControllerError('ha_text_invalid', 'Text is not allowed or is too long.', 'human_assistance');
      }
      entry.card.text = text;
      entry.card.error = undefined;
      emit();
    },
    submit(requestId) { return begin(requestId, 'answer'); },
    refuse(requestId) { return begin(requestId, 'refuse'); },
    retry(requestId) {
      const entry = entries.get(requestId);
      if (!entry?.submission || entry.card.status !== 'sent' || entry.inFlight)
        throw createControllerError('ha_retry_unavailable', 'Human Assistance reply cannot be retried.', 'human_assistance');
      if (Date.now() >= Date.parse(entry.card.request.deadline_at)) {
        entry.card.error = 'Human Assistance request has expired.';
        emit();
        throw createControllerError('ha_request_expired', 'Human Assistance request has expired.', 'human_assistance');
      }
      return send(entry);
    },
    reset() { entries.clear(); tombstones.clear(); overflow = false; emit(); },
    destroy() { if (destroyed) return; destroyed = true; unsubscribe(); entries.clear(); tombstones.clear(); listeners.clear(); },
  };
}
