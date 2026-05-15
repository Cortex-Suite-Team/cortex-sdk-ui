import type {
  CortexClientLike,
  CortexTransportMessage,
  ReplyEscalationRequest,
} from '../src/index.js';

export interface MockClient extends CortexClientLike {
  emitted: CortexTransportMessage[];
  sentMessages: Array<{ content: unknown; attachments?: unknown[]; meta?: Record<string, unknown> }>;
  loginCredentials: Array<{ login: string; password: string }>;
  escalationReplies: ReplyEscalationRequest[];
  emit(message: CortexTransportMessage): void;
  sessionId: string | null;
  sessionMeta?: Record<string, unknown> | null;
  sessionContext?: CortexClientLike['sessionContext'];
  sessionState: string;
  channelState: string;
  connectCalls: number;
  disconnectCalls: number;
  subscriptionCalls: number;
  unsubscriptionCalls: number;
  activeListenerCount(): number;
  setSendError(error: Error | null): void;
  setLoginError(error: Error | null): void;
}

export function createMockClient(overrides: {
  replyEscalation?: ((options: ReplyEscalationRequest) => Promise<void>) | null;
} = {}): MockClient {
  const listeners = new Set<(message: CortexTransportMessage) => void>();
  const sentMessages: Array<{ content: unknown; attachments?: unknown[]; meta?: Record<string, unknown> }> = [];
  const loginCredentials: Array<{ login: string; password: string }> = [];
  const escalationReplies: ReplyEscalationRequest[] = [];
  let sendError: Error | null = null;
  let loginError: Error | null = null;

  const client: MockClient = {
    emitted: [],
    sentMessages,
    loginCredentials,
    escalationReplies,
    sessionId: 'sess_test',
    sessionMeta: null,
    sessionContext: null,
    sessionState: 'ACTIVE',
    channelState: 'OPEN',
    connectCalls: 0,
    disconnectCalls: 0,
    subscriptionCalls: 0,
    unsubscriptionCalls: 0,

    async connect() {
      client.connectCalls += 1;
    },

    async disconnect() {
      client.disconnectCalls += 1;
    },

    async sendMessage(options) {
      if (sendError) throw sendError;
      sentMessages.push(options);
    },

    async sendLogin(credentials) {
      if (loginError) throw loginError;
      loginCredentials.push({ login: credentials.login, password: credentials.password });
    },

    setSendError(error: Error | null) {
      sendError = error;
    },

    setLoginError(error: Error | null) {
      loginError = error;
    },

    async replyEscalation(options) {
      if (overrides.replyEscalation === null) {
        throw new Error('replyEscalation should not be called');
      }
      if (typeof overrides.replyEscalation === 'function') {
        await overrides.replyEscalation(options);
        return;
      }
      escalationReplies.push(options);
    },

    onMessage(handler) {
      client.subscriptionCalls += 1;
      listeners.add(handler);
      return () => {
        if (listeners.delete(handler)) {
          client.unsubscriptionCalls += 1;
        }
      };
    },

    emit(message) {
      client.emitted.push(message);
      for (const listener of Array.from(listeners)) {
        listener(message);
      }
    },

    activeListenerCount() {
      return listeners.size;
    },
  };

  if (overrides.replyEscalation === null) {
    delete client.replyEscalation;
  }

  return client;
}

export function createMessage(
  type: string,
  payload: Record<string, unknown>,
  seq = 1,
): CortexTransportMessage {
  return {
    type,
    schema: '1.0',
    session_id: 'sess_test',
    seq,
    payload,
    ts: new Date(seq * 1000).toISOString(),
  };
}
