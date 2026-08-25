import { config } from './config';

/**
 * Structured JSON logger. Never pass review text, feedback content, employee emails,
 * Slack/session tokens, AI prompts, or archive secrets in `fields` — only identifiers
 * (request/event/job/cycle/entity/actor IDs) belong here.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

const REDACT_KEYS = new Set([
  'token',
  'secret',
  'password',
  'authorization',
  'cookie',
  'apikey',
  'api_key',
  'signingsecret',
  'bottoken',
  'sessionsecret',
]);

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (REDACT_KEYS.has(key.toLowerCase())) {
      out[key] = '[redacted]';
    } else {
      out[key] = redact(val, depth + 1);
    }
  }
  return out;
}

const minLevel = LEVELS[(config.logLevel as Level) ?? 'info'] ?? LEVELS.info;

function log(level: Level, message: string, fields?: Record<string, unknown>): void {
  if (LEVELS[level] < minLevel) return;
  const entry = {
    ts: new Date().toISOString(),
    level,
    message,
    ...((redact(fields ?? {}) as Record<string, unknown>) ?? {}),
  };
  const line = JSON.stringify(entry);
  if (level === 'error') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

export const logger = {
  debug: (message: string, fields?: Record<string, unknown>) => log('debug', message, fields),
  info: (message: string, fields?: Record<string, unknown>) => log('info', message, fields),
  warn: (message: string, fields?: Record<string, unknown>) => log('warn', message, fields),
  error: (message: string, fields?: Record<string, unknown>) => log('error', message, fields),
  child(bindings: Record<string, unknown>) {
    return {
      debug: (message: string, fields?: Record<string, unknown>) => log('debug', message, { ...bindings, ...fields }),
      info: (message: string, fields?: Record<string, unknown>) => log('info', message, { ...bindings, ...fields }),
      warn: (message: string, fields?: Record<string, unknown>) => log('warn', message, { ...bindings, ...fields }),
      error: (message: string, fields?: Record<string, unknown>) => log('error', message, { ...bindings, ...fields }),
    };
  },
};

export type Logger = typeof logger;
