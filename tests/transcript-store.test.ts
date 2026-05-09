import { createTranscriptStore } from '../src/index.js';
import { createMessage } from './helpers.js';

describe('createTranscriptStore', () => {
  it('aggregates chat::partial by turn_id and finalizes with chat::answer', () => {
    const store = createTranscriptStore();

    const partialOne = store.ingest(createMessage('chat::partial', {
      content: 'Hello ',
      role: 'assistant',
      turn_id: 'turn_1',
    }, 1));

    expect(partialOne.mutation?.type).toBe('message_added');
    expect(partialOne.mutation?.message.content).toBe('Hello ');
    expect(partialOne.mutation?.message.status).toBe('streaming');

    const partialTwo = store.ingest(createMessage('chat::partial', {
      content: 'world',
      role: 'assistant',
      turn_id: 'turn_1',
    }, 2));

    expect(partialTwo.mutation?.type).toBe('message_updated');
    expect(partialTwo.mutation?.message.content).toBe('Hello world');
    expect(partialTwo.mutation?.message.status).toBe('streaming');

    const answer = store.ingest(createMessage('chat::answer', {
      content: 'Hello world.',
      role: 'assistant',
      answer_kind: 'final',
      turn_id: 'turn_1',
    }, 3));

    expect(answer.mutation?.type).toBe('message_updated');
    expect(answer.mutation?.message.content).toBe('Hello world.');
    expect(answer.mutation?.message.status).toBe('final');
    expect(store.getSnapshot()).toHaveLength(1);
  });

  it('emits an error and fallback message for malformed chat::partial without turn_id', () => {
    const store = createTranscriptStore();

    const result = store.ingest(createMessage('chat::partial', {
      content: 'Hello',
      role: 'assistant',
    }));

    expect(result.error).toMatchObject({
      code: 'partial_missing_turn_id',
    });
    expect(result.mutation?.type).toBe('message_added');
    expect(result.mutation?.message.role).toBe('error');
    expect(store.getSnapshot()).toHaveLength(1);
  });

  it('preserves payload.attachments in chat::message meta', () => {
    const store = createTranscriptStore();

    const result = store.ingest(createMessage('chat::message', {
      content: '',
      role: 'user',
      attachments: ['mock_file_1_report.xlsx'],
    }));

    expect(result.mutation?.type).toBe('message_added');
    expect(result.mutation?.message.meta).toMatchObject({
      attachments: ['mock_file_1_report.xlsx'],
    });
    expect(store.getSnapshot()[0]?.meta).toMatchObject({
      attachments: ['mock_file_1_report.xlsx'],
    });
  });

  it('upsertLocalMessage adds new message when id not present', () => {
    const store = createTranscriptStore();

    const msg = {
      id: 'client:msg_1',
      type: 'chat::message',
      role: 'user' as const,
      content: 'Hello',
      status: 'final' as const,
      deliveryStatus: 'sending' as const,
      ts: new Date().toISOString(),
    };

    const result = store.upsertLocalMessage(msg);

    expect(result.mutation?.type).toBe('message_added');
    expect(result.mutation?.message.id).toBe('client:msg_1');
    expect(result.mutation?.message.deliveryStatus).toBe('sending');
    expect(store.getSnapshot()).toHaveLength(1);
  });

  it('upsertLocalMessage updates existing message when id matches', () => {
    const store = createTranscriptStore();

    const base = {
      id: 'client:msg_1',
      type: 'chat::message',
      role: 'user' as const,
      content: 'Hello',
      status: 'final' as const,
      deliveryStatus: 'sending' as const,
      ts: new Date().toISOString(),
    };

    store.upsertLocalMessage(base);
    const result = store.upsertLocalMessage({ ...base, deliveryStatus: 'sent' as const });

    expect(result.mutation?.type).toBe('message_updated');
    expect(result.mutation?.message.deliveryStatus).toBe('sent');
    expect(store.getSnapshot()).toHaveLength(1);
  });

  it('upsertLocalMessage does not affect server-ingested messages', () => {
    const store = createTranscriptStore();

    store.ingest(createMessage('chat::answer', {
      content: 'From server',
      role: 'assistant',
      turn_id: 'turn_1',
    }));

    const localMsg = {
      id: 'client:msg_local',
      type: 'chat::message',
      role: 'user' as const,
      content: 'Local',
      status: 'final' as const,
      deliveryStatus: 'sent' as const,
      ts: new Date().toISOString(),
    };
    store.upsertLocalMessage(localMsg);

    const snapshot = store.getSnapshot();
    expect(snapshot).toHaveLength(2);
    const serverMsg = snapshot.find((m) => m.id !== 'client:msg_local');
    expect(serverMsg?.role).toBe('assistant');
    expect(serverMsg?.deliveryStatus).toBeUndefined();
  });
});
