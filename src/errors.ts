import type { ChatErrorViewModel, CortexTransportMessage } from './types.js';

export class ControllerError extends Error {
  code: string;
  details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ControllerError';
    this.code = code;
    this.details = details;
  }
}

export function createChatError(
  code: string,
  message: string,
  source?: string,
  details?: Record<string, unknown>,
): ChatErrorViewModel {
  return { code, message, source, details };
}

export function createControllerError(
  code: string,
  message: string,
  source?: string,
  details?: Record<string, unknown>,
): ControllerError {
  return new ControllerError(code, message, {
    ...(source ? { source } : {}),
    ...(details ?? {}),
  });
}

export function errorFromUnknown(
  error: unknown,
  fallbackCode = 'controller_error',
  source?: string,
): ChatErrorViewModel {
  if (error instanceof ControllerError) {
    return createChatError(error.code, error.message, source, error.details);
  }
  if (error instanceof Error) {
    return createChatError(fallbackCode, error.message, source);
  }
  return createChatError(fallbackCode, 'Unknown controller error', source, {
    value: error as unknown as CortexTransportMessage,
  });
}
