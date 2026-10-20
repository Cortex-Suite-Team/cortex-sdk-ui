import { createChatController, createHumanAssistanceController } from '../src/index.js';
import type {
  HumanAssistanceNotification, HumanAssistanceRequest, ReplyHumanAssistanceOptions,
} from '../src/index.js';
import { createMockClient } from './helpers.js';

function request(id: string, options = [{ id: 'approve', label: 'Approve' }], allowText = true): HumanAssistanceRequest {
  return { version: 1, request_id: id, question: 'Decide?', options, allow_text: allowText,
    deadline_at: '2099-01-01T00:00:00Z', status: 'pending' };
}

function fixture() {
  const base = createMockClient();
  const handlers = new Set<(event: HumanAssistanceNotification) => void>();
  const replies: ReplyHumanAssistanceOptions[] = [];
  const client = Object.assign(base, {
    humanAssistanceRequests: [] as HumanAssistanceRequest[],
    onHumanAssistance(handler: (event: HumanAssistanceNotification) => void) {
      handlers.add(handler);
      return () => { handlers.delete(handler); };
    },
    async replyHumanAssistance(options: ReplyHumanAssistanceOptions) { replies.push({ ...options }); },
  });
  let id = 0;
  const controller = createHumanAssistanceController({ client, createClientReplyId: () => `reply-${++id}` });
  return {
    client, controller, replies,
    emit(event: HumanAssistanceNotification) { for (const handler of handlers) handler(event); },
    request(value: HumanAssistanceRequest) {
      client.humanAssistanceRequests.push(value);
      for (const handler of handlers) handler({ type: 'human_assistance::request', payload: value });
    },
    status(requestId: string, status: 'reply_accepted' | 'reply_rejected' | 'resolved' | 'expired' | 'revoked',
      extra: { client_reply_id?: string; reason?: 'unauthorized' | 'duplicate' | 'invalid_answer' | 'late' } = {}) {
      for (const handler of handlers) handler({ type: 'human_assistance::status',
        payload: { version: 1, request_id: requestId, status, ...extra } });
    },
  };
}

describe('headless Human Assistance cards', () => {
  it('submits option only, text only, option plus text, and explicit refusal on separate cards', async () => {
    const f = fixture();
    f.request(request('choice', [{ id: 'approve', label: 'Approve' }], false));
    f.request(request('text', [], true));
    f.request(request('mixed'));
    f.request(request('refuse'));
    expect(f.controller.getCards().map((card) => card.fields.map((field) => field.type)))
      .toEqual([['select'], ['text'], ['select', 'text'], ['select', 'text']]);
    expect(() => f.controller.setText('choice', 'forbidden')).toThrow();
    expect(() => f.controller.selectOption('mixed', 'unknown')).toThrow();
    expect(() => f.controller.submit('mixed')).toThrow();
    f.controller.selectOption('choice', 'approve');
    await f.controller.submit('choice');
    f.controller.setText('text', 'Detailed answer');
    await f.controller.submit('text');
    f.controller.selectOption('mixed', 'approve');
    f.controller.setText('mixed', 'With context');
    await f.controller.submit('mixed');
    await f.controller.refuse('refuse');
    expect(f.replies).toEqual([
      { requestId: 'choice', clientReplyId: 'reply-1', action: 'answer', optionId: 'approve' },
      { requestId: 'text', clientReplyId: 'reply-2', action: 'answer', text: 'Detailed answer' },
      { requestId: 'mixed', clientReplyId: 'reply-3', action: 'answer', optionId: 'approve', text: 'With context' },
      { requestId: 'refuse', clientReplyId: 'reply-4', action: 'refuse' },
    ]);
    f.controller.destroy();
  });

  it('keeps stable retry payload, distinct ACK and terminal result, and server denial', async () => {
    const f = fixture();
    f.request(request('ambiguous'));
    f.controller.setText('ambiguous', 'Original');
    f.request({ ...request('ambiguous'), question: 'Conflicting replay' });
    expect(f.controller.getCards()[0]?.text).toBe('Original');
    const originalSend = f.client.replyHumanAssistance.bind(f.client);
    const attempts: ReplyHumanAssistanceOptions[] = [];
    f.client.replyHumanAssistance = async (options) => {
      attempts.push({ ...options });
      if (attempts.length === 1) throw new Error('network ambiguous');
      await originalSend(options);
    };
    await expect(f.controller.submit('ambiguous')).rejects.toThrow('network ambiguous');
    expect(f.controller.getCards()[0]).toMatchObject({ status: 'sent', error: 'network ambiguous', clientReplyId: 'reply-1' });
    expect(() => f.controller.submit('ambiguous')).toThrow();
    await f.controller.retry('ambiguous');
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toEqual(attempts[1]);
    f.status('ambiguous', 'reply_accepted', { client_reply_id: 'reply-1' });
    expect(f.controller.getCards()[0]?.status).toBe('accepted');
    expect(() => f.controller.retry('ambiguous')).toThrow();
    f.status('ambiguous', 'resolved');
    expect(f.controller.getCards()[0]?.status).toBe('resolved');
    f.request(request('denied'));
    await f.controller.refuse('denied');
    f.status('denied', 'reply_rejected', { client_reply_id: 'reply-2', reason: 'unauthorized' });
    expect(f.controller.getCards()[1]).toMatchObject({ status: 'rejected', reason: 'unauthorized' });
    expect(() => f.controller.retry('denied')).toThrow();
    f.controller.destroy();
  });

  it('does not send a second response while the first submission is in flight', async () => {
    const f = fixture();
    f.request(request('one'));
    f.controller.selectOption('one', 'approve');
    let finish!: () => void;
    f.client.replyHumanAssistance = async (options) => {
      f.replies.push({ ...options });
      await new Promise<void>((resolve) => { finish = resolve; });
    };
    const first = f.controller.submit('one');
    expect(() => f.controller.submit('one')).toThrow();
    expect(() => f.controller.retry('one')).toThrow();
    expect(f.replies).toHaveLength(1);
    finish();
    await first;
    f.controller.destroy();
  });

  it('suppresses terminal-first replay, expired submissions, and over-capacity unknown requests', () => {
    const f = fixture();
    for (const terminal of ['expired', 'revoked', 'resolved'] as const) {
      f.status(`closed-${terminal}`, terminal);
      f.request(request(`closed-${terminal}`));
    }
    expect(f.controller.getCards()).toEqual([]);
    f.request({ ...request('past'), deadline_at: '2000-01-01T00:00:00Z' });
    expect(() => f.controller.refuse('past')).toThrow();
    f.status('past', 'expired');
    expect(() => f.controller.selectOption('past', 'approve')).toThrow();
    for (let index = 0; index < 62; index += 1) f.status(`extra-${index}`, 'resolved');
    f.request(request('new-after-overflow'));
    expect(f.controller.getCards().map((card) => card.request.request_id)).toEqual(['past']);
    f.controller.reset();
    expect(f.controller.getCards()).toEqual([]);
    f.request(request('after-reset'));
    expect(f.controller.getCards()).toHaveLength(1);
    f.controller.destroy();
  });

  it('hydrates reconnect snapshot while unrelated DW A question, operator state and transcript stay intact', async () => {
    const f = fixture();
    const chat = createChatController({ client: f.client, transcriptPersistence: null });
    await chat.connect();
    f.client.emit({ type: 'chat::question', schema: '1.0', session_id: 'sess_test',
      payload: { content: ['DW A question'], meta: { question_ref: 'question-a', allow_reply: true } } });
    f.client.emit({ type: 'escalation::request', schema: '1.0', session_id: 'sess_test',
      payload: { escalation_id: 'operator-a', wait_token: 'operator-token', allowed_actions: ['reply_user'] } });
    const before = chat.getState();
    f.request(request('from-b'));
    f.request(request('from-c', [], true));
    f.controller.setText('from-b', 'Unsent draft');
    f.controller.sync();
    f.client.humanAssistanceRequests.push(request('from-d'));
    f.controller.sync();
    expect(f.controller.getCards()).toHaveLength(3);
    expect(f.controller.getCards()[0]?.text).toBe('Unsent draft');
    f.status('from-d', 'revoked');
    f.controller.sync();
    expect(f.controller.getCards().find((card) => card.request.request_id === 'from-d')?.status).toBe('revoked');
    expect(chat.getState()).toEqual(before);
    expect(f.client.sentMessages).toEqual([]);
    expect(f.client.escalationReplies).toEqual([]);
    await chat.disconnect();
    f.client.humanAssistanceRequests = [];
    f.controller.reset();
    expect(f.controller.getCards()).toEqual([]);
    f.controller.destroy();
    chat.destroy();
  });
});
