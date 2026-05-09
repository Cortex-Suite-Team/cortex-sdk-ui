import {
  createChatController,
  createEscalationController,
} from '../src/index.js';
import { createMessage, createMockClient } from './helpers.js';

describe('sdk-ui controllers', () => {
  it('controller creation does not subscribe immediately', () => {
    const client = createMockClient();
    createChatController({ client });

    expect(client.subscriptionCalls).toBe(0);
    expect(client.activeListenerCount()).toBe(0);
  });

  it('connect delegates to client', async () => {
    const client = createMockClient();
    const controller = createChatController({ client });

    await controller.connect();

    expect(client.connectCalls).toBe(1);
    expect(client.subscriptionCalls).toBe(1);
    expect(client.activeListenerCount()).toBe(1);
  });

  it('repeated connect or sendMessage does not duplicate subscription', async () => {
    const client = createMockClient();
    const controller = createChatController({ client });

    await controller.connect();
    await controller.connect();
    await controller.sendMessage({ content: 'Hello' });

    expect(client.subscriptionCalls).toBe(1);
    expect(client.activeListenerCount()).toBe(1);
  });

  it('disconnect unsubscribes from client', async () => {
    const client = createMockClient();
    const controller = createChatController({ client });

    await controller.connect();
    await controller.disconnect();

    expect(client.activeListenerCount()).toBe(0);
    expect(client.unsubscriptionCalls).toBe(1);
  });

  it('destroy is idempotent', async () => {
    const client = createMockClient();
    const controller = createChatController({ client });

    await controller.connect();
    controller.destroy();
    controller.destroy();

    expect(client.activeListenerCount()).toBe(0);
    expect(client.unsubscriptionCalls).toBe(1);
  });

  it('sendMessage returns ok=true on successful transport send', async () => {
    const client = createMockClient();
    const controller = createChatController({ client });

    const result = await controller.sendMessage({ content: 'Hello' });

    expect(result.ok).toBe(true);
    expect(typeof result.messageId).toBe('string');
    expect(result.messageId.startsWith('client:')).toBe(true);
    expect(typeof result.clientMsgId).toBe('string');
  });

  it('sendMessage creates optimistic user message with deliveryStatus sending then sent', async () => {
    const client = createMockClient();
    const states: ReturnType<typeof controller.getState>[] = [];
    const controller = createChatController({
      client,
      onStateChange: (s) => states.push(s),
    });

    await controller.sendMessage({ content: 'Hello' });

    const transcript = controller.getState().transcript;
    expect(transcript).toHaveLength(1);
    expect(transcript[0].role).toBe('user');
    expect(transcript[0].content).toEqual('Hello');
    expect(transcript[0].deliveryStatus).toBe('sent');
  });

  it('sendMessage sends payload with client_msg_id in meta', async () => {
    const client = createMockClient();
    const controller = createChatController({ client });

    await controller.sendMessage({ content: 'Hi', meta: { question_id: 'q1' } });

    expect(client.sentMessages).toHaveLength(1);
    const sent = client.sentMessages[0];
    expect(sent.content).toBe('Hi');
    expect(sent.meta).toMatchObject({ question_id: 'q1' });
    expect(typeof sent.meta?.['client_msg_id']).toBe('string');
    expect((sent.meta?.['client_msg_id'] as string).length).toBeGreaterThan(0);
  });

  it('sendMessage returns ok=false on transport failure', async () => {
    const client = createMockClient();
    client.setSendError(new Error('WebSocket closed'));
    const controller = createChatController({ client });

    const result = await controller.sendMessage({ content: 'Hello' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('WebSocket closed');
      expect(typeof result.messageId).toBe('string');
      expect(typeof result.clientMsgId).toBe('string');
    }
  });

  it('sendMessage on network failure sets deliveryStatus failed with retryable', async () => {
    const client = createMockClient();
    client.setSendError(new Error('WebSocket closed'));
    const controller = createChatController({ client });

    await controller.sendMessage({ content: 'Hello' });

    const transcript = controller.getState().transcript;
    expect(transcript).toHaveLength(1);
    expect(transcript[0].deliveryStatus).toBe('failed');
    expect(transcript[0].retryable).toBe(true);
    expect(transcript[0].sendError).toBe('WebSocket closed');
  });

  it('retryMessage resends originalPayload and returns ok=true on success', async () => {
    const client = createMockClient();
    client.setSendError(new Error('offline'));
    const controller = createChatController({ client });

    await controller.sendMessage({ content: 'Retry me' });
    const failedId = controller.getState().transcript[0].id;
    // Mock throws before recording, so sentMessages is empty after failed send
    expect(client.sentMessages).toHaveLength(0);

    client.setSendError(null);
    const retryResult = await controller.retryMessage(failedId);

    expect(retryResult).not.toBeNull();
    expect(retryResult?.ok).toBe(true);
    if (retryResult?.ok) {
      expect(retryResult.messageId).toBe(failedId);
    }

    const transcript = controller.getState().transcript;
    expect(transcript).toHaveLength(1);
    expect(transcript[0].id).toBe(failedId);
    expect(transcript[0].deliveryStatus).toBe('sent');
    expect(transcript[0].retryable).toBe(false);
    // Retry recorded exactly one successful send
    expect(client.sentMessages).toHaveLength(1);
    expect(client.sentMessages[0].content).toBe('Retry me');
  });

  it('retryMessage on failure returns ok=false and keeps deliveryStatus failed', async () => {
    const client = createMockClient();
    client.setSendError(new Error('offline'));
    const controller = createChatController({ client });

    await controller.sendMessage({ content: 'Broken' });
    const failedId = controller.getState().transcript[0].id;

    const retryResult = await controller.retryMessage(failedId);

    expect(retryResult?.ok).toBe(false);
    expect(controller.getState().transcript[0].deliveryStatus).toBe('failed');
    expect(controller.getState().transcript[0].retryable).toBe(true);
  });

  it('retryMessage returns null for non-retryable messages and does not send', async () => {
    const client = createMockClient();
    const controller = createChatController({ client });

    await controller.sendMessage({ content: 'OK' });
    const msgId = controller.getState().transcript[0].id;
    const sendCountBefore = client.sentMessages.length;

    const retryResult = await controller.retryMessage(msgId);

    expect(retryResult).toBeNull();
    expect(client.sentMessages.length).toBe(sendCountBefore);
  });

  it('retryMessage does not create a new bubble', async () => {
    const client = createMockClient();
    client.setSendError(new Error('offline'));
    const controller = createChatController({ client });

    await controller.sendMessage({ content: 'Once' });
    const failedId = controller.getState().transcript[0].id;

    client.setSendError(null);
    await controller.retryMessage(failedId);

    expect(controller.getState().transcript).toHaveLength(1);
    expect(controller.getState().transcript[0].id).toBe(failedId);
  });

  it('system::state event does not change user message deliveryStatus', async () => {
    const client = createMockClient();
    const controller = createChatController({ client });

    await controller.connect();
    await controller.sendMessage({ content: 'Hello' });
    const msgId = controller.getState().transcript[0].id;

    client.emit(createMessage('system::state', { meta: { state: 'working', label: 'Thinking…', ttl_ms: 5000 } }));

    const msg = controller.getState().transcript.find((m) => m.id === msgId);
    expect(msg?.deliveryStatus).toBe('sent');
  });

  it('chat::answer does not mutate user message deliveryStatus', async () => {
    const client = createMockClient();
    const controller = createChatController({ client });

    await controller.connect();
    await controller.sendMessage({ content: 'Hello' });
    const msgId = controller.getState().transcript[0].id;

    client.emit(createMessage('chat::answer', { content: 'Hi there', role: 'assistant', turn_id: 'turn_1' }));

    const userMsg = controller.getState().transcript.find((m) => m.id === msgId);
    expect(userMsg?.deliveryStatus).toBe('sent');
  });

  it('creates escalation state from escalation::request', async () => {
    const client = createMockClient();
    const events: string[] = [];
    const controller = createChatController({
      client,
      onEvent: (event) => events.push(event.type),
    });

    await controller.connect();
    client.emit(createMessage('escalation::request', {
      escalation_id: 'esc_1',
      content: 'Need approval',
      reason: 'requires_human_approval',
      wait_token: 'wait_1',
      allowed_actions: ['continue', 'operator_input', 'reply_user'],
    }));

    expect(controller.getState().escalation).toMatchObject({
      escalationId: 'esc_1',
      status: 'pending',
    });
    expect(events).toContain('escalation_opened');
  });

  it('validates allowed actions before calling replyEscalation', async () => {
    const client = createMockClient();
    const errors: string[] = [];
    const controller = createChatController({
      client,
      onEvent: (event) => {
        if (event.type === 'error') {
          errors.push(event.error.code);
        }
      },
    });

    await controller.connect();
    client.emit(createMessage('escalation::request', {
      escalation_id: 'esc_1',
      content: 'Need approval',
      reason: 'requires_human_approval',
      wait_token: 'wait_1',
      allowed_actions: ['continue'],
    }));

    await expect(controller.replyToUser('Hello')).rejects.toMatchObject({
      code: 'action_not_allowed',
    });
    expect(errors).toContain('action_not_allowed');
    expect(client.escalationReplies).toHaveLength(0);
  });

  it('replyToUser calls replyEscalation with reply_user', async () => {
    const client = createMockClient();
    const controller = createChatController({ client });

    await controller.connect();
    client.emit(createMessage('escalation::request', {
      escalation_id: 'esc_1',
      content: 'Need approval',
      reason: 'requires_human_approval',
      wait_token: 'wait_1',
      allowed_actions: ['reply_user'],
    }));

    await controller.replyToUser('Reply to user');

    expect(client.escalationReplies).toEqual([{
      escalationId: 'esc_1',
      waitToken: 'wait_1',
      action: 'reply_user',
      content: 'Reply to user',
    }]);
  });

  it('returnToWorker calls replyEscalation with operator_input', async () => {
    const client = createMockClient();
    const controller = createChatController({ client });

    await controller.connect();
    client.emit(createMessage('escalation::request', {
      escalation_id: 'esc_2',
      content: 'Need approval',
      reason: 'requires_human_approval',
      wait_token: 'wait_2',
      allowed_actions: ['operator_input'],
    }));

    await controller.returnToWorker({ resolution: 'approved' });

    expect(client.escalationReplies).toEqual([{
      escalationId: 'esc_2',
      waitToken: 'wait_2',
      action: 'operator_input',
      content: { resolution: 'approved' },
    }]);
  });

  it('continueWorker calls replyEscalation with continue', async () => {
    const client = createMockClient();
    const controller = createChatController({ client });

    await controller.connect();
    client.emit(createMessage('escalation::request', {
      escalation_id: 'esc_3',
      content: 'Need approval',
      reason: 'requires_human_approval',
      wait_token: 'wait_3',
      allowed_actions: ['continue'],
    }));

    await controller.continueWorker();

    expect(client.escalationReplies).toEqual([{
      escalationId: 'esc_3',
      waitToken: 'wait_3',
      action: 'continue',
    }]);
  });

  it('fails clearly when replyEscalation is missing', async () => {
    const client = createMockClient({ replyEscalation: null });
    const errors: string[] = [];
    const controller = createChatController({
      client,
      onEvent: (event) => {
        if (event.type === 'error') {
          errors.push(event.error.code);
        }
      },
    });

    await controller.connect();
    client.emit(createMessage('escalation::request', {
      escalation_id: 'esc_4',
      content: 'Need approval',
      reason: 'requires_human_approval',
      wait_token: 'wait_4',
      allowed_actions: ['continue'],
    }));

    await expect(controller.continueWorker()).rejects.toMatchObject({
      code: 'reply_escalation_missing',
    });
    expect(errors).toContain('reply_escalation_missing');
  });

  it('fails clearly when waitToken is missing unless replyRequestBuilder override is provided', async () => {
    const client = createMockClient();
    const controller = createChatController({ client });

    await controller.connect();
    client.emit(createMessage('escalation::request', {
      escalation_id: 'esc_5',
      content: 'Need approval',
      reason: 'requires_human_approval',
      allowed_actions: ['continue'],
    }));

    await expect(controller.continueWorker()).rejects.toMatchObject({
      code: 'wait_token_missing',
    });

    const overrideClient = createMockClient();
    const overrideController = createChatController({
      client: overrideClient,
      replyRequestBuilder: ({ escalation, action }) => ({
        escalationId: escalation.escalationId,
        action,
        route: 'control-plane',
      }),
    });

    await overrideController.connect();
    overrideClient.emit(createMessage('escalation::request', {
      escalation_id: 'esc_6',
      content: 'Need approval',
      reason: 'requires_human_approval',
      allowed_actions: ['continue'],
    }));

    await overrideController.continueWorker();
    expect(overrideClient.escalationReplies).toEqual([{
      escalationId: 'esc_6',
      action: 'continue',
      route: 'control-plane',
    }]);
  });

  it('sets activeQuestion when chat::question is received', async () => {
    const client = createMockClient();
    const controller = createChatController({ client });

    await controller.connect();
    client.emit(createMessage('chat::question', {
      role: 'assistant',
      content: 'Choose one',
      turn_id: 'turn_q1',
      meta: {
        question_id: 'q_1',
        input_type: 'radio',
        allow_reply: true,
        options: [
          { id: 'a', label: 'Option A' },
          { id: 'b', label: 'Option B' },
        ],
      },
    }));

    expect(controller.getState().activeQuestion).toMatchObject({
      question_id: 'q_1',
      input_type: 'radio',
      allow_reply: true,
      options: [
        { id: 'a', label: 'Option A' },
        { id: 'b', label: 'Option B' },
      ],
    });
    expect(controller.getState().transcript).toHaveLength(1);
    expect(controller.getState().transcript[0].type).toBe('chat::question');
  });

  it('clears activeQuestion on chat::answer', async () => {
    const client = createMockClient();
    const controller = createChatController({ client });

    await controller.connect();
    client.emit(createMessage('chat::question', {
      role: 'assistant',
      content: 'Choose one',
      meta: {
        question_id: 'q_2',
        input_type: 'radio',
        allow_reply: false,
        options: [{ id: 'a', label: 'Option A' }],
      },
    }, 1));

    expect(controller.getState().activeQuestion?.question_id).toBe('q_2');

    client.emit(createMessage('chat::answer', {
      role: 'assistant',
      content: 'Done',
      turn_id: 'turn_a1',
      answer_kind: 'final',
    }, 2));

    expect(controller.getState().activeQuestion).toBeNull();
  });

  it('clears activeQuestion on system::error', async () => {
    const client = createMockClient();
    const controller = createChatController({ client });

    await controller.connect();
    client.emit(createMessage('chat::question', {
      role: 'assistant',
      content: 'Choose one',
      meta: {
        question_id: 'q_3',
        input_type: 'radio',
        allow_reply: true,
        options: [{ id: 'a', label: 'Option A' }],
      },
    }, 1));

    expect(controller.getState().activeQuestion).not.toBeNull();

    client.emit(createMessage('system::error', {
      code: 'runtime_error',
      message: 'Something failed',
    }, 2));

    expect(controller.getState().activeQuestion).toBeNull();
  });

  it('filters malformed options from activeQuestion', async () => {
    const client = createMockClient();
    const controller = createChatController({ client });

    await controller.connect();
    client.emit(createMessage('chat::question', {
      role: 'assistant',
      content: 'Choose',
      meta: {
        question_id: 'q_4',
        input_type: 'radio',
        allow_reply: false,
        options: [
          { id: 'ok', label: 'Valid' },
          { id: '', label: 'Missing ID' },
          null,
          { id: 'no-label' },
        ],
      },
    }, 1));

    const { activeQuestion } = controller.getState();
    expect(activeQuestion?.options).toHaveLength(1);
    expect(activeQuestion?.options[0]).toEqual({ id: 'ok', label: 'Valid' });
  });

  it('sendMessage forwards meta to client', async () => {
    const client = createMockClient();
    const controller = createChatController({ client });

    await controller.sendMessage({
      content: ['Approve'],
      meta: { question_id: 'q_1', selected_option: 'approve' },
    });

    expect(client.sentMessages[0]).toMatchObject({
      content: ['Approve'],
      meta: { question_id: 'q_1', selected_option: 'approve' },
    });
  });

  it('locks input for terminal session state', () => {
    const client = createMockClient();
    client.sessionState = 'FAILED';
    const controller = createChatController({ client });

    expect(controller.getState().input).toEqual({
      locked: true,
      reason: 'session_failed',
    });
  });

  it('fires state change callback and message events', async () => {
    const client = createMockClient();
    const states: number[] = [];
    const events: string[] = [];
    const controller = createChatController({
      client,
      onStateChange: () => {
        states.push(1);
      },
      onEvent: (event) => {
        events.push(event.type);
      },
    });

    await controller.connect();
    client.emit(createMessage('chat::message', {
      content: 'Hello',
      role: 'user',
    }));

    expect(states.length).toBeGreaterThan(0);
    expect(events).toContain('message_added');
    expect(events).toContain('state_changed');
  });

  it('supports standalone escalation controller helper methods', async () => {
    const client = createMockClient();
    const escalation = createEscalationController({ client });

    escalation.ingest(createMessage('escalation::request', {
      escalation_id: 'esc_7',
      content: 'Need approval',
      reason: 'requires_human_approval',
      wait_token: 'wait_7',
      allowed_actions: ['continue'],
    }));

    await escalation.continueWorker();

    expect(client.escalationReplies[0]).toMatchObject({
      escalationId: 'esc_7',
      waitToken: 'wait_7',
      action: 'continue',
    });
  });
});
