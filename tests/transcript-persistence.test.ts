import {
  TRANSCRIPT_SCHEMA_VERSION,
  createChatController,
  sanitizeTranscriptMessage,
} from '../src/index.js';
import type {
  PersistedTranscript,
  PersistedTranscriptMessage,
  TranscriptPersistence,
} from '../src/index.js';
import { createMessage, createMockClient } from './helpers.js';

class MemoryPersistence implements TranscriptPersistence {
  readonly records = new Map<string, PersistedTranscript>();
  readonly deleted: string[] = [];
  readonly changedBatches: string[][] = [];

  async load(sessionKey: string): Promise<PersistedTranscript | null> {
    return this.records.get(sessionKey) ?? null;
  }

  async save(
    sessionKey: string,
    transcript: Omit<PersistedTranscript, 'messages'>,
    messages: readonly PersistedTranscriptMessage[],
  ): Promise<void> {
    const previous = this.records.get(sessionKey)?.messages ?? [];
    const byId = new Map(previous.map((message) => [message.id, message]));
    for (const entry of messages) byId.set(entry.message.id, entry.message);
    const orderById = new Map(messages.map((entry) => [entry.message.id, entry.order]));
    const merged = Array.from(byId.values()).sort((left, right) => (
      (orderById.get(left.id) ?? previous.findIndex((message) => message.id === left.id))
      - (orderById.get(right.id) ?? previous.findIndex((message) => message.id === right.id))
    ));
    this.records.set(sessionKey, JSON.parse(JSON.stringify({ ...transcript, messages: merged })) as PersistedTranscript);
    this.changedBatches.push(messages.map((entry) => entry.message.id));
  }

  async delete(sessionKey: string): Promise<void> {
    this.deleted.push(sessionKey);
    this.records.delete(sessionKey);
  }

  async purgeExpired(now: number): Promise<void> {
    for (const [key, record] of this.records) {
      if (record.expiresAt <= now) await this.delete(key);
    }
  }
}

function record(messages: PersistedTranscript['messages']): PersistedTranscript {
  return {
    version: TRANSCRIPT_SCHEMA_VERSION,
    sessionKey: 'session:sess_test',
    updatedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    messages,
  };
}

describe('transcript persistence', () => {
  it('persists, restores, and deduplicates canonical reconnect messages without resending', async () => {
    const persistence = new MemoryPersistence();
    const firstClient = createMockClient();
    const first = createChatController({ client: firstClient, transcriptPersistence: persistence });
    await first.connect();
    firstClient.emit(createMessage('chat::answer', { role: 'assistant', content: 'Restored', turn_id: 'turn-1' }, 7));
    await first.disconnect();

    const secondClient = createMockClient();
    const second = createChatController({ client: secondClient, transcriptPersistence: persistence });
    await second.connect();
    expect(second.getState().transcript).toHaveLength(1);
    expect(secondClient.sentMessages).toHaveLength(0);

    secondClient.emit(createMessage('chat::answer', { role: 'assistant', content: 'Restored', turn_id: 'turn-1' }, 7));
    expect(second.getState().transcript).toHaveLength(1);
    expect(secondClient.sentMessages).toHaveLength(0);
  });

  it('batches a streaming partial as one persisted logical message', async () => {
    const persistence = new MemoryPersistence();
    const client = createMockClient();
    const controller = createChatController({ client, transcriptPersistence: persistence });
    await controller.connect();
    client.emit(createMessage('chat::partial', { role: 'assistant', content: 'Hello ', turn_id: 'turn-2' }, 1));
    client.emit(createMessage('chat::partial', { role: 'assistant', content: 'world', turn_id: 'turn-2' }, 2));
    await controller.disconnect();

    const saved = persistence.records.get('session:sess_test');
    expect(saved?.messages).toHaveLength(1);
    expect(saved?.messages[0].content).toBe('Hello world');
    expect(persistence.changedBatches.at(-1)).toHaveLength(1);
  });

  it('deletes terminal sessions and rejects mismatched or unknown persisted records', async () => {
    const persistence = new MemoryPersistence();
    persistence.records.set('session:sess_test', {
      ...record([]),
      version: 99 as never,
    });
    const client = createMockClient();
    const controller = createChatController({ client, transcriptPersistence: persistence });
    await controller.connect();
    expect(persistence.deleted).toContain('session:sess_test');

    persistence.records.set('session:sess_test', record([{ id: 'a', type: 'chat::answer', role: 'assistant', content: 'x' }]));
    client.emit(createMessage('system::lifecycle', { status: 'completed' }, 8));
    await Promise.resolve();
    expect(persistence.deleted).toContain('session:sess_test');
  });

  it('purges expired records and keeps live chat usable after storage failure', async () => {
    const persistence = new MemoryPersistence();
    persistence.records.set('session:expired', {
      ...record([]),
      sessionKey: 'session:expired',
      expiresAt: Date.now() - 1,
    });
    const client = createMockClient();
    const controller = createChatController({ client, transcriptPersistence: persistence });
    await controller.connect();
    expect(persistence.records.has('session:expired')).toBe(false);

    const broken: TranscriptPersistence = {
      load: async () => null,
      save: async () => { throw new Error('quota'); },
      delete: async () => {},
      purgeExpired: async () => { throw new Error('blocked'); },
    };
    const liveClient = createMockClient();
    const live = createChatController({ client: liveClient, transcriptPersistence: broken });
    await expect(live.connect()).resolves.toBeUndefined();
    await expect(live.sendMessage({ content: 'still live' })).resolves.toMatchObject({ ok: true });
  });

  it('fails closed on mismatched session identity', async () => {
    const persistence = new MemoryPersistence();
    persistence.records.set('session:sess_test', {
      ...record([{ id: 'foreign', type: 'chat::answer', role: 'assistant', content: 'foreign' }]),
      sessionKey: 'session:other',
    });
    const controller = createChatController({ client: createMockClient(), transcriptPersistence: persistence });
    await controller.connect();
    expect(controller.getState().transcript).toHaveLength(0);
    expect(persistence.deleted).toContain('session:sess_test');
  });

  it('strips retry payload and credential-shaped metadata before persistence', async () => {
    const sanitized = sanitizeTranscriptMessage({
      id: 'client:one',
      type: 'chat::message',
      role: 'user',
      content: 'hello',
      meta: { access_token: 'secret', nested: { password: 'secret', public: 'ok' } },
      originalPayload: { content: 'hello', meta: { client_msg_id: 'one' } },
    });
    expect(JSON.stringify(sanitized)).not.toContain('secret');
    expect(sanitized.originalPayload).toBeUndefined();
    expect(sanitized.meta?.['nested']).toEqual({ public: 'ok' });

    const persistence = new MemoryPersistence();
    const controller = createChatController({ client: createMockClient(), transcriptPersistence: persistence });
    await controller.connect();
    await controller.sendMessage({ content: 'hello', meta: { access_token: 'secret' } });
    await controller.disconnect();
    expect(JSON.stringify(persistence.records.get('session:sess_test'))).not.toContain('secret');
  });

  it('operates without browser persistence', async () => {
    const client = createMockClient();
    const controller = createChatController({ client, transcriptPersistence: null });
    await controller.connect();
    await expect(controller.sendMessage({ content: 'memory only' })).resolves.toMatchObject({ ok: true });
  });
});
