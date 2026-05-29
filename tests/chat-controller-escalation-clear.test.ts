import { createChatController } from '../src/index.js';
import { createMessage, createMockClient } from './helpers.js';

function makeEscalationRequest() {
  return createMessage('escalation::request', {
    escalation_id: 'esc_1',
    content: 'Need approval',
    reason: 'requires_human_approval',
    wait_token: 'wait_1',
    allowed_actions: ['operator_input', 'reply_user'],
  }, 1);
}

async function setupWithPendingEscalation() {
  const client = createMockClient();
  const controller = createChatController({ client });
  await controller.connect();
  client.emit(makeEscalationRequest());
  expect(controller.getState().escalation?.status).toBe('pending');
  return { client, controller };
}

describe('chat-controller — escalation banner clearing', () => {
  it('escalation::request sets banner to pending', async () => {
    const { controller } = await setupWithPendingEscalation();
    expect(controller.getState().escalation).toMatchObject({ status: 'pending' });
  });

  it('chat::echo role=user does NOT clear banner', async () => {
    const { client, controller } = await setupWithPendingEscalation();

    client.emit(createMessage('chat::echo', { role: 'user', content: 'Hello' }, 2));

    expect(controller.getState().escalation?.status).toBe('pending');
  });

  it('chat::message role=user does NOT clear banner', async () => {
    const { client, controller } = await setupWithPendingEscalation();

    client.emit(createMessage('chat::message', { role: 'user', content: 'Hello' }, 2));

    expect(controller.getState().escalation?.status).toBe('pending');
  });

  it('chat::echo role=operator clears banner', async () => {
    const { client, controller } = await setupWithPendingEscalation();

    client.emit(createMessage('chat::echo', { role: 'operator', content: 'Operator replied' }, 2));

    expect(controller.getState().escalation).toBeNull();
  });

  it('chat::echo role=assistant clears banner', async () => {
    const { client, controller } = await setupWithPendingEscalation();

    client.emit(createMessage('chat::echo', { role: 'assistant', content: 'Worker replied' }, 2));

    expect(controller.getState().escalation).toBeNull();
  });

  it('chat::answer clears banner (no answer_kind required)', async () => {
    const { client, controller } = await setupWithPendingEscalation();

    client.emit(createMessage('chat::answer', { role: 'assistant', content: 'Final answer' }, 2));

    expect(controller.getState().escalation).toBeNull();
  });

  it('chat::partial role=assistant clears banner', async () => {
    const { client, controller } = await setupWithPendingEscalation();

    client.emit(createMessage('chat::partial', { role: 'assistant', content: 'Streaming...' }, 2));

    expect(controller.getState().escalation).toBeNull();
  });

  it('chat::question clears banner', async () => {
    const { client, controller } = await setupWithPendingEscalation();

    client.emit(createMessage('chat::question', {
      role: 'assistant',
      content: 'What do you choose?',
      meta: { question_ref: 'q_1', input_type: 'radio' },
    }, 2));

    expect(controller.getState().escalation).toBeNull();
  });

  it('system::error clears banner', async () => {
    const { client, controller } = await setupWithPendingEscalation();

    client.emit(createMessage('system::error', { code: 'runtime_error', message: 'Something went wrong' }, 2));

    expect(controller.getState().escalation).toBeNull();
  });

  it('system::state idle clears banner', async () => {
    const { client, controller } = await setupWithPendingEscalation();

    client.emit(createMessage('system::state', { content: [], meta: { state: 'idle' } }, 2));

    expect(controller.getState().escalation).toBeNull();
  });

  it('system::lifecycle idle clears banner', async () => {
    const { client, controller } = await setupWithPendingEscalation();

    client.emit(createMessage('system::lifecycle', { status: 'idle' }, 2));

    expect(controller.getState().escalation).toBeNull();
  });

  it('system::pong does NOT clear banner', async () => {
    const { client, controller } = await setupWithPendingEscalation();

    client.emit(createMessage('system::pong', { ts: new Date().toISOString() }, 2));

    expect(controller.getState().escalation?.status).toBe('pending');
  });
});
