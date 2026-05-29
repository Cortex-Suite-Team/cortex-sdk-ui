import { normalizeCortexMessage, parseRawActor } from '../src/index.js';
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

  it('normalizes chat::question to assistant role and preserves canonical questions in meta', () => {
    const normalized = normalizeCortexMessage(createMessage('chat::question', {
      role: 'assistant',
      content: 'What should I do?',
      turn_id: 'turn_q1',
      meta: {
        actor: { kind: 'digital_worker', id: 'proj_1', name: 'Robot Vasya', title: 'Lawyer' },
        question_ref: 'q_123',
        input_type: 'form',
        allow_reply: true,
        resume_event_ref: 'local.hidden',
        questions: [
          {
            key: 'decision',
            label: 'Decision',
            type: 'select',
            options: [
              { id: 'approve', label: 'Approve' },
              { id: 'reject', label: 'Reject' },
            ],
          },
        ],
      },
    }));

    expect(normalized.type).toBe('chat::question');
    expect(normalized.role).toBe('assistant');
    expect(normalized.content).toBe('What should I do?');
    expect(normalized.status).toBe('final');
    expect(normalized.meta).toMatchObject({
      question_ref: 'q_123',
      input_type: 'form',
      allow_reply: true,
      actor: { kind: 'digital_worker', name: 'Robot Vasya' },
      questions: [
        {
          key: 'decision',
          label: 'Decision',
          type: 'select',
          options: [
            { id: 'approve', label: 'Approve' },
            { id: 'reject', label: 'Reject' },
          ],
        },
      ],
    });
    expect(normalized.meta).not.toHaveProperty('resume_event_ref');
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

describe('extractActor — actor field on ChatMessageViewModel', () => {
  it('extracts a valid actor from payload.meta.actor for chat::answer', () => {
    const normalized = normalizeCortexMessage(createMessage('chat::answer', {
      content: 'Hello',
      role: 'assistant',
      meta: {
        actor: { kind: 'digital_worker', id: 'proj_1', name: 'Robot Vasya', title: 'Lawyer', avatar_url: 'https://example.test/avatar.png' },
      },
    }));

    expect(normalized.actor).toEqual({
      kind: 'digital_worker',
      id: 'proj_1',
      name: 'Robot Vasya',
      title: 'Lawyer',
      subtitle: null,
      avatarUrl: 'https://example.test/avatar.png',
    });
  });

  it('returns actor=null when actor is absent on chat::answer', () => {
    const normalized = normalizeCortexMessage(createMessage('chat::answer', {
      content: 'Hello',
      role: 'assistant',
    }));
    expect(normalized.actor).toBeNull();
  });

  it('returns actor=null when actor is absent on chat::question', () => {
    const normalized = normalizeCortexMessage(createMessage('chat::question', {
      content: 'What to do?',
      role: 'assistant',
    }));
    expect(normalized.actor).toBeNull();
  });

  it('returns actor=null when actor is absent on escalation::reply', () => {
    const normalized = normalizeCortexMessage(createMessage('escalation::reply', {
      content: 'Operator replied',
      escalation_id: 'esc_1',
      action: 'reply_user',
    }));
    expect(normalized.actor).toBeNull();
  });

  it('returns actor=null when actor has no name', () => {
    const normalized = normalizeCortexMessage(createMessage('chat::answer', {
      content: 'Hello',
      role: 'assistant',
      meta: {
        actor: { kind: 'digital_worker' },
      },
    }));
    expect(normalized.actor).toBeNull();
  });

  it('returns actor=null when actor has no kind', () => {
    const normalized = normalizeCortexMessage(createMessage('chat::answer', {
      content: 'Hello',
      role: 'assistant',
      meta: {
        actor: { name: 'Robot Vasya' },
      },
    }));
    expect(normalized.actor).toBeNull();
  });

  it('returns actor=null when actor has an unknown kind', () => {
    const normalized = normalizeCortexMessage(createMessage('chat::answer', {
      content: 'Hello',
      role: 'assistant',
      meta: {
        actor: { kind: 'robot', name: 'Unknown Bot' },
      },
    }));
    expect(normalized.actor).toBeNull();
  });

  it('extracts actor from payload.actor (top-level) when payload.meta.actor is absent', () => {
    const normalized = normalizeCortexMessage(createMessage('chat::answer', {
      content: 'Hello',
      role: 'assistant',
      actor: { kind: 'digital_worker', name: 'Top-level Bot' },
    }));
    expect(normalized.actor).toMatchObject({ kind: 'digital_worker', name: 'Top-level Bot' });
  });

  it('payload.meta.actor wins over payload.actor when both present', () => {
    const normalized = normalizeCortexMessage(createMessage('chat::answer', {
      content: 'Hello',
      role: 'assistant',
      actor: { kind: 'operator', name: 'Top-level Actor' },
      meta: {
        actor: { kind: 'digital_worker', name: 'Meta Actor' },
      },
    }));
    expect(normalized.actor?.name).toBe('Meta Actor');
    expect(normalized.actor?.kind).toBe('digital_worker');
  });

  it('payload.actor wins over message.meta.actor when payload.meta.actor absent', () => {
    const message = {
      type: 'chat::answer',
      schema: '1.0',
      session_id: 'sess_test',
      seq: 1,
      ts: new Date(1000).toISOString(),
      meta: { actor: { kind: 'operator', name: 'Message-level Actor' } },
      payload: {
        content: 'Hello',
        role: 'assistant',
        actor: { kind: 'digital_worker', name: 'Payload-level Actor' },
      },
    };
    const normalized = normalizeCortexMessage(message);
    expect(normalized.actor?.name).toBe('Payload-level Actor');
    expect(normalized.actor?.kind).toBe('digital_worker');
  });

  it('extracts actor from message.meta.actor when no other source present', () => {
    const message = {
      type: 'chat::answer',
      schema: '1.0',
      session_id: 'sess_test',
      seq: 1,
      ts: new Date(1000).toISOString(),
      meta: { actor: { kind: 'operator', name: 'Message-level Actor' } },
      payload: { content: 'Hello', role: 'assistant' },
    };
    const normalized = normalizeCortexMessage(message);
    expect(normalized.actor?.name).toBe('Message-level Actor');
    expect(normalized.actor?.kind).toBe('operator');
  });

  it('normalizes avatar_url (snake_case) to avatarUrl', () => {
    const normalized = normalizeCortexMessage(createMessage('chat::answer', {
      content: 'Hello',
      role: 'assistant',
      meta: {
        actor: { kind: 'digital_worker', name: 'Bot', avatar_url: 'https://example.test/av.png' },
      },
    }));
    expect(normalized.actor?.avatarUrl).toBe('https://example.test/av.png');
  });

  it('prefers camelCase avatarUrl over snake_case avatar_url', () => {
    const normalized = normalizeCortexMessage(createMessage('chat::answer', {
      content: 'Hello',
      role: 'assistant',
      meta: {
        actor: { kind: 'digital_worker', name: 'Bot', avatarUrl: 'https://camel.test/av.png', avatar_url: 'https://snake.test/av.png' },
      },
    }));
    expect(normalized.actor?.avatarUrl).toBe('https://camel.test/av.png');
  });

  it('chat::message (user) sets actor=null without requiring actor', () => {
    const normalized = normalizeCortexMessage(createMessage('chat::message', {
      content: 'Hello',
      role: 'user',
    }));
    expect(normalized.actor).toBeNull();
  });

  it('escalation::request sets actor=null (system marker, actor not required)', () => {
    const normalized = normalizeCortexMessage(createMessage('escalation::request', {
      escalation_id: 'esc_1',
      reason: 'needs help',
      allowed_actions: ['reply_user'],
    }));
    expect(normalized.actor).toBeNull();
  });

  it('transport alias "human_operator" normalizes to canonical actor kind "operator"', () => {
    const normalized = normalizeCortexMessage(createMessage('chat::echo', {
      content: 'Support reply',
      role: 'operator',
      meta: {
        actor: { kind: 'human_operator', name: 'Support' },
      },
    }));
    expect(normalized.actor?.kind).toBe('operator');
    expect(normalized.actor?.name).toBe('Support');
  });

  it('chat::echo with client_msg_id in payload.meta sets normalized clientMsgId', () => {
    const normalized = normalizeCortexMessage(createMessage('chat::echo', {
      content: 'Hello',
      role: 'user',
      meta: {
        client_msg_id: 'cmsg_abc123',
      },
    }));
    expect(normalized.clientMsgId).toBe('cmsg_abc123');
  });
});

describe('parseRawActor', () => {
  it('returns null for null input', () => {
    expect(parseRawActor(null)).toBeNull();
  });

  it('returns null for non-object input', () => {
    expect(parseRawActor('digital_worker')).toBeNull();
    expect(parseRawActor(42)).toBeNull();
  });

  it('returns null when kind is missing', () => {
    expect(parseRawActor({ name: 'Aria' })).toBeNull();
  });

  it('returns null when name is missing', () => {
    expect(parseRawActor({ kind: 'digital_worker' })).toBeNull();
  });

  it('returns null for unknown kind', () => {
    expect(parseRawActor({ kind: 'robot', name: 'Aria' })).toBeNull();
  });

  it('parses a full digital_worker actor with camelCase avatarUrl', () => {
    const actor = parseRawActor({
      kind: 'digital_worker',
      id: 'proj_1',
      name: 'Aria',
      title: 'Digital worker',
      subtitle: '',
      avatarUrl: 'https://example.com/avatar.png',
    });
    expect(actor).toEqual({
      kind: 'digital_worker',
      id: 'proj_1',
      name: 'Aria',
      title: 'Digital worker',
      subtitle: null,
      avatarUrl: 'https://example.com/avatar.png',
    });
  });

  it('normalizes snake_case avatar_url to avatarUrl', () => {
    const actor = parseRawActor({
      kind: 'digital_worker',
      name: 'Aria',
      avatar_url: '/static/avatar.png',
    });
    expect(actor?.avatarUrl).toBe('/static/avatar.png');
  });

  it('prefers camelCase avatarUrl over snake_case avatar_url', () => {
    const actor = parseRawActor({
      kind: 'digital_worker',
      name: 'Aria',
      avatarUrl: 'camel.png',
      avatar_url: 'snake.png',
    });
    expect(actor?.avatarUrl).toBe('camel.png');
  });

  it('normalizes human_operator kind to operator', () => {
    const actor = parseRawActor({ kind: 'human_operator', name: 'Jane' });
    expect(actor?.kind).toBe('operator');
  });

  it('parses operator actor', () => {
    const actor = parseRawActor({ kind: 'operator', name: 'Bob Smith' });
    expect(actor).toEqual({
      kind: 'operator',
      id: null,
      name: 'Bob Smith',
      title: null,
      subtitle: null,
      avatarUrl: null,
    });
  });
});
