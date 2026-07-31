type Level = 'debug' | 'info' | 'warn' | 'error';

/** Set by db/index.ts once the pool is ready, so early boot logs don't crash. */
let sink: ((level: Level, scope: string, message: string, meta?: unknown) => void) | null = null;

export function setLogSink(fn: typeof sink) {
  sink = fn;
}

function emit(level: Level, scope: string, message: string, meta?: unknown) {
  const line = `[${new Date().toISOString()}] ${level.toUpperCase().padEnd(5)} [${scope}] ${message}`;
  if (level === 'error') console.error(line, meta ?? '');
  else if (level === 'warn') console.warn(line, meta ?? '');
  else console.log(line, meta ?? '');

  if (sink && level !== 'debug') {
    try {
      sink(level, scope, message, meta);
    } catch {
      /* never let logging break the caller */
    }
  }
}

export function createLogger(scope: string) {
  return {
    debug: (m: string, meta?: unknown) => emit('debug', scope, m, meta),
    info: (m: string, meta?: unknown) => emit('info', scope, m, meta),
    warn: (m: string, meta?: unknown) => emit('warn', scope, m, meta),
    error: (m: string, meta?: unknown) => emit('error', scope, m, meta),
  };
}

export function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}
