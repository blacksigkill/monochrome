import winston from 'winston';
import { config } from './config.js';

const { combine, timestamp, colorize, printf, errors } = winston.format;

const format = combine(
    errors({ stack: true }),
    timestamp(),
    colorize(),
    printf(({ timestamp, level, message, stack }) => {
        const output = stack || message;
        return `${timestamp} [${level}]: ${output}`;
    })
);

export const logger = winston.createLogger({
    level: config.logLevel,
    format,
    transports: [new winston.transports.Console()],
});
