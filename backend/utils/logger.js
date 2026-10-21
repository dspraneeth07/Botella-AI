/**
 * Winston Logger - Botella
 *
 * Structured JSON logging with context.
 * - Console: colored, human-readable in dev
 * - File: JSON format for production analysis
 */

const winston = require('winston');
const path = require('path');

const LOG_DIR = path.join(__dirname, '..', 'logs');

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'botella-api' },
  transports: [
    // Console - colorized for development
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message, service, ...meta }) => {
          const extra = Object.keys(meta).length > 0
            ? ' ' + JSON.stringify(meta)
            : '';
          return `${timestamp} [${level}] ${message}${extra}`;
        })
      ),
    }),
    // Error log file
    new winston.transports.File({
      filename: path.join(LOG_DIR, 'error.log'),
      level: 'error',
      maxsize: 5 * 1024 * 1024, // 5MB
      maxFiles: 5,
    }),
    // Combined log file
    new winston.transports.File({
      filename: path.join(LOG_DIR, 'combined.log'),
      maxsize: 10 * 1024 * 1024, // 10MB
      maxFiles: 5,
    }),
  ],
});

module.exports = logger;
