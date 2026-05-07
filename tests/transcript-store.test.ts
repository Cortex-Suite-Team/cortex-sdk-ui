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
});
