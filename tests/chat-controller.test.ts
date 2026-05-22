import { jest } from '@jest/globals';
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

  it('starts with session.correspondent unset before system::opened', () => {
    const client = createMockClient();
    client.sessionContext = {
      sessionId: 'sess_test',
      correspondent: {
        kind: 'digital_worker',
        id: 'project_123',
        name: 'Robot Vasya',
        title: 'Legal Assistant',
        subtitle: 'Contract review worker',
        avatarUrl: 'https://example.test/avatar.png',
      },
    };

    const controller = createChatController({ client });

    expect(controller.getState().session.correspondent).toBeNull();
  });

  it('system::opened sets session.correspondent from client sessionContext.correspondent', async () => {
    const client = createMockClient();
    client.sessionContext = {
      sessionId: 'sess_test',
      correspondent: {
        kind: 'digital_worker',
        id: 'project_ctx',
        name: 'Context Worker',
        title: 'Trusted Identity',
        subtitle: null,
        avatarUrl: null,
      },
    };
    const controller = createChatController({ client });
    await controller.connect();
    client.emit(createMessage('system::opened', { status: 'initializing' }));

    expect(controller.getState().session.correspondent).toMatchObject({
      kind: 'digital_worker',
      id: 'project_ctx',
      name: 'Context Worker',
      title: 'Trusted Identity',
    });
  });

  it('sendMessage does not overwrite session-level correspondent state', async () => {
    const client = createMockClient();
    client.sessionContext = {
      sessionId: 'sess_test',
      correspondent: {
        name: 'Stable Worker',
        title: 'Trusted Identity',
        avatarUrl: 'https://example.test/stable.png',
      },
    };
    const controller = createChatController({ client });
    await controller.connect();
    client.emit(createMessage('system::opened', { status: 'initializing' }));

    await controller.sendMessage({
      content: 'Hello',
      meta: {
        actor: {
          name: 'Optimistic User Actor',
        },
      },
    });

    expect(controller.getState().session.correspondent).toMatchObject({
      name: 'Stable Worker',
      title: 'Trusted Identity',
      avatarUrl: 'https://example.test/stable.png',
    });
  });

  it('returns session.correspondent null when system::opened has no correspondent in client sessionContext', async () => {
    const malformedClient = createMockClient();
    malformedClient.sessionContext = {
      sessionId: 'sess_test',
      correspondent: {
        title: 'Missing name',
      } as never,
    };

    const missingClient = createMockClient();

    const malformedController = createChatController({ client: malformedClient });
    const missingController = createChatController({ client: missingClient });

    await malformedController.connect();
    await missingController.connect();
    malformedClient.emit(createMessage('system::opened', { status: 'initializing' }));
    missingClient.emit(createMessage('system::opened', { status: 'initializing' }));

    expect(malformedController.getState().session.correspondent).toBeNull();
    expect(missingController.getState().session.correspondent).toBeNull();
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
    expect(controller.getState().input).toMatchObject({
      locked: true,
      reason: 'awaiting_answer',
    });
  });

  it('sendMessage does not emit console.debug by default', async () => {
    const debugSpy = jest.spyOn(console, 'debug').mockImplementation(() => {});
    const client = createMockClient();
    const controller = createChatController({ client });

    await controller.sendMessage({ content: 'Hello' });

    expect(debugSpy).not.toHaveBeenCalled();
    debugSpy.mockRestore();
  });

  it('locks input while the session is opening', () => {
    const client = createMockClient();
    client.channelState = 'CONNECTING';
    client.sessionId = null;

    const controller = createChatController({ client });

    expect(controller.getState().input).toEqual({
      locked: true,
      reason: 'session_opening',
    });
  });

  it('locks input when the channel is open but session is not ready', () => {
    const client = createMockClient();
    client.channelState = 'OPEN';
    client.sessionId = null;
    client.sessionState = 'INITIALIZING';

    const controller = createChatController({ client });

    expect(controller.getState().input).toEqual({
      locked: true,
      reason: 'session_not_ready',
    });
  });

  it('passes session readiness fields into custom inputLockPolicy', () => {
    const client = createMockClient();
    client.channelState = 'OPEN';
    client.sessionId = 'sess_policy';

    const seenArgs: Array<Record<string, unknown>> = [];
    const inputLockPolicy = (args: {
      channelState: string;
      sessionState: string;
      sessionId: string | null;
      isSessionReady: boolean;
    }) => {
      seenArgs.push(args);
      return { locked: false as const };
    };
    const controller = createChatController({
      client,
      inputLockPolicy,
    });

    controller.getState();

    expect(seenArgs[0]).toEqual(expect.objectContaining({
      channelState: 'OPEN',
      sessionState: 'ACTIVE',
      sessionId: 'sess_policy',
      isSessionReady: true,
    }));
  });

  it('sendMessage creates optimistic user message with provisional timestamp and sending state', async () => {
    const client = createMockClient();
    const controller = createChatController({
      client,
    });

    const pendingSend = controller.sendMessage({ content: 'Hello' });

    const optimisticTranscript = controller.getState().transcript;
    expect(optimisticTranscript).toHaveLength(1);
    expect(optimisticTranscript[0].deliveryStatus).toBe('sending');

    await pendingSend;

    const transcript = controller.getState().transcript;
    expect(transcript).toHaveLength(1);
    expect(transcript[0].role).toBe('user');
    expect(transcript[0].content).toEqual('Hello');
    expect(transcript[0].deliveryStatus).toBe('sent');
    expect(typeof transcript[0].clientMsgId).toBe('string');
    expect(transcript[0].meta).toMatchObject({
      client_msg_id: transcript[0].clientMsgId,
      timestamp_source: 'client',
    });
    expect(typeof transcript[0].ts).toBe('string');
  });

  it('sendMessage sends payload with client_msg_id in meta', async () => {
    const client = createMockClient();
    const controller = createChatController({ client });

    await controller.sendMessage({ content: 'Hi', meta: { question_ref: 'q1' } });

    expect(client.sentMessages).toHaveLength(1);
    const sent = client.sentMessages[0];
    expect(sent.content).toBe('Hi');
    expect(sent.meta).toMatchObject({ question_ref: 'q1' });
    expect(typeof sent.meta?.['client_msg_id']).toBe('string');
    expect((sent.meta?.['client_msg_id'] as string).length).toBeGreaterThan(0);
  });

  it('sendMessage calls client.sendMessage once with content and meta', async () => {
    const client = createMockClient();
    const controller = createChatController({ client });

    await controller.sendMessage({
      content: ['Approve'],
      meta: { question_ref: 'q_1', selected_option: 'approve' },
    });

    expect(client.sentMessages).toHaveLength(1);
    expect(client.sentMessages[0]).toMatchObject({
      content: ['Approve'],
      meta: {
        question_ref: 'q_1',
        selected_option: 'approve',
      },
    });
    expect(typeof client.sentMessages[0].meta?.['client_msg_id']).toBe('string');
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

  it('retryMessage resends originalPayload, reuses client_msg_id, and returns ok=true on success', async () => {
    const client = createMockClient();
    client.setSendError(new Error('offline'));
    const controller = createChatController({ client });

    await controller.sendMessage({ content: 'Retry me' });
    const failedMessage = controller.getState().transcript[0];
    const failedId = controller.getState().transcript[0].id;
    const originalClientMsgId = failedMessage.clientMsgId;
    const originalPayloadClientMsgId = failedMessage.originalPayload?.meta?.['client_msg_id'];
    // Mock throws before recording, so sentMessages is empty after failed send
    expect(client.sentMessages).toHaveLength(0);

    client.setSendError(null);
    const pendingRetry = controller.retryMessage(failedId);

    const retryingTranscript = controller.getState().transcript;
    expect(retryingTranscript).toHaveLength(1);
    expect(retryingTranscript[0].deliveryStatus).toBe('sending');
    expect(retryingTranscript[0].retryable).toBe(false);

    const retryResult = await pendingRetry;

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
    expect(transcript[0].clientMsgId).toBe(originalClientMsgId);
    // Retry recorded exactly one successful send
    expect(client.sentMessages).toHaveLength(1);
    expect(client.sentMessages[0].content).toBe('Retry me');
    expect(client.sentMessages[0].meta?.['client_msg_id']).toBe(originalPayloadClientMsgId);
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

  it('chat::echo with matching client_msg_id reconciles optimistic message instead of duplicating it', async () => {
    const client = createMockClient();
    const controller = createChatController({ client });

    await controller.connect();
    await controller.sendMessage({ content: 'Test' });

    const optimistic = controller.getState().transcript[0];
    const clientMsgId = optimistic.clientMsgId;
    expect(clientMsgId).toBeTruthy();

    client.emit(createMessage('chat::echo', {
      content: 'Test',
      role: 'user',
      meta: {
        client_msg_id: clientMsgId,
      },
    }, 7));

    const transcript = controller.getState().transcript;
    expect(transcript).toHaveLength(1);
    expect(transcript[0].type).toBe('chat::message');
    expect(transcript[0].role).toBe('user');
    expect(transcript[0].content).toBe('Test');
    expect(transcript[0].deliveryStatus).toBe('processed');
    expect(transcript[0].clientMsgId).toBe(clientMsgId);
    expect(transcript[0].ts).toBe(new Date(7000).toISOString());
    expect(transcript[0].meta?.['timestamp_source']).toBe('server');
    expect(transcript[0].id).toBe(optimistic.id);
    expect(transcript[0].meta?.['echo_type']).toBe('chat::echo');
  });

  it('chat::echo without matching client_msg_id is added as a separate message', async () => {
    const client = createMockClient();
    const controller = createChatController({ client });

    await controller.connect();
    await controller.sendMessage({ content: 'Test' });

    client.emit(createMessage('chat::echo', {
      content: 'Test',
      role: 'user',
      meta: {
        client_msg_id: 'different-client-msg-id',
      },
    }, 8));

    const transcript = controller.getState().transcript;
    expect(transcript).toHaveLength(2);
    expect(transcript[1].role).toBe('user');
    expect(transcript[1].deliveryStatus).toBe('processed');
  });

  it('matching chat::echo without server timestamp keeps the local provisional timestamp', async () => {
    const client = createMockClient();
    const controller = createChatController({ client });

    await controller.connect();
    await controller.sendMessage({ content: 'No ts' });

    const optimistic = controller.getState().transcript[0];
    const clientMsgId = optimistic.clientMsgId as string;

    client.emit({
      type: 'chat::echo',
      schema: '1.0',
      session_id: 'sess_test',
      seq: 9,
      payload: {
        content: 'No ts',
        role: 'user',
        meta: {
          client_msg_id: clientMsgId,
        },
      },
    });

    const transcript = controller.getState().transcript;
    expect(transcript).toHaveLength(1);
    expect(transcript[0].deliveryStatus).toBe('processed');
    expect(transcript[0].ts).toBe(optimistic.ts);
    expect(transcript[0].meta?.['timestamp_source']).toBe('client');
  });

  it('chat::echo does not clear awaiting answer', async () => {
    const client = createMockClient();
    const controller = createChatController({ client });

    await controller.connect();
    await controller.sendMessage({ content: 'Still waiting' });

    expect(controller.getState().input.locked).toBe(true);

    client.emit(createMessage('chat::echo', {
      content: 'Still waiting',
      role: 'user',
      meta: {
        client_msg_id: controller.getState().transcript[0].clientMsgId,
      },
    }, 10));

    expect(controller.getState().input.locked).toBe(true);
    expect(controller.getState().input.reason).toBe('awaiting_answer');
  });

  it('two separate sends with identical text remain distinct because client_msg_id differs', async () => {
    const client = createMockClient();
    const controller = createChatController({ client });

    await controller.sendMessage({ content: 'Same text' });
    await controller.sendMessage({ content: 'Same text' });

    const transcript = controller.getState().transcript;
    expect(transcript).toHaveLength(2);
    expect(transcript[0].clientMsgId).not.toBe(transcript[1].clientMsgId);
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
        question_ref: 'q_1',
        input_type: 'form',
        allow_reply: true,
        questions: [
          {
            key: 'decision',
            label: 'Decision',
            type: 'select',
            required: true,
            options: [
              { id: 'a', label: 'Option A' },
              { id: 'b', label: 'Option B' },
            ],
          },
        ],
      },
    }));

    expect(controller.getState().activeQuestion).toMatchObject({
      question_ref: 'q_1',
      input_type: 'form',
      allow_reply: true,
      questions: [
        {
          key: 'decision',
          label: 'Decision',
          type: 'select',
          required: true,
          options: [
            { id: 'a', label: 'Option A' },
            { id: 'b', label: 'Option B' },
          ],
        },
      ],
      options: [
        { id: 'a', label: 'Option A' },
        { id: 'b', label: 'Option B' },
      ],
    });
    expect(controller.getState().transcript).toHaveLength(1);
    expect(controller.getState().transcript[0].type).toBe('chat::question');
  });

  it('accepts legacy question_id as inbound fallback for chat::question', async () => {
    const client = createMockClient();
    const controller = createChatController({ client });

    await controller.connect();
    client.emit(createMessage('chat::question', {
      role: 'assistant',
      content: 'Choose one',
      meta: {
        question_id: 'legacy_q_1',
        input_type: 'radio',
        allow_reply: true,
        questions: [{
          key: 'decision',
          label: 'Decision',
          type: 'radio',
          options: [{ id: 'a', label: 'Option A' }],
        }],
      },
    }));

    expect(controller.getState().activeQuestion).toMatchObject({
      question_ref: 'legacy_q_1',
      question_id: 'legacy_q_1',
    });
  });

  it('does not use legacy meta.options when canonical questions are absent', async () => {
    const client = createMockClient();
    const controller = createChatController({ client });

    await controller.connect();
    client.emit(createMessage('chat::question', {
      role: 'assistant',
      content: 'Choose one',
      meta: {
        question_ref: 'q_options_only',
        input_type: 'radio',
        allow_reply: true,
        options: [{ id: 'a', label: 'Option A' }],
      },
    }));

    expect(controller.getState().activeQuestion).toMatchObject({
      question_ref: 'q_options_only',
      questions: [],
      options: [],
    });
  });

  it('clears activeQuestion on chat::answer', async () => {
    const client = createMockClient();
    const controller = createChatController({ client });

    await controller.connect();
    client.emit(createMessage('chat::question', {
      role: 'assistant',
      content: 'Choose one',
      meta: {
        question_ref: 'q_2',
        input_type: 'radio',
        allow_reply: false,
        questions: [{
          key: 'decision',
          label: 'Decision',
          type: 'radio',
          options: [{ id: 'a', label: 'Option A' }],
        }],
      },
    }, 1));

    expect(controller.getState().activeQuestion?.question_ref).toBe('q_2');

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
        question_ref: 'q_3',
        input_type: 'radio',
        allow_reply: true,
        questions: [{
          key: 'decision',
          label: 'Decision',
          type: 'radio',
          options: [{ id: 'a', label: 'Option A' }],
        }],
      },
    }, 1));

    expect(controller.getState().activeQuestion).not.toBeNull();

    client.emit(createMessage('system::error', {
      code: 'runtime_error',
      message: 'Something failed',
    }, 2));

    expect(controller.getState().activeQuestion).toBeNull();
  });

  it('filters malformed questions from activeQuestion', async () => {
    const client = createMockClient();
    const controller = createChatController({ client });

    await controller.connect();
    client.emit(createMessage('chat::question', {
      role: 'assistant',
      content: 'Choose',
      meta: {
        question_ref: 'q_4',
        input_type: 'form',
        allow_reply: false,
        questions: [
          { key: 'decision', label: 'Decision', type: 'select', options: [{ id: 'ok', label: 'Valid' }] },
          { key: '', label: 'Missing key', type: 'text' },
          null,
          { key: 'bad-type', label: 'Bad type', type: 'checkbox' },
        ],
      },
    }, 1));

    const { activeQuestion } = controller.getState();
    expect(activeQuestion?.questions).toHaveLength(1);
    expect(activeQuestion?.questions?.[0]).toMatchObject({
      key: 'decision',
      type: 'select',
      options: [{ id: 'ok', label: 'Valid' }],
    });
    expect(activeQuestion?.options).toHaveLength(1);
    expect(activeQuestion?.options[0]).toEqual({ id: 'ok', label: 'Valid' });
  });

  it('sendMessage forwards meta to client', async () => {
    const client = createMockClient();
    const controller = createChatController({ client });

    await controller.sendMessage({
      content: ['Approve'],
      meta: { question_ref: 'q_1', selected_option: 'approve' },
    });

    expect(client.sentMessages[0]).toMatchObject({
      content: ['Approve'],
      meta: { question_ref: 'q_1', selected_option: 'approve' },
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
