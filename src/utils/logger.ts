import winston from 'winston';
import { mkdirSync } from 'fs';
import { dirname } from 'path';

const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const LOG_FILE = process.env.LOG_FILE || 'logs/polymarket.log';

// Detect MCP server context (stdio JSON-RPC). Never write to stdout here.
const isMcpServer =
  process.argv[1]?.includes('mcp.js') ||
  process.argv[1]?.includes('mcp.ts') ||
  process.env.MCP_MODE === '1' ||
  process.env.MCP_SERVER === 'true';

const logDir = dirname(LOG_FILE);
try {
  mkdirSync(logDir, { recursive: true });
} catch {
  // ignore
}

const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.printf(({ level, message, timestamp, ...meta }) => {
    const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    return `${timestamp} [${level}] ${message}${metaStr}`;
  })
);

const fileFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

const transports: winston.transport[] = [
  new winston.transports.File({
    filename: LOG_FILE,
    format: fileFormat,
    maxsize: 10 * 1024 * 1024, // 10MB
    maxFiles: 5,
  }),
];

// Only attach console logger for interactive CLI usage. MCP stdio forbids stdout pollution.
if (!isMcpServer) {
  transports.unshift(
    new winston.transports.Console({
      format: consoleFormat,
    })
  );
}

export const logger = winston.createLogger({
  level: LOG_LEVEL,
  defaultMeta: { service: 'polymarket-client' },
  transports,
  exitOnError: false,
});

// Convenience methods for trading context
export const logTrade = (msg: string, meta?: Record<string, unknown>) =>
  logger.info(msg, { category: 'trade', ...meta });

export const logWs = (msg: string, meta?: Record<string, unknown>) =>
  logger.debug(msg, { category: 'websocket', ...meta });

export const logError = (msg: string, error?: unknown, meta?: Record<string, unknown>) => {
  const errMeta = error instanceof Error ? { error: error.message, stack: error.stack } : { error };
  logger.error(msg, { ...errMeta, ...meta });
};
