import { createChatController } from '../src/index.js';
import { createMessage, createMockClient } from './helpers.js';

function makeSystemState(
  state: 'working' | 'waiting' | 'idle' | 'error',
  opts: { label?: string; ttl_ms?: number } = {},
) {
  return createMessage('system::state', {
    content: [],
    meta: { state, ...opts },
  });
}

describe('chat-controller — system::state handling', () => {
  it('system::state updates workerState but does not add to transcript', async () => {
    const client = createMockClient();
    const controller = createChatController({ client });
    await controller.connect();

    client.emit(makeSystemState('working', { label: 'Digital worker is working…', ttl_ms: 30000 }));

    const state = controller.getState();
    expect(state.workerState.state).toBe('working');
    expect(state.workerState.label).toBe('Digital worker is working…');
    expect(state.transcript).toHaveLength(0);
  });

  it('initial workerState is idle', async () => {
    const client = createMockClient();
    const controller = createChatController({ client });
    await controller.connect();

    expect(controller.getState().workerState.state).toBe('idle');
  });

  it('ttl_ms sets expiresAt = Date.now() + ttl_ms', async () => {
    const client = createMockClient();
    const controller = createChatController({ client });
    await controller.connect();

    const before = Date.now();
    client.emit(makeSystemState('working', { ttl_ms: 30000 }));
    const after = Date.now();

    const { expiresAt } = controller.getState().workerState;
    expect(expiresAt).toBeDefined();
    expect(expiresAt!).toBeGreaterThanOrEqual(before + 30000);
    expect(expiresAt!).toBeLessThanOrEqual(after + 30000);
  });

  it('system::state with idle state sets workerState to idle', async () => {
    const client = createMockClient();
    const controller = createChatController({ client });
    await controller.connect();

    client.emit(makeSystemState('working'));
    client.emit(makeSystemState('idle', { ttl_ms: 1000 }));

    expect(controller.getState().workerState.state).toBe('idle');
  });

  it('system::state triggers state_changed event', async () => {
    const client = createMockClient();
    const stateChanges: string[] = [];
    const controller = createChatController({
      client,
      onStateChange: (s) => stateChanges.push(s.workerState.state),
    });
    await controller.connect();

    client.emit(makeSystemState('working'));
    client.emit(makeSystemState('waiting'));

    expect(stateChanges).toContain('working');
    expect(stateChanges).toContain('waiting');
  });

  it('chat::answer resets workerState to idle (fallback protection)', async () => {
    const client = createMockClient();
    const controller = createChatController({ client });
    await controller.connect();

    client.emit(makeSystemState('working'));
    expect(controller.getState().workerState.state).toBe('working');

    client.emit(createMessage('chat::answer', {
      content: 'Done',
      role: 'assistant',
      answer_kind: 'final',
    }, 2));

    expect(controller.getState().workerState.state).toBe('idle');
  });

  it('chat::question resets workerState to idle', async () => {
    const client = createMockClient();
    const controller = createChatController({ client });
    await controller.connect();

    client.emit(makeSystemState('working'));
    client.emit(createMessage('chat::question', {
      content: ['Choose:'],
      role: 'assistant',
      meta: {
        question_id: 'q1',
        input_type: 'radio',
        allow_reply: false,
        options: [{ id: 'a', label: 'A' }],
      },
    }, 2));

    expect(controller.getState().workerState.state).toBe('idle');
  });

  it('system::error resets workerState to idle', async () => {
    const client = createMockClient();
    const controller = createChatController({ client });
    await controller.connect();

    client.emit(makeSystemState('working'));
    client.emit(createMessage('system::error', { code: 'boom', message: 'Error' }, 2));

    expect(controller.getState().workerState.state).toBe('idle');
  });

  it('system::state with expired ttl_ms immediately becomes idle', async () => {
    const client = createMockClient();
    const controller = createChatController({ client });
    await controller.connect();

    // ttl_ms=1 means it's already expired by the time we check
    client.emit(makeSystemState('working', { ttl_ms: 1 }));
    // Give the timer a tick to fire
    await new Promise((r) => setTimeout(r, 10));

    expect(controller.getState().workerState.state).toBe('idle');
  });

  it('system::state does not appear in transcript', async () => {
    const client = createMockClient();
    const controller = createChatController({ client });
    await controller.connect();

    client.emit(makeSystemState('working'));
    client.emit(makeSystemState('waiting'));
    client.emit(makeSystemState('idle'));

    expect(controller.getState().transcript).toHaveLength(0);
  });

  it('workerState is spread correctly in computeState (no shared reference)', async () => {
    const client = createMockClient();
    const controller = createChatController({ client });
    await controller.connect();

    client.emit(makeSystemState('working', { label: 'Working' }));

    const state1 = controller.getState();
    client.emit(makeSystemState('idle'));
    const state2 = controller.getState();

    // state1's workerState should not have been mutated
    expect(state1.workerState.state).toBe('working');
    expect(state2.workerState.state).toBe('idle');
  });

  it('destroy clears TTL timer without throwing', async () => {
    const client = createMockClient();
    const controller = createChatController({ client });
    await controller.connect();

    client.emit(makeSystemState('working', { ttl_ms: 60000 }));
    // Destroy before TTL fires — should not throw
    expect(() => controller.destroy()).not.toThrow();
  });
});
