import { normalizeCortexMessage } from '../src/index.js';
import { createMessage } from './helpers.js';

describe('normalizeCortexMessage', () => {
  it('normalizes chat::message', () => {
    const normalized = normalizeCortexMessage(createMessage('chat::message', {
      content: 'Hello',
      role: 'user',
    }));

    expect(normalized).toMatchObject({
      type: 'chat::message',
      role: 'user',
      content: 'Hello',
      status: 'final',
    });
  });

  it('preserves unknown message types without crashing', () => {
    const normalized = normalizeCortexMessage(createMessage('custom::unknown', {
      foo: 'bar',
    }));

    expect(normalized.type).toBe('custom::unknown');
    expect(normalized.role).toBe('system');
    expect(normalized.content).toEqual({ foo: 'bar' });
  });

  it('preserves attachments for chat::answer', () => {
    const normalized = normalizeCortexMessage(createMessage('chat::answer', {
      content: 'Here is your file.',
      role: 'assistant',
      answer_kind: 'final',
      turn_id: 'turn_1',
      attachments: [{
        file_id: 'file_1',
        filename: 'report.pdf',
        download_url: 'https://example.test/download/report.pdf',
      }],
    }));

    expect(normalized.meta).toMatchObject({
      turnId: 'turn_1',
      answerKind: 'final',
      attachments: [{
        file_id: 'file_1',
        filename: 'report.pdf',
        download_url: 'https://example.test/download/report.pdf',
      }],
    });
  });
});
