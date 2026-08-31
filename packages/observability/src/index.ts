export type LogContext = Record<string, unknown>;
export function logEvent(event: string, context: LogContext = {}): void {
  console.info(JSON.stringify({ level: 'info', event, timestamp: new Date().toISOString(), ...context }));
}
