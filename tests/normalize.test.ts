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

  it('normalizes chat::echo as a user message and prefers content over payload.message', () => {
    const normalized = normalizeCortexMessage(createMessage('chat::echo', {
      content: 'Echo text',
      role: 'user',
      meta: {
        client_msg_id: 'msg_1',
      },
      message: {
        text: 'ignored',
      },
    }));

    expect(normalized).toMatchObject({
      type: 'chat::echo',
      role: 'user',
      content: 'Echo text',
      status: 'final',
      clientMsgId: 'msg_1',
    });
  });

  it('normalizes chat::forward and chat::hail visible content from payload.message.text', () => {
    const forward = normalizeCortexMessage(createMessage('chat::forward', {
      role: 'user',
      message: { text: 'Forwarded text' },
      meta: {
        actor: { name: 'Bubble Actor' },
      },
    }));
    const hail = normalizeCortexMessage(createMessage('chat::hail', {
      role: 'assistant',
      message: { text: 'Proactive hello' },
      meta: {
        actor: { name: 'Bubble Actor' },
      },
    }));

    expect(forward).toMatchObject({
      type: 'chat::forward',
      role: 'user',
      content: 'Forwarded text',
    });
    expect(hail).toMatchObject({
      type: 'chat::hail',
      role: 'assistant',
      content: 'Proactive hello',
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

  it('preserves payload.meta.chat_title in ChatMessageViewModel.meta and does not render it as content', () => {
    const normalized = normalizeCortexMessage(createMessage('chat::answer', {
      content: 'Here is the answer.',
      role: 'assistant',
      answer_kind: 'final',
      turn_id: 'turn_title',
      meta: {
        chat_title: 'Contract Review Session',
      },
    }));

    expect(normalized.meta?.chat_title).toBe('Contract Review Session');
    expect(normalized.content).toBe('Here is the answer.');
    expect(String(normalized.content)).not.toContain('Contract Review Session');
  });
});
