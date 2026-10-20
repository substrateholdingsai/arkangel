// Structured logging for Cloudflare Workers

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  logger: string;
  message: string;
  context?: Record<string, unknown>;
  traceId?: string;
}

export class ArkLogger {
  private context: Record<string, unknown> = {};
  private minLevel: LogLevel = 'info';

  constructor(
    private loggerName: string,
    private traceId?: string
  ) {}

  setContext(context: Record<string, unknown>): void {
    this.context = { ...this.context, ...context };
  }

  setTraceId(traceId: string): void {
    this.traceId = traceId;
  }

  setMinLevel(level: LogLevel): void {
    this.minLevel = level;
  }

  private shouldLog(level: LogLevel): boolean {
    const levels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
    return levels.indexOf(level) >= levels.indexOf(this.minLevel);
  }

  private log(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    if (!this.shouldLog(level)) return;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      logger: this.loggerName,
      message,
      context: { ...this.context, ...context },
      traceId: this.traceId,
    };

    console.log(JSON.stringify(entry));
  }

  debug(message: string, context?: Record<string, unknown>): void {
    this.log('debug', message, context);
  }

  info(message: string, context?: Record<string, unknown>): void {
    this.log('info', message, context);
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.log('warn', message, context);
  }

  error(message: string, context?: Record<string, unknown>): void {
    this.log('error', message, context);
  }

  child(context: Record<string, unknown>): ArkLogger {
    const child = new ArkLogger(this.loggerName, this.traceId);
    child.context = { ...this.context, ...context };
    child.minLevel = this.minLevel;
    return child;
  }
}

export const logger = new ArkLogger('arkangel');

export function createRequestLogger(request: Request): ArkLogger {
  const traceId = request.headers.get('cf-ray') || crypto.randomUUID();
  const log = new ArkLogger('request', traceId);
  log.setContext({
    method: request.method,
    url: request.url,
    cf: {
      ray: request.headers.get('cf-ray'),
      country: request.headers.get('cf-ipcountry'),
      city: request.headers.get('cf-ipcity'),
    },
  });
  return log;
}
