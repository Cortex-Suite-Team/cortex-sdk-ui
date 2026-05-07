import type {
  CortexClientLike,
  CortexTransportMessage,
  ReplyEscalationRequest,
} from '../src/index.js';

export interface MockClient extends CortexClientLike {
  emitted: CortexTransportMessage[];
  sentMessages: Array<{ content: unknown; attachments?: unknown[] }>;
  escalationReplies: ReplyEscalationRequest[];
  emit(message: CortexTransportMessage): void;
  sessionId: string | null;
  sessionState: string;
  channelState: string;
  connectCalls: number;
  disconnectCalls: number;
}

export function createMockClient(overrides: {
  replyEscalation?: ((options: ReplyEscalationRequest) => Promise<void>) | null;
} = {}): MockClient {
  const listeners = new Set<(message: CortexTransportMessage) => void>();
  const sentMessages: Array<{ content: unknown; attachments?: unknown[] }> = [];
  const escalationReplies: ReplyEscalationRequest[] = [];

  const client: MockClient = {
    emitted: [],
    sentMessages,
    escalationReplies,
    sessionId: 'sess_test',
    sessionState: 'ACTIVE',
    channelState: 'OPEN',
    connectCalls: 0,
    disconnectCalls: 0,

    async connect() {
      client.connectCalls += 1;
    },

    async disconnect() {
      client.disconnectCalls += 1;
    },

    async sendMessage(options) {
      sentMessages.push(options);
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
      listeners.add(handler);
      return () => {
        listeners.delete(handler);
      };
    },

    emit(message) {
      client.emitted.push(message);
      for (const listener of Array.from(listeners)) {
        listener(message);
      }
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
