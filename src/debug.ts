export interface DebugLogger {
  enabled: boolean;
  log(message: string, data?: Record<string, unknown>): void;
}

export function createDebugLogger(enabled: boolean | undefined): DebugLogger {
  return {
    enabled: enabled === true,
    log(message, data) {
      if (enabled !== true) {
        return;
      }
      if (data === undefined) {
        console.debug(message);
        return;
      }
      console.debug(message, data);
    },
  };
}
