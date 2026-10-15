/**
 * Runtime chat::partial streaming: ChatPartialPayload serializes content as
 * list[str] and an integer turn (no turn_id). Chunks accumulate in arrival
 * order, a replayed chunk is not appended twice, and chat::answer replaces the
 * streamed content authoritatively.
 */
import { readFileSync } from 'node:fs';
import {
  TRANSCRIPT_SCHEMA_VERSION,
  createChatController,
  createTranscriptStore,
} from '../src/index.js';
import type {
  ChatAttachment,
  PersistedTranscript,
  PersistedTranscriptMessage,
  TranscriptPersistence,
} from '../src/index.js';
import { createMessage, createMockClient } from './helpers.js';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/session_file_attachments_v1.json', import.meta.url), 'utf8'),
) as {
  turn: number;
  inputs: Array<{ descriptor: ChatAttachment }>;
  outputs: Array<{ descriptor: ChatAttachment }>;
  messages: { chat_answer: Record<string, unknown> };
};

const TURN = fixture.turn;
const OUTPUT_REFS = fixture.outputs.map((output) => output.descriptor.file_ref);

function partial(content: string[], seq: number, turn = TURN) {
  return createMessage('chat::partial', { content, role: 'assistant', turn }, seq);
}

function answer(seq: number, meta?: Record<string, unknown>) {
  return createMessage('chat::answer', {
    ...fixture.messages.chat_answer,
    ...(meta ? { meta } : {}),
  }, seq);
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
    const byId = new Map((this.records.get(sessionKey)?.messages ?? []).map((message) => [message.id, message]));
    for (const entry of messages) byId.set(entry.message.id, entry.message);
    this.records.set(sessionKey, JSON.parse(JSON.stringify({ ...transcript, messages: Array.from(byId.values()) })) as PersistedTranscript);
  }

  async delete(sessionKey: string): Promise<void> {
    this.records.delete(sessionKey);
  }

  async purgeExpired(): Promise<void> {}
}

describe('Runtime chat::partial accumulation', () => {
  it('accumulates list[str] chunks in order under the turn id', () => {
    const store = createTranscriptStore();
    const first = store.ingest(partial(['Quantum entanglement is '], 2));
    const second = store.ingest(partial(['a phenomenon ', 'where two'], 3));
    const third = store.ingest(partial([' particles'], 4));

    expect(first.mutation?.type).toBe('message_added');
    expect(second.mutation?.type).toBe('message_updated');
    expect(third.mutation?.message).toMatchObject({
      id: `turn:${TURN}`,
      status: 'streaming',
      content: ['Quantum entanglement is a phenomenon where two particles'],
      meta: { turnRef: String(TURN) },
    });
    expect(store.getView()).toHaveLength(1);
  });

  it('keeps a multi-block first chunk as one block', () => {
    const store = createTranscriptStore();
    expect(store.ingest(partial(['Hel', 'lo'], 1)).mutation?.message.content).toEqual(['Hello']);
  });

  it('does not append a replayed or older chunk twice', () => {
    const store = createTranscriptStore();
    store.ingest(partial(['A'], 2));
    store.ingest(partial(['B'], 3));
    expect(store.ingest(partial(['B'], 3))).toEqual({});
    expect(store.ingest(partial(['A'], 2))).toEqual({});
    store.ingest(partial(['C'], 4));
    expect(store.getView()[0].content).toEqual(['ABC']);
  });

  it('lets chat::answer replace streamed content and ignores later replayed partials', () => {
    const store = createTranscriptStore();
    store.ingest(partial(['Here are'], 2));
    store.ingest(partial([' the deltas'], 3));
    const final = store.ingest(answer(4));

    expect(final.mutation?.type).toBe('message_updated');
    expect(final.mutation?.message).toMatchObject({
      id: `turn:${TURN}`,
      type: 'chat::answer',
      status: 'final',
      content: fixture.messages.chat_answer['content'],
    });
    expect(store.ingest(partial(['Here are'], 2))).toEqual({});
    expect(store.ingest(partial(['late chunk'], 9))).toEqual({});
    expect(store.getView()).toHaveLength(1);
    expect(store.getView()[0]).toMatchObject({ status: 'final', content: fixture.messages.chat_answer['content'] });
  });

  it('keeps legacy string partials concatenating as strings', () => {
    const store = createTranscriptStore();
    store.ingest(createMessage('chat::partial', { content: 'Hello ', role: 'assistant', turn_id: 'turn-1' }, 1));
    store.ingest(createMessage('chat::partial', { content: 'world', role: 'assistant', turn_id: 'turn-1' }, 2));
    expect(store.getView()[0].content).toBe('Hello world');
  });

  it('partials own no files; the final answer owns exactly its generated files', () => {
    const store = createTranscriptStore();
    const outputs = fixture.outputs.map((output) => output.descriptor);
    store.ingest(createMessage('chat::partial', {
      content: ['Here'], role: 'assistant', turn: TURN, meta: { attachments: outputs },
    }, 2));
    expect(store.getView()[0].meta?.['attachments']).toBeUndefined();

    const inherited = fixture.inputs.map((input) => ({ ...input.descriptor, message_ref: 'cli_x', message_ref_kind: 'client_msg_id' }));
    store.ingest(answer(3, { attachments: [...inherited, ...outputs] }));
    const attachments = store.getView()[0].meta?.['attachments'] as ChatAttachment[];
    expect(attachments.map((attachment) => attachment.file_ref)).toEqual(OUTPUT_REFS);
  });
});

describe('Runtime streaming through the controller', () => {
  it('reconnect resync replays partials and the answer without duplicating text or files', async () => {
    const client = createMockClient();
    const controller = createChatController({ client });
    await controller.connect();
    client.emit(partial(['Here are'], 2));
    client.emit(partial([' the deltas'], 3));
    expect(controller.getState().transcript[0].content).toEqual(['Here are the deltas']);

    // Resync after reconnect: the server replays from last_seq.
    client.emit(partial([' the deltas'], 3));
    client.emit(answer(4));
    client.emit(partial(['Here are'], 2));
    client.emit(answer(4));

    const transcript = controller.getState().transcript;
    expect(transcript).toHaveLength(1);
    expect(transcript[0]).toMatchObject({ status: 'final', content: fixture.messages.chat_answer['content'] });
    expect((transcript[0].meta?.['attachments'] as ChatAttachment[]).map((attachment) => attachment.file_ref)).toEqual(OUTPUT_REFS);
  });

  it('persists the accumulated stream and restores the final answer with its files', async () => {
    const persistence = new MemoryPersistence();
    const client = createMockClient();
    const controller = createChatController({ client, transcriptPersistence: persistence });
    await controller.connect();
    client.emit(partial(['Here are'], 2));
    client.emit(partial([' the deltas'], 3));
    await controller.disconnect();

    const streamed = persistence.records.get('session:sess_test');
    expect(streamed?.version).toBe(TRANSCRIPT_SCHEMA_VERSION);
    expect(streamed?.messages).toHaveLength(1);
    expect(streamed?.messages[0]).toMatchObject({ status: 'streaming', content: ['Here are the deltas'], seq: 3 });

    // Reload mid-stream, then the server replays the last chunk and finishes the turn.
    const reconnectClient = createMockClient();
    const restored = createChatController({ client: reconnectClient, transcriptPersistence: persistence });
    await restored.connect();
    expect(restored.getState().transcript[0].content).toEqual(['Here are the deltas']);
    reconnectClient.emit(partial([' the deltas'], 3));
    expect(restored.getState().transcript[0].content).toEqual(['Here are the deltas']);
    reconnectClient.emit(answer(4));
    await restored.disconnect();

    const final = persistence.records.get('session:sess_test')?.messages ?? [];
    expect(final).toHaveLength(1);
    expect(final[0]).toMatchObject({ type: 'chat::answer', status: 'final', content: fixture.messages.chat_answer['content'] });
    expect((final[0].meta?.['attachments'] as ChatAttachment[]).map((attachment) => attachment.file_ref)).toEqual(OUTPUT_REFS);

    const third = createChatController({ client: createMockClient(), transcriptPersistence: persistence });
    await third.connect();
    expect(third.getState().transcript).toHaveLength(1);
    expect((third.getState().transcript[0].meta?.['attachments'] as ChatAttachment[]).map((attachment) => attachment.file_ref)).toEqual(OUTPUT_REFS);
  });

  it('keeps input locking unchanged while streaming and after the final answer', async () => {
    const client = createMockClient();
    const controller = createChatController({ client });
    await controller.connect();
    const lockedBefore = controller.getState().input.locked;
    client.emit(partial(['Here'], 2));
    expect(controller.getState().input.locked).toBe(lockedBefore);
    client.emit(answer(3));
    expect(controller.getState().input.locked).toBe(lockedBefore);
  });
});
