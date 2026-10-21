// Structured logging + OpenTelemetry trace context for Cloudflare Workers

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  logger: string;
  message: string;
  context?: Record<string, unknown>;
  traceId?: string;
  spanId?: string;
}

export class ArkLogger {
  private context: Record<string, unknown> = {};
  private minLevel: LogLevel = 'info';

  constructor(
    private loggerName: string,
    private traceId?: string,
    private spanId?: string
  ) {}

  setContext(context: Record<string, unknown>): void {
    this.context = { ...this.context, ...context };
  }

  setTraceId(traceId: string): void {
    this.traceId = traceId;
  }

  setSpanId(spanId: string): void {
    this.spanId = spanId;
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
      spanId: this.spanId,
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
    const child = new ArkLogger(this.loggerName, this.traceId, this.spanId);
    child.context = { ...this.context, ...context };
    child.minLevel = this.minLevel;
    return child;
  }
}

export const logger = new ArkLogger('arkangel');

/** Generate a W3C-compatible trace ID (32 hex chars). */
export function generateTraceId(): string {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Generate a W3C-compatible span ID (16 hex chars). */
export function generateSpanId(): string {
  const arr = new Uint8Array(8);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Trace context carried through async boundaries. */
export interface TraceContext {
  traceId: string;
  spanId: string;
  sampled: boolean;
}

/** Extract trace context from W3C traceparent header. */
export function extractTraceContext(request: Request): TraceContext | null {
  const traceparent = request.headers.get('traceparent');
  if (!traceparent) return null;

  // traceparent: version-trace-id-span-id-flags
  const parts = traceparent.split('-');
  if (parts.length !== 4) return null;

  const traceId = parts[1];
  const spanId = parts[2];
  const flags = parts[3];
  if (!traceId || !spanId || !flags) return null;

  const sampled = (parseInt(flags, 16) & 1) === 1;

  return { traceId, spanId, sampled };
}

/** Inject trace context into headers for outgoing requests. */
export function injectTraceContext(headers: Headers, ctx: TraceContext): void {
  headers.set('traceparent', `00-${ctx.traceId}-${ctx.spanId}-${ctx.sampled ? '01' : '00'}`);
}

/** Create a logger with trace context. */
export function createLoggerWithTrace(name: string, traceCtx?: TraceContext): ArkLogger {
  return new ArkLogger(name, traceCtx?.traceId, traceCtx?.spanId);
}

/** Create a child span for an operation. */
export function createChildSpan(parent: TraceContext): TraceContext {
  return {
    traceId: parent.traceId,
    spanId: generateSpanId(),
    sampled: parent.sampled,
  };
}

/** Middleware to add trace context to Hono context. */
export function traceMiddleware() {
  return async (c: any, next: any) => {
    const traceCtx = extractTraceContext(c.req.raw) ?? {
      traceId: generateTraceId(),
      spanId: generateSpanId(),
      sampled: true,
    };

    // Store in context for downstream use
    c.set('traceCtx', traceCtx);

    // Add to response headers
    injectTraceContext(c.res.headers, traceCtx);

    await next();
  };
}

/** Get trace context from Hono context. */
export function getTraceContext(c: any): TraceContext {
  return (
    c.get('traceCtx') ?? {
      traceId: generateTraceId(),
      spanId: generateSpanId(),
      sampled: true,
    }
  );
}

/** Create a request logger with trace context. */
export function createRequestLogger(request: Request): ArkLogger {
  const traceCtx = extractTraceContext(request) ?? {
    traceId: generateTraceId(),
    spanId: generateSpanId(),
    sampled: true,
  };

  const log = new ArkLogger('request', traceCtx.traceId, traceCtx.spanId);
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

/** Async context propagation for queue/scheduled handlers. */
export function runWithTrace<T>(traceCtx: TraceContext, fn: () => Promise<T>): Promise<T> {
  // In Workers, we can't use AsyncLocalStorage, so we pass traceCtx explicitly
  return fn();
}

export function createTracer(name: string) {
  return {
    startSpan: (traceCtx: TraceContext, operation: string) => {
      const childSpan = createChildSpan(traceCtx);
      const log = new ArkLogger(name, childSpan.traceId, childSpan.spanId);
      log.info(`span:start`, { operation });
      return { span: childSpan, log };
    },
    endSpan: (log: ArkLogger, attrs?: Record<string, unknown>) => {
      log.info(`span:end`, attrs);
    },
  };
}
