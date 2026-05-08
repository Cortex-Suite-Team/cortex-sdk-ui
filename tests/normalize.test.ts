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

  it('normalizes chat::question to assistant role and preserves actor and options in meta', () => {
    const normalized = normalizeCortexMessage(createMessage('chat::question', {
      role: 'assistant',
      content: 'What should I do?',
      turn_id: 'turn_q1',
      meta: {
        actor: { kind: 'digital_worker', id: 'proj_1', name: 'Robot Vasya', title: 'Lawyer' },
        question_id: 'q_123',
        input_type: 'radio',
        allow_reply: true,
        options: [
          { id: 'approve', label: 'Approve' },
          { id: 'reject', label: 'Reject' },
        ],
      },
    }));

    expect(normalized.type).toBe('chat::question');
    expect(normalized.role).toBe('assistant');
    expect(normalized.content).toBe('What should I do?');
    expect(normalized.status).toBe('final');
    expect(normalized.meta).toMatchObject({
      question_id: 'q_123',
      input_type: 'radio',
      allow_reply: true,
      actor: { kind: 'digital_worker', name: 'Robot Vasya' },
      options: [
        { id: 'approve', label: 'Approve' },
        { id: 'reject', label: 'Reject' },
      ],
    });
  });

  it('preserves payload.meta.actor for chat::answer', () => {
    const normalized = normalizeCortexMessage(createMessage('chat::answer', {
      content: 'Hello',
      role: 'assistant',
      turn_id: 'turn_1',
      answer_kind: 'final',
      meta: {
        actor: { kind: 'digital_worker', id: 'proj_1', name: 'Robot Vasya' },
      },
    }));

    expect(normalized.meta?.actor).toMatchObject({ kind: 'digital_worker', name: 'Robot Vasya' });
  });

  it('preserves payload.meta.actor for chat::partial', () => {
    const normalized = normalizeCortexMessage(createMessage('chat::partial', {
      role: 'assistant',
      turn_id: 'turn_1',
      content: 'partial chunk',
      meta: {
        actor: { kind: 'digital_worker', name: 'Robot Vasya' },
      },
    }));

    expect(normalized.meta?.actor).toMatchObject({ kind: 'digital_worker', name: 'Robot Vasya' });
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
