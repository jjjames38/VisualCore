/**
 * Logger stub — replace with RenderForge's actual logger (pino / winston).
 * This file exists so the VisualCore modules can be developed standalone.
 * In production, import from '../../config/logger.js' (RenderForge's logger).
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  level: LogLevel;
  msg: string;
  data?: Record<string, unknown>;
  timestamp: string;
}

function log(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
  const entry: LogEntry = {
    level,
    msg,
    data,
    timestamp: new Date().toISOString(),
  };

  const prefix = {
    debug: '\x1b[36m[DEBUG]\x1b[0m',
    info: '\x1b[32m[INFO]\x1b[0m',
    warn: '\x1b[33m[WARN]\x1b[0m',
    error: '\x1b[31m[ERROR]\x1b[0m',
  }[level];

  const dataStr = data ? ` ${JSON.stringify(data)}` : '';
  console.log(`${entry.timestamp} ${prefix} ${msg}${dataStr}`);
}

export const logger = {
  debug: (msg: string, data?: Record<string, unknown>) => log('debug', msg, data),
  info: (msg: string, data?: Record<string, unknown>) => log('info', msg, data),
  warn: (msg: string, data?: Record<string, unknown>) => log('warn', msg, data),
  error: (msg: string, data?: Record<string, unknown>) => log('error', msg, data),
};
