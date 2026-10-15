/**
 * EA multi-file view-model contract (SDK UI #2).
 *
 * fixtures/session_file_attachments_v1.json is a verbatim copy of
 * Cortex-Suite-Team/cortex-sdk@77a43c2 contracts/session_file_attachments_v1.json
 * (SDK #2). Source-level qualification only; the physical SessionManager /
 * File Link 3 -> 2 proof waits for Runtime #24.
 */
import { readFileSync } from 'node:fs';

import {
  TRANSCRIPT_SCHEMA_VERSION,
  createChatController,
  createTranscriptStore,
  normalizeCortexMessage,
  sanitizeTranscriptMessage,
} from '../src/index.js';
import type {
  ChatAttachment,
  ChatMessageViewModel,
  CortexTransportMessage,
  PersistedTranscript,
  PersistedTranscriptMessage,
  TranscriptPersistence,
} from '../src/index.js';
import { createMessage, createMockClient } from './helpers.js';

interface FixtureFile { descriptor: ChatAttachment & Record<string, unknown> }
const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/session_file_attachments_v1.json', import.meta.url), 'utf8'),
) as {
  client_msg_id: string;
  turn: number;
  turn_ref: string;
  inputs: FixtureFile[];
  outputs: FixtureFile[];
  messages: { chat_echo: Record<string, unknown>; chat_answer: Record<string, unknown> };
  hostile_descriptors: Array<{ name: string; input: unknown; expected: ChatAttachment | null }>;
  message_projection_cases: Array<{ name: string; type: string; payload: Record<string, unknown>; expected_refs: string[] }>;
};

const INPUTS = fixture.inputs.map((file) => file.descriptor as ChatAttachment);
const OUTPUTS = fixture.outputs.map((file) => file.descriptor as ChatAttachment);
const FORBIDDEN = /"(fi_|sn_)|file_id|snapshot_id|scope_type|scope_id|storage_key|ticket|download_mint_url|download_url|upload_path|"url"/;

function answer(attachments: unknown, seq = 20, extra: Record<string, unknown> = {}): CortexTransportMessage {
  return createMessage('chat::answer', { ...fixture.messages.chat_answer, ...extra, meta: { attachments } }, seq);
}

function echo(attachments: unknown, seq = 10, clientMsgId = fixture.client_msg_id): CortexTransportMessage {
  return createMessage('chat::echo', { ...fixture.messages.chat_echo, meta: { client_msg_id: clientMsgId, attachments } }, seq);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function attachmentsOf(message: ChatMessageViewModel | undefined): unknown {
  return message?.meta?.['attachments'];
}

class MemoryPersistence implements TranscriptPersistence {
  readonly records = new Map<string, PersistedTranscript>();

  async load(sessionKey: string): Promise<PersistedTranscript | null> {
    return this.records.get(sessionKey) ?? null;
  }

  async save(
    sessionKey: string,
    transcript: Omit<PersistedTranscript, 'messages'>,
    messages: readonly PersistedTranscriptMessage[],
  ): Promise<void> {
    const previous = this.records.get(sessionKey)?.messages ?? [];
    const ordered = new Map(previous.map((message, order) => [message.id, { order, message }]));
    for (const entry of messages) ordered.set(entry.message.id, entry);
    const merged = Array.from(ordered.values()).sort((a, b) => a.order - b.order).map((entry) => entry.message);
    this.records.set(sessionKey, JSON.parse(JSON.stringify({ ...transcript, messages: merged })) as PersistedTranscript);
  }

  async delete(sessionKey: string): Promise<void> {
    this.records.delete(sessionKey);
  }

  async purgeExpired(now: number): Promise<void> {
    for (const [key, record] of this.records) if (record.expiresAt <= now) this.records.delete(key);
  }
}

describe('attachment projection (shared SDK #2 vectors)', () => {
  it.each(fixture.hostile_descriptors.map((v) => [v.name, v] as const))('public projection: %s', (_name, vector) => {
    const normalized = normalizeCortexMessage(answer([vector.input]));
    expect(normalized.meta?.['attachments']).toEqual(vector.expected ? [vector.expected] : undefined);
  });

  it.each(fixture.message_projection_cases.map((v) => [v.name, v] as const))('message: %s', (_name, vector) => {
    const refsOf = (message: ChatMessageViewModel | undefined) => ((attachmentsOf(message) ?? []) as ChatAttachment[]).map((a) => a.file_ref);
    const normalized = normalizeCortexMessage(createMessage(vector.type, clone(vector.payload)));
    expect(refsOf(normalized)).toEqual(vector.expected_refs);

    // Same result once stored, persisted and restored.
    const store = createTranscriptStore();
    store.ingest(createMessage(vector.type, clone(vector.payload)));
    const stored = store.getSnapshot().at(-1);
    expect(refsOf(stored)).toEqual(vector.expected_refs);
    if (stored) {
      const restored = createTranscriptStore({ initialTranscript: [JSON.parse(JSON.stringify(sanitizeTranscriptMessage(stored)))] });
      expect(refsOf(restored.getSnapshot()[0])).toEqual(vector.expected_refs);
    }
  });

  it('identifies Runtime answers and partials by their integer turn', () => {
    const store = createTranscriptStore();
    store.ingest(createMessage('chat::partial', { content: ['Here'], role: 'assistant', turn: fixture.turn }, 19));
    store.ingest(answer(OUTPUTS, 20));
    const transcript = store.getSnapshot();
    expect(transcript.map((m) => m.id)).toEqual([`turn:${fixture.turn_ref}`]);
    expect(transcript[0]?.meta?.['turnRef']).toBe(fixture.turn_ref);
    expect(transcript[0]?.status).toBe('final');
    expect(attachmentsOf(transcript[0])).toEqual(OUTPUTS);
  });

  it('never takes attachments from legacy payload.attachments or envelope meta', () => {
    const message: CortexTransportMessage = {
      ...answer([]),
      meta: { attachments: OUTPUTS, file_id: 'fi_env', download_mint_url: '/mint' },
      payload: { ...fixture.messages.chat_answer, attachments: OUTPUTS, meta: { attachments: [] } },
    };
    const normalized = normalizeCortexMessage(message);
    expect(normalized.meta).not.toHaveProperty('attachments');
    expect(JSON.stringify(normalized)).not.toMatch(FORBIDDEN);
  });

  it('drops internal file handles from every meta level', () => {
    const normalized = normalizeCortexMessage(createMessage('chat::answer', {
      ...fixture.messages.chat_answer,
      meta: { snapshot_id: 'sn_1', delivery_ticket: 't', download_mint_url: '/m', billing: { summary: {} }, attachments: OUTPUTS },
    }));
    expect(normalized.meta).toMatchObject({ billing: { summary: {} }, attachments: OUTPUTS });
    expect(JSON.stringify(normalized)).not.toMatch(FORBIDDEN);
  });
});

describe('0 / 1 / 3 inbound and 0 / 1 / 2 outbound attachments', () => {
  it.each([0, 1, 3])('keeps %i user files on the echoed user message only, in order', (count) => {
    const store = createTranscriptStore();
    const files = INPUTS.slice(0, count);
    store.ingest(echo(files));
    const [message] = store.getSnapshot();
    expect(message?.role).toBe('user');
    expect(attachmentsOf(message)).toEqual(count === 0 ? undefined : files);
  });

  it.each([0, 1, 2])('keeps %i generated files on the assistant answer only, in order', (count) => {
    const store = createTranscriptStore();
    store.ingest(echo(INPUTS));
    store.ingest(answer([INPUTS[0], ...OUTPUTS.slice(0, count)]));
    const [user, assistant] = store.getSnapshot();
    expect(attachmentsOf(user)).toEqual(INPUTS);
    expect(assistant?.role).toBe('assistant');
    expect(attachmentsOf(assistant)).toEqual(count === 0 ? undefined : OUTPUTS.slice(0, count));
  });
});

describe('repeated delivery, resync and late answers', () => {
  it('keeps every file exactly once across repeated echo / partial / answer delivery', () => {
    const store = createTranscriptStore();
    store.ingest(echo(INPUTS, 10));
    store.ingest(echo(INPUTS, 10));
    store.ingest(echo([...INPUTS].reverse(), 11));
    store.ingest(createMessage('chat::partial', { content: ['Here'], role: 'assistant', turn: fixture.turn }, 19));
    store.ingest(answer(OUTPUTS, 20));
    store.ingest(answer(OUTPUTS, 20));
    store.ingest(answer([OUTPUTS[1], OUTPUTS[0]], 21));

    const transcript = store.getSnapshot();
    expect(transcript).toHaveLength(2);
    expect(attachmentsOf(transcript[0])).toEqual(INPUTS);
    expect(attachmentsOf(transcript[1])).toEqual(OUTPUTS);
  });

  it('a late answer without attachments never erases accepted generated files', () => {
    const store = createTranscriptStore();
    store.ingest(answer(OUTPUTS, 20));
    store.ingest(createMessage('chat::answer', { ...fixture.messages.chat_answer, meta: {} }, 22));
    store.ingest(answer([], 23));
    const [assistant] = store.getSnapshot();
    expect(attachmentsOf(assistant)).toEqual(OUTPUTS);
    expect(assistant?.status).toBe('final');
  });

  it('a re-delivered file takes its newer state in place (expired / missing files stay listed)', () => {
    const store = createTranscriptStore();
    store.ingest(answer(OUTPUTS, 20));
    store.ingest(answer([{ ...OUTPUTS[0], state: 'expired' }], 21));
    expect(attachmentsOf(store.getSnapshot()[0])).toEqual([{ ...OUTPUTS[0], state: 'expired' }, OUTPUTS[1]]);
  });

  it('does not let an echo of another message change files of a user message', () => {
    const store = createTranscriptStore();
    store.ingest(echo(INPUTS, 10));
    const other = { ...INPUTS[0], message_ref: 'cli_other' };
    store.ingest(echo([other, INPUTS[1]], 12, 'cli_other'));
    const transcript = store.getSnapshot();
    expect(transcript).toHaveLength(2);
    expect(attachmentsOf(transcript[0])).toEqual(INPUTS);
    expect(attachmentsOf(transcript[1])).toEqual([other]);
  });
});

describe('ChatController lifecycle: send -> echo -> answer -> persist -> restore -> resync', () => {
  it('3 inbound and 2 outbound files survive with identity, order and input lock intact', async () => {
    const persistence = new MemoryPersistence();
    const client = createMockClient();
    const controller = createChatController({ client, transcriptPersistence: persistence });
    await controller.connect();

    const refs = INPUTS.map((d) => d.file_ref);
    const sent = await controller.sendMessage({
      content: 'Compare the attached revenue files.',
      attachments: [...refs, 'fi_0123456789abcdef', { file_ref: refs[0], download_mint_url: '/mint' }],
    });
    expect(sent.ok).toBe(true);
    // The SDK receives the caller's attachments unchanged and validates them itself.
    expect(client.sentMessages[0]?.attachments).toHaveLength(5);
    const optimistic = controller.getState().transcript[0];
    expect(attachmentsOf(optimistic)).toEqual(refs.map((file_ref) => ({ file_ref })));
    expect(controller.getState().input).toEqual({ locked: true, reason: 'awaiting_answer' });

    const clientMsgId = sent.clientMsgId;
    const bound = INPUTS.map((d) => ({ ...d, message_ref: clientMsgId }));
    client.emit(createMessage('chat::echo', {
      content: 'Compare the attached revenue files.',
      role: 'user',
      meta: { client_msg_id: clientMsgId, attachments: bound.map((d, i) => ({ ...d, file_id: `fi_${i}` })) },
    }, 10));
    client.emit(answer([bound[0], { ...OUTPUTS[0], delivery_ticket: 'tkt' }, OUTPUTS[1]], 20));

    let transcript = controller.getState().transcript;
    expect(transcript).toHaveLength(2);
    expect(transcript[0]?.id).toBe(sent.messageId);
    expect(transcript[0]?.deliveryStatus).toBe('processed');
    expect(attachmentsOf(transcript[0])).toEqual(bound);
    expect(attachmentsOf(transcript[1])).toEqual(OUTPUTS);
    expect(controller.getState().input).toEqual({ locked: false });
    // originalPayload is the caller's own in-memory retry input; every rendered surface is clean.
    expect(JSON.stringify(transcript.map(({ originalPayload: _retryInput, ...rendered }) => rendered))).not.toMatch(FORBIDDEN);

    await controller.disconnect();
    const persisted = persistence.records.get('session:sess_test')!;
    expect(persisted.version).toBe(TRANSCRIPT_SCHEMA_VERSION);
    expect(persisted.expiresAt).toBeGreaterThan(Date.now());
    expect(persisted.messages.map((m) => attachmentsOf(m))).toEqual([bound, OUTPUTS]);
    expect(JSON.stringify(persisted)).not.toMatch(FORBIDDEN);

    // Reload: restore, then the server replays the same echo and answer on resync.
    const reloadedClient = createMockClient();
    const reloaded = createChatController({ client: reloadedClient, transcriptPersistence: persistence });
    await reloaded.connect();
    reloadedClient.emit(createMessage('chat::echo', {
      content: 'Compare the attached revenue files.', role: 'user', meta: { client_msg_id: clientMsgId, attachments: bound },
    }, 10));
    reloadedClient.emit(answer(OUTPUTS, 20));
    reloadedClient.emit(answer(OUTPUTS, 20));

    transcript = reloaded.getState().transcript;
    expect(transcript.map((m) => m.id)).toEqual([sent.messageId, `turn:${fixture.turn_ref}`]);
    expect(transcript[0]?.clientMsgId).toBe(clientMsgId);
    expect(attachmentsOf(transcript[0])).toEqual(bound);
    expect(attachmentsOf(transcript[1])).toEqual(OUTPUTS);
    expect(reloadedClient.sentMessages).toHaveLength(0);
    expect(reloaded.getState().input).toEqual({ locked: false });
    await reloaded.disconnect();
  });

  it('keeps the failed message retryable with its original attachments', async () => {
    const client = createMockClient();
    const controller = createChatController({ client });
    await controller.connect();
    client.setSendError(new Error('socket closed'));
    const refs = INPUTS.map((d) => d.file_ref);
    const failed = await controller.sendMessage({ content: 'x', attachments: refs });
    expect(failed.ok).toBe(false);
    client.setSendError(null);
    const retried = await controller.retryMessage(failed.messageId);
    expect(retried).toMatchObject({ ok: true, clientMsgId: failed.clientMsgId });
    expect(client.sentMessages).toEqual([{ content: 'x', attachments: refs, meta: { client_msg_id: failed.clientMsgId } }]);
    expect(controller.getState().transcript).toHaveLength(1);
    expect(attachmentsOf(controller.getState().transcript[0])).toEqual(refs.map((file_ref) => ({ file_ref })));
  });

  async function restore(messages: ChatMessageViewModel[]) {
    const persistence = new MemoryPersistence();
    const now = Date.now();
    persistence.records.set('session:sess_test', {
      version: TRANSCRIPT_SCHEMA_VERSION, sessionKey: 'session:sess_test', updatedAt: now, expiresAt: now + 60_000, messages,
    });
    const controller = createChatController({ client: createMockClient(), transcriptPersistence: persistence });
    await controller.connect();
    return controller.getState().transcript;
  }

  function storedAnswer(meta: Record<string, unknown>): ChatMessageViewModel {
    return { id: `turn:${fixture.turn_ref}`, type: 'chat::answer', role: 'assistant', content: ['old'], status: 'final', meta };
  }

  it('re-projects restored attachments: hostile fields, inherited, unbound and cross-turn entries are dropped', async () => {
    const transcript = await restore([storedAnswer({
      turnRef: fixture.turn_ref,
      attachments: [
        { ...OUTPUTS[0], file_id: 'fi_old', download_mint_url: '/sessions/s/files/sf/download-token' },
        INPUTS[0],
        { file_ref: 'mock_file_1_report.xlsx' },
        { ...OUTPUTS[0], file_ref: 'sf_unbound', message_ref: undefined },
        { ...OUTPUTS[0], file_ref: 'sf_kindless', message_ref_kind: undefined },
        { ...OUTPUTS[0], file_ref: 'sf_cross_turn', message_ref: '8' },
        OUTPUTS[1],
      ],
    })]);
    expect(attachmentsOf(transcript[0])).toEqual(OUTPUTS);
    expect(JSON.stringify(transcript)).not.toMatch(FORBIDDEN);
  });

  it('a restored answer without a trusted turn keeps no files (records from older builds)', async () => {
    const legacy = await restore([storedAnswer({ turnId: 'turn_ea_0007', attachments: OUTPUTS })]);
    expect(attachmentsOf(legacy[0])).toBeUndefined();
    const forged = await restore([storedAnswer({ turnRef: '8', attachments: OUTPUTS })]);
    expect(attachmentsOf(forged[0])).toBeUndefined();
  });

  it('restores pending local uploads but no confirmed file of another message', async () => {
    const transcript = await restore([{
      id: 'client:cli_pending', type: 'chat::message', role: 'user', content: 'x', status: 'final',
      deliveryStatus: 'sent', clientMsgId: 'cli_pending',
      meta: {
        client_msg_id: 'cli_pending',
        persisted_outgoing: true,
        attachments: [
          { file_ref: 'sf_pending', filename: 'draft.csv' },
          { ...INPUTS[0], message_ref: 'cli_pending' },
          { ...INPUTS[1], message_ref: 'cli_other' },
          { ...INPUTS[2], message_ref_kind: undefined, message_ref: 'cli_pending' },
          'fi_0123456789abcdef',
        ],
      },
    }]);
    expect(attachmentsOf(transcript[0])).toEqual([
      { file_ref: 'sf_pending', filename: 'draft.csv' },
      { ...INPUTS[0], message_ref: 'cli_pending' },
    ]);
  });

  it('sanitizeTranscriptMessage applies the same projection', () => {
    const safe = sanitizeTranscriptMessage({
      id: 'turn:x', type: 'chat::answer', role: 'assistant', content: ['x'], status: 'final',
      meta: { turnRef: fixture.turn_ref, attachments: [{ ...OUTPUTS[0], snapshot_id: 'sn_1', upload_path: '/u' }, INPUTS[1]] },
    });
    expect(safe.meta?.['attachments']).toEqual([OUTPUTS[0]]);
  });

  it('keeps transcript ownership across sessions', async () => {
    const persistence = new MemoryPersistence();
    const client = createMockClient();
    const controller = createChatController({ client, transcriptPersistence: persistence });
    await controller.connect();
    client.emit(answer(OUTPUTS, 20));
    await controller.disconnect();

    const other = createMockClient();
    other.sessionId = 'sess_other';
    const otherController = createChatController({ client: other, transcriptPersistence: persistence });
    await otherController.connect();
    expect(otherController.getState().transcript).toHaveLength(0);
    expect(persistence.records.get('session:sess_test')?.messages).toHaveLength(1);
  });
});
