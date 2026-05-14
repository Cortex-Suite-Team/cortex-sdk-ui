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

  it('never stores blocked system messages in transcript', () => {
    const store = createTranscriptStore();

    for (const type of [
      'system::opened',
      'system::lifecycle',
      'system::state',
      'system::pong',
      'system::telemetry',
      'system::billing',
    ]) {
      const result = store.ingest(createMessage(type, {
        status: 'active',
        message: 'hidden',
      }));

      expect(result.mutation).toBeUndefined();
    }

    expect(store.getSnapshot()).toHaveLength(0);
  });

  it('does not store system::error in transcript by default', () => {
    const store = createTranscriptStore();

    const result = store.ingest(createMessage('system::error', {
      code: 'runtime_error',
      message: 'Worker failed to load',
      details: {
        nested: true,
      },
    }));

    expect(result.mutation).toBeUndefined();
    expect(store.getSnapshot()).toHaveLength(0);
  });

  it('stores only user-safe system::error messages in transcript', () => {
    const store = createTranscriptStore();

    const result = store.ingest(createMessage('system::error', {
      code: 'user_visible_error',
      message: 'Please retry in a moment.',
      meta: {
        user_safe: true,
      },
      details: {
        nested: true,
      },
    }));

    expect(result.mutation?.message.role).toBe('error');
    expect(result.mutation?.message.content).toBe('Please retry in a moment.');
    expect(store.getSnapshot()[0]?.content).toBe('Please retry in a moment.');
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

  it('reconciles optimistic user message with backend echo by client_msg_id', () => {
    const store = createTranscriptStore();
    const localTs = new Date().toISOString();

    store.upsertLocalMessage({
      id: 'client:msg_1',
      type: 'chat::message',
      role: 'user',
      content: 'Hello',
      status: 'final',
      deliveryStatus: 'sending',
      ts: localTs,
      clientMsgId: 'msg_1',
      meta: {
        client_msg_id: 'msg_1',
        timestamp_source: 'client',
      },
      originalPayload: {
        content: 'Hello',
        meta: {
          client_msg_id: 'msg_1',
        },
      },
    });

    const result = store.ingest(createMessage('chat::message', {
      content: 'Hello',
      role: 'user',
      meta: {
        client_msg_id: 'msg_1',
      },
    }, 5));

    expect(result.mutation?.type).toBe('message_updated');
    expect(result.mutation?.message.deliveryStatus).toBe('sent');
    expect(result.mutation?.message.id).not.toBe('client:msg_1');
    expect(result.mutation?.message.ts).toBe(new Date(5000).toISOString());
    expect(result.mutation?.message.meta?.['timestamp_source']).toBe('server');
    expect(store.getSnapshot()).toHaveLength(1);
  });

  it('keeps provisional timestamp when backend echo has no ts', () => {
    const store = createTranscriptStore();
    const localTs = new Date().toISOString();

    store.upsertLocalMessage({
      id: 'client:msg_2',
      type: 'chat::message',
      role: 'user',
      content: 'Hello',
      status: 'final',
      deliveryStatus: 'sending',
      ts: localTs,
      clientMsgId: 'msg_2',
      meta: {
        client_msg_id: 'msg_2',
        timestamp_source: 'client',
      },
    });

    store.ingest({
      type: 'chat::message',
      schema: '1.0',
      session_id: 'sess_test',
      seq: 6,
      payload: {
        content: 'Hello',
        role: 'user',
        meta: {
          client_msg_id: 'msg_2',
        },
      },
    });

    const snapshot = store.getSnapshot();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0].ts).toBe(localTs);
    expect(snapshot[0].meta?.['timestamp_source']).toBe('client');
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
