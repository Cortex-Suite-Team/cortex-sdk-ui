/**
 * Slice 11: ChatAuthState and submitLogin tests.
 *
 * Covers:
 * - initial ChatState.auth is { state: 'none' }
 * - system::auth required/denied/accepted updates auth state
 * - system::auth is not inserted into transcript
 * - submitLogin calls client.sendLogin (not sendMessage)
 * - submitLogin sets submitting synchronously before await
 * - submitLogin rejection sets denied
 * - input is locked while auth.state ∈ { required, submitting, denied }
 * - input is not locked by auth when auth.state is 'accepted' or 'none'
 * - normal chat flow (transcript, send) is unaffected
 * - system::login not stored in transcript (transcript-store filter)
 */
import { createChatController } from '../src/index.js';
import { createMessage, createMockClient } from './helpers.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAuthMessage(
  state: 'required' | 'denied' | 'accepted',
  extra: Record<string, unknown> = {},
) {
  return createMessage('system::auth', {
    state,
    method: 'login_password',
    message: `Auth ${state}`,
    ...extra,
  });
}

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

describe('ChatAuthState — initial state', () => {
  it('initial ChatState.auth is { state: "none" }', () => {
    const client = createMockClient();
    const controller = createChatController({ client });

    expect(controller.getState().auth).toEqual({ state: 'none' });
  });
});

// ---------------------------------------------------------------------------
// system::auth message handling
// ---------------------------------------------------------------------------

describe('system::auth message handling', () => {
  it('system::auth state=required sets auth.state to required', async () => {
    const client = createMockClient();
    const controller = createChatController({ client });
    await controller.connect();

    client.emit(makeAuthMessage('required'));

    expect(controller.getState().auth.state).toBe('required');
  });

  it('system::auth state=required copies method and message', async () => {
    const client = createMockClient();
    const controller = createChatController({ client });
    await controller.connect();

    client.emit(createMessage('system::auth', {
      state: 'required',
      method: 'login_password',
      message: 'Please sign in.',
    }));

    const auth = controller.getState().auth;
    expect(auth.method).toBe('login_password');
    expect(auth.message).toBe('Please sign in.');
  });

  it('system::auth state=denied sets auth.state to denied', async () => {
    const client = createMockClient();
    const controller = createChatController({ client });
    await controller.connect();

    client.emit(makeAuthMessage('denied'));

    expect(controller.getState().auth.state).toBe('denied');
  });

  it('system::auth state=accepted sets auth.state to accepted', async () => {
    const client = createMockClient();
    const controller = createChatController({ client });
    await controller.connect();

    client.emit(makeAuthMessage('accepted'));

    expect(controller.getState().auth.state).toBe('accepted');
  });

  it('system::auth emits state_changed', async () => {
    const states: string[] = [];
    const client = createMockClient();
    const controller = createChatController({ client });
    await controller.connect();
    controller.subscribe((s) => states.push(s.auth.state));

    client.emit(makeAuthMessage('required'));

    expect(states).toContain('required');
  });

  it('system::auth with unknown state is ignored (auth stays none)', async () => {
    const client = createMockClient();
    const controller = createChatController({ client });
    await controller.connect();

    client.emit(createMessage('system::auth', { state: 'unknown_value' }));

    expect(controller.getState().auth.state).toBe('none');
  });

  it('system::auth is NOT added to transcript', async () => {
    const client = createMockClient();
    const controller = createChatController({ client });
    await controller.connect();

    client.emit(makeAuthMessage('required'));

    expect(controller.getState().transcript).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Input lock
// ---------------------------------------------------------------------------

describe('input lock with auth state', () => {
  it('input is locked with reason=auth_required when auth.state=required', async () => {
    const client = createMockClient();
    const controller = createChatController({ client });
    await controller.connect();

    client.emit(makeAuthMessage('required'));

    const { input } = controller.getState();
    expect(input.locked).toBe(true);
    expect(input.reason).toBe('auth_required');
  });

  it('input is locked when auth.state=denied', async () => {
    const client = createMockClient();
    const controller = createChatController({ client });
    await controller.connect();

    client.emit(makeAuthMessage('denied'));

    expect(controller.getState().input.locked).toBe(true);
    expect(controller.getState().input.reason).toBe('auth_required');
  });

  it('input is NOT locked by auth when auth.state=accepted (session governs)', async () => {
    // When session is open and auth is accepted, input should not be locked by auth
    const client = createMockClient();
    // client defaults: channelState=OPEN, sessionId=sess_test, sessionState=ACTIVE
    const controller = createChatController({ client });
    await controller.connect();
    client.emit(createMessage('system::opened', {}));
    client.emit(makeAuthMessage('accepted'));

    const { input } = controller.getState();
    expect(input.locked).toBe(false);
  });

  it('input is NOT locked by auth when auth.state=none', async () => {
    const client = createMockClient();
    const controller = createChatController({ client });
    await controller.connect();
    client.emit(createMessage('system::opened', {}));

    expect(controller.getState().auth.state).toBe('none');
    expect(controller.getState().input.locked).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// submitLogin
// ---------------------------------------------------------------------------

describe('submitLogin', () => {
  it('calls client.sendLogin with the provided credentials', async () => {
    const client = createMockClient();
    const controller = createChatController({ client });
    await controller.connect();

    const result = await controller.submitLogin({ login: 'alice', password: 's3cr3t' });

    expect(result.ok).toBe(true);
    expect(client.loginCredentials).toHaveLength(1);
    expect(client.loginCredentials[0]).toEqual({ login: 'alice', password: 's3cr3t' });
  });

  it('does NOT call client.sendMessage', async () => {
    const client = createMockClient();
    const controller = createChatController({ client });
    await controller.connect();

    await controller.submitLogin({ login: 'alice', password: 'pw' });

    expect(client.sentMessages).toHaveLength(0);
  });

  it('sets auth.state to submitting synchronously before awaiting sendLogin', async () => {
    const client = createMockClient();
    let stateWhileSending: string | undefined;
    let resolveSend!: () => void;
    client.sendLogin = async (credentials) => {
      stateWhileSending = undefined; // captured below
      await new Promise<void>((r) => { resolveSend = r; });
      client.loginCredentials.push({ login: credentials.login, password: credentials.password });
    };

    const controller = createChatController({ client });
    await controller.connect();

    // Do not await — observe state immediately after synchronous setup
    const loginPromise = controller.submitLogin({ login: 'u', password: 'p' });

    // submitLogin sets 'submitting' before the first await in sendLogin
    expect(controller.getState().auth.state).toBe('submitting');

    resolveSend();
    await loginPromise;
  });

  it('returns ok:false when client.sendLogin is absent', async () => {
    const client = createMockClient();
    delete (client as Partial<typeof client>).sendLogin;

    const controller = createChatController({ client });
    await controller.connect();

    const result = await controller.submitLogin({ login: 'x', password: 'y' });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('auth_not_supported');
  });

  it('sets auth.state to denied when sendLogin rejects', async () => {
    const client = createMockClient();
    client.setLoginError(new Error('invalid credentials'));

    const controller = createChatController({ client });
    await controller.connect();
    client.emit(makeAuthMessage('required'));

    const result = await controller.submitLogin({ login: 'u', password: 'wrong' });

    expect(result.ok).toBe(false);
    expect(controller.getState().auth.state).toBe('denied');
  });

  it('does not add an optimistic message to transcript', async () => {
    const client = createMockClient();
    const controller = createChatController({ client });
    await controller.connect();

    await controller.submitLogin({ login: 'alice', password: 'pw' });

    expect(controller.getState().transcript).toHaveLength(0);
  });

  it('state transitions: required → submitting → then server drives accepted/denied', async () => {
    const states: string[] = [];
    const client = createMockClient();
    const controller = createChatController({ client });
    await controller.connect();
    controller.subscribe((s) => states.push(s.auth.state));

    client.emit(makeAuthMessage('required'));
    expect(controller.getState().auth.state).toBe('required');

    // submitLogin sets submitting before await
    const loginPromise = controller.submitLogin({ login: 'u', password: 'p' });
    expect(controller.getState().auth.state).toBe('submitting');

    await loginPromise;
    // sendLogin resolved ok — state stays submitting until server drives it
    expect(controller.getState().auth.state).toBe('submitting');

    // server sends accepted
    client.emit(makeAuthMessage('accepted'));
    expect(controller.getState().auth.state).toBe('accepted');

    expect(states).toEqual(['required', 'submitting', 'accepted']);
  });
});

// ---------------------------------------------------------------------------
// Disconnect resets auth state
// ---------------------------------------------------------------------------

describe('disconnect resets auth state', () => {
  it('auth.state returns to none after disconnect', async () => {
    const client = createMockClient();
    const controller = createChatController({ client });
    await controller.connect();

    client.emit(makeAuthMessage('required'));
    expect(controller.getState().auth.state).toBe('required');

    await controller.disconnect();

    expect(controller.getState().auth.state).toBe('none');
  });
});

// ---------------------------------------------------------------------------
// Normal chat flow is unaffected
// ---------------------------------------------------------------------------

describe('normal chat flow unaffected', () => {
  it('sendMessage still adds optimistic user message to transcript', async () => {
    const client = createMockClient();
    const controller = createChatController({ client });
    await controller.connect();
    client.emit(createMessage('system::opened', {}));

    await controller.sendMessage({ content: 'Hello' });

    const transcript = controller.getState().transcript;
    expect(transcript).toHaveLength(1);
    expect(transcript[0].role).toBe('user');
    expect(transcript[0].content).toBe('Hello');
  });

  it('chat::answer arrives in transcript after system::opened', async () => {
    const client = createMockClient();
    const controller = createChatController({ client });
    await controller.connect();
    client.emit(createMessage('system::opened', {}));

    client.emit(createMessage('chat::answer', {
      content: 'Hello back',
      role: 'assistant',
      answer_kind: 'final',
      turn_id: 'turn_1',
    }));

    const transcript = controller.getState().transcript;
    expect(transcript.some((m) => m.role === 'assistant')).toBe(true);
  });

  it('system::auth arriving mid-session does not clear transcript', async () => {
    const client = createMockClient();
    const controller = createChatController({ client });
    await controller.connect();
    client.emit(createMessage('system::opened', {}));

    await controller.sendMessage({ content: 'Hi' });
    const initialLength = controller.getState().transcript.length;

    client.emit(makeAuthMessage('required'));

    expect(controller.getState().transcript).toHaveLength(initialLength);
  });
});

// ---------------------------------------------------------------------------
// Transcript filter: system::login and system::auth are never stored
// ---------------------------------------------------------------------------

describe('transcript filter for system:: types', () => {
  it('system::login is not stored in transcript', async () => {
    const client = createMockClient();
    const controller = createChatController({ client });
    await controller.connect();

    // system::login would come from the server only in a misconfigured scenario,
    // but the transcript filter must reject it regardless.
    client.emit(createMessage('system::login', { login: 'alice', password_present: true }));

    expect(controller.getState().transcript).toHaveLength(0);
  });

  it('system::auth is not stored in transcript (verified via controller)', async () => {
    const client = createMockClient();
    const controller = createChatController({ client });
    await controller.connect();

    client.emit(makeAuthMessage('required'));
    client.emit(makeAuthMessage('denied'));
    client.emit(makeAuthMessage('accepted'));

    expect(controller.getState().transcript).toHaveLength(0);
  });
});
