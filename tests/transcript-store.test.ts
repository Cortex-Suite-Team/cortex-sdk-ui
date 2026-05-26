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

  it('reconciles optimistic user message with chat::echo by client_msg_id', () => {
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

    const result = store.ingest(createMessage('chat::echo', {
      content: 'Hello',
      role: 'user',
      meta: {
        client_msg_id: 'msg_1',
      },
    }, 5));

    expect(result.mutation?.type).toBe('message_updated');
    expect(result.mutation?.message.deliveryStatus).toBe('processed');
    expect(result.mutation?.message.id).toBe('client:msg_1');
    expect(result.mutation?.message.type).toBe('chat::message');
    expect(result.mutation?.message.content).toBe('Hello');
    expect(result.mutation?.message.ts).toBe(new Date(5000).toISOString());
    expect(result.mutation?.message.meta?.['timestamp_source']).toBe('server');
    expect(result.mutation?.message.meta?.['echo_type']).toBe('chat::echo');
    expect(store.getSnapshot()).toHaveLength(1);
  });

  it('reconciles chat::echo when client_msg_id is only present on envelope meta', () => {
    const store = createTranscriptStore();

    store.upsertLocalMessage({
      id: 'client:msg_envelope',
      type: 'chat::message',
      role: 'user',
      content: 'Envelope meta',
      status: 'final',
      deliveryStatus: 'sent',
      ts: '2026-05-14T18:35:00.000Z',
      clientMsgId: 'msg_envelope',
      meta: {
        client_msg_id: 'msg_envelope',
        timestamp_source: 'client',
      },
      originalPayload: {
        content: 'Envelope meta',
        meta: {
          client_msg_id: 'msg_envelope',
        },
      },
    });

    const result = store.ingest({
      type: 'chat::echo',
      schema: '1.0',
      session_id: 'sess_test',
      seq: 15,
      ts: '2026-05-14T18:35:02.000Z',
      meta: {
        client_msg_id: 'msg_envelope',
      },
      payload: {
        role: 'user',
        content: 'Envelope meta',
      },
    });

    expect(result.mutation?.type).toBe('message_updated');
    expect(store.getSnapshot()).toHaveLength(1);
    expect(store.getSnapshot()[0]).toMatchObject({
      id: 'client:msg_envelope',
      deliveryStatus: 'processed',
      seq: 15,
    });
  });

  it('preserves optimistic identity and content when matching chat::echo arrives for a sent user message', () => {
    const store = createTranscriptStore();

    store.upsertLocalMessage({
      id: 'client:abc',
      type: 'chat::message',
      role: 'user',
      content: 'Тестовое сообщение',
      status: 'final',
      clientMsgId: 'abc',
      deliveryStatus: 'sent',
      ts: '2026-05-14T18:35:00.000Z',
      meta: {
        client_msg_id: 'abc',
        timestamp_source: 'client',
      },
      originalPayload: {
        content: 'Тестовое сообщение',
        meta: {
          client_msg_id: 'abc',
        },
      },
    });

    store.ingest({
      type: 'chat::echo',
      schema: '1.0',
      session_id: 'sess_test',
      seq: 42,
      ts: '2026-05-14T18:35:10.000Z',
      payload: {
        role: 'user',
        content: 'Тестовое сообщение',
        meta: {
          client_msg_id: 'abc',
        },
      },
    });

    const snapshot = store.getSnapshot();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]).toMatchObject({
      id: 'client:abc',
      type: 'chat::message',
      role: 'user',
      content: 'Тестовое сообщение',
      clientMsgId: 'abc',
      deliveryStatus: 'processed',
      seq: 42,
      ts: '2026-05-14T18:35:10.000Z',
    });
    expect(snapshot[0].meta?.['timestamp_source']).toBe('server');
    expect(snapshot[0].meta?.['echo_type']).toBe('chat::echo');
    expect(snapshot[0].originalPayload).toEqual({
      content: 'Тестовое сообщение',
      meta: {
        client_msg_id: 'abc',
      },
    });
  });

  it('keeps provisional timestamp when chat::echo has no ts', () => {
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
      originalPayload: {
        content: 'Hello',
        meta: {
          client_msg_id: 'msg_2',
        },
      },
    });

    store.ingest({
      type: 'chat::echo',
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
    expect(snapshot[0].deliveryStatus).toBe('processed');
    expect(snapshot[0].meta?.['timestamp_source']).toBe('client');
    expect(snapshot[0].meta?.['echo_type']).toBe('chat::echo');
  });

  it('stores unmatched chat::echo as a processed user message', () => {
    const store = createTranscriptStore();

    const result = store.ingest(createMessage('chat::echo', {
      content: 'Hello from runtime',
      role: 'user',
      meta: {
        client_msg_id: 'msg_unmatched',
      },
    }, 7));

    expect(result.mutation?.type).toBe('message_added');
    expect(result.mutation?.message.role).toBe('user');
    expect(result.mutation?.message.deliveryStatus).toBe('processed');
    expect(store.getSnapshot()).toHaveLength(1);
  });

  it('does not reconcile chat::echo by seq when client_msg_id is missing', () => {
    const store = createTranscriptStore();

    store.upsertLocalMessage({
      id: 'client:msg_seq_only',
      seq: 21,
      type: 'chat::message',
      role: 'user',
      content: 'Same seq',
      status: 'final',
      deliveryStatus: 'sent',
      ts: '2026-05-14T18:35:00.000Z',
      clientMsgId: 'msg_seq_only',
      meta: {
        client_msg_id: 'msg_seq_only',
        timestamp_source: 'client',
      },
      originalPayload: {
        content: 'Same seq',
        meta: {
          client_msg_id: 'msg_seq_only',
        },
      },
    });

    const result = store.ingest({
      type: 'chat::echo',
      schema: '1.0',
      session_id: 'sess_test',
      seq: 21,
      ts: '2026-05-14T18:35:02.000Z',
      payload: {
        role: 'user',
        content: 'Same seq',
      },
    });

    expect(result.mutation?.type).toBe('message_added');
    expect(store.getSnapshot()).toHaveLength(2);
    expect(store.getSnapshot()[0].deliveryStatus).toBe('sent');
  });

  it('does not reconcile operator chat::echo even with the same client_msg_id', () => {
    const store = createTranscriptStore();

    store.upsertLocalMessage({
      id: 'client:msg_operator',
      type: 'chat::message',
      role: 'user',
      content: 'User text',
      status: 'final',
      deliveryStatus: 'sent',
      ts: '2026-05-14T18:35:00.000Z',
      clientMsgId: 'msg_operator',
      meta: {
        client_msg_id: 'msg_operator',
        timestamp_source: 'client',
      },
      originalPayload: {
        content: 'User text',
        meta: {
          client_msg_id: 'msg_operator',
        },
      },
    });

    const result = store.ingest(createMessage('chat::echo', {
      content: 'Operator text',
      role: 'operator',
      meta: {
        client_msg_id: 'msg_operator',
      },
    }, 22));

    expect(result.mutation?.type).toBe('message_added');
    const snapshot = store.getSnapshot();
    expect(snapshot).toHaveLength(2);
    expect(snapshot[0]).toMatchObject({
      id: 'client:msg_operator',
      role: 'user',
      deliveryStatus: 'sent',
    });
    expect(snapshot[1]).toMatchObject({
      role: 'operator',
      content: 'Operator text',
    });
  });

  it('does not reconcile server-loaded user messages without local send identity', () => {
    const store = createTranscriptStore({
      initialTranscript: [{
        id: 'client:historic',
        type: 'chat::message',
        role: 'user',
        content: 'Historical user message',
        status: 'final',
        deliveryStatus: 'sent',
        ts: '2026-05-14T18:30:00.000Z',
        clientMsgId: 'historic',
        meta: {
          client_msg_id: 'historic',
        },
      }],
    });

    const result = store.ingest(createMessage('chat::echo', {
      content: 'Historical user message',
      role: 'user',
      meta: {
        client_msg_id: 'historic',
      },
    }, 23));

    expect(result.mutation?.type).toBe('message_added');
    expect(store.getSnapshot()).toHaveLength(2);
  });

  it('reconciles two identical pending messages by their distinct client_msg_id values', () => {
    const store = createTranscriptStore();

    for (const clientMsgId of ['same_1', 'same_2']) {
      store.upsertLocalMessage({
        id: `client:${clientMsgId}`,
        type: 'chat::message',
        role: 'user',
        content: 'Test',
        status: 'final',
        deliveryStatus: 'sent',
        ts: '2026-05-14T18:35:00.000Z',
        clientMsgId,
        meta: {
          client_msg_id: clientMsgId,
          timestamp_source: 'client',
        },
        originalPayload: {
          content: 'Test',
          meta: {
            client_msg_id: clientMsgId,
          },
        },
      });
    }

    store.ingest(createMessage('chat::echo', {
      content: 'Test',
      role: 'user',
      meta: {
        client_msg_id: 'same_2',
      },
    }, 24));
    store.ingest(createMessage('chat::echo', {
      content: 'Test',
      role: 'user',
      meta: {
        client_msg_id: 'same_1',
      },
    }, 25));

    const snapshot = store.getSnapshot();
    expect(snapshot).toHaveLength(2);
    expect(snapshot.map((message) => message.id)).toEqual(['client:same_1', 'client:same_2']);
    expect(snapshot.map((message) => message.deliveryStatus)).toEqual(['processed', 'processed']);
    expect(snapshot.map((message) => message.seq)).toEqual([25, 24]);
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
