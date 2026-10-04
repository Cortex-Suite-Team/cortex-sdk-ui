import { TRANSCRIPT_SCHEMA_VERSION } from './types.js';
import type {
  ChatMessageViewModel,
  PersistedTranscript,
  TranscriptPersistence,
} from './types.js';
import { cloneMessage, isRecord } from './utils.js';

export const DEFAULT_TRANSCRIPT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const DATABASE_NAME = 'cortex-sdk-ui';
const DATABASE_VERSION = 1;
const SESSIONS_STORE = 'transcript-sessions';
const MESSAGES_STORE = 'transcript-messages';
const SENSITIVE_KEY = /^(?:access_token|refresh_token|token|api_key|authorization|credentials?|password|secret|private.*file|file.*private|file_id|storage_id|file_layer_id)$/;

interface StoredSession {
  sessionKey: string;
  version: number;
  updatedAt: number;
  expiresAt: number;
}

interface StoredMessage {
  storageKey: string;
  sessionKey: string;
  order: number;
  message: ChatMessageViewModel;
}

function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/-/g, '_').toLowerCase();
    if (!SENSITIVE_KEY.test(normalizedKey)) result[key] = sanitizeValue(child);
  }
  return result;
}

export function sanitizeTranscriptMessage(message: ChatMessageViewModel): ChatMessageViewModel {
  const safe = sanitizeValue(cloneMessage(message)) as ChatMessageViewModel;
  if (message.originalPayload && message.id.startsWith('client:')) {
    safe.meta = { ...(safe.meta ?? {}), persisted_outgoing: true };
  }
  delete safe.originalPayload;
  return safe;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
  });
}

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(SESSIONS_STORE)) {
        database.createObjectStore(SESSIONS_STORE, { keyPath: 'sessionKey' });
      }
      if (!database.objectStoreNames.contains(MESSAGES_STORE)) {
        const messages = database.createObjectStore(MESSAGES_STORE, { keyPath: 'storageKey' });
        messages.createIndex('sessionKey', 'sessionKey', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Unable to open transcript database'));
  });
}

async function deleteMessagesForSession(store: IDBObjectStore, sessionKey: string): Promise<void> {
  const index = store.index('sessionKey');
  const keys = await requestResult(index.getAllKeys(IDBKeyRange.only(sessionKey)));
  for (const key of keys) store.delete(key);
}

export function createIndexedDbTranscriptPersistence(
  factory: IDBFactory | undefined = typeof indexedDB === 'undefined' ? undefined : indexedDB,
): TranscriptPersistence | null {
  if (!factory) return null;
  const databasePromise = openDatabase(factory);

  return {
    async load(sessionKey) {
      const database = await databasePromise;
      const transaction = database.transaction([SESSIONS_STORE, MESSAGES_STORE], 'readonly');
      const done = transactionDone(transaction);
      const session = await requestResult(
        transaction.objectStore(SESSIONS_STORE).get(sessionKey) as IDBRequest<StoredSession | undefined>,
      );
      if (!session) return null;
      const rows = await requestResult(
        transaction.objectStore(MESSAGES_STORE).index('sessionKey').getAll(IDBKeyRange.only(sessionKey)) as IDBRequest<StoredMessage[]>,
      );
      await done;
      rows.sort((left, right) => left.order - right.order);
      return {
        version: session.version as typeof TRANSCRIPT_SCHEMA_VERSION,
        sessionKey,
        updatedAt: session.updatedAt,
        expiresAt: session.expiresAt,
        messages: rows.map((row) => cloneMessage(row.message)),
      };
    },

    async save(sessionKey, transcript, changedMessages) {
      const database = await databasePromise;
      const transaction = database.transaction([SESSIONS_STORE, MESSAGES_STORE], 'readwrite');
      const done = transactionDone(transaction);
      const sessions = transaction.objectStore(SESSIONS_STORE);
      const messages = transaction.objectStore(MESSAGES_STORE);
      sessions.put({
        sessionKey,
        version: transcript.version,
        updatedAt: transcript.updatedAt,
        expiresAt: transcript.expiresAt,
      } satisfies StoredSession);
      for (const { order, message } of changedMessages) {
        messages.put({
          storageKey: `${sessionKey}\u0000${message.id}`,
          sessionKey,
          order,
          message: sanitizeTranscriptMessage(message),
        } satisfies StoredMessage);
      }
      await done;
    },

    async delete(sessionKey) {
      const database = await databasePromise;
      const transaction = database.transaction([SESSIONS_STORE, MESSAGES_STORE], 'readwrite');
      const done = transactionDone(transaction);
      transaction.objectStore(SESSIONS_STORE).delete(sessionKey);
      await deleteMessagesForSession(transaction.objectStore(MESSAGES_STORE), sessionKey);
      await done;
    },

    async purgeExpired(now) {
      const database = await databasePromise;
      const read = database.transaction(SESSIONS_STORE, 'readonly');
      const done = transactionDone(read);
      const sessions = await requestResult(read.objectStore(SESSIONS_STORE).getAll() as IDBRequest<StoredSession[]>);
      await done;
      for (const session of sessions) {
        if (session.expiresAt <= now) await this.delete(session.sessionKey);
      }
    },
  };
}
