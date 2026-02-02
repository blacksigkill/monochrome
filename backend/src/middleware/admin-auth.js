import { timingSafeEqual } from 'crypto';
import { config } from '../config.js';
import { logger } from '../logger.js';

const safeEqual = (value, expected) => {
    const valueBuffer = Buffer.from(String(value));
    const expectedBuffer = Buffer.from(String(expected));

    if (valueBuffer.length !== expectedBuffer.length) {
        return false;
    }

    return timingSafeEqual(valueBuffer, expectedBuffer);
};

const unauthorized = (res) => {
    res.set('WWW-Authenticate', 'Basic realm="Monochrome Admin"');
    res.status(401).send('Authentication required');
};

export const requireAdminAuth = (req, res, next) => {
    if (!config.adminPassword) {
        logger.warn('Admin password not configured. Set ADMIN_PASSWORD in the environment.');
        return res.status(503).json({ error: 'Admin access not configured' });
    }

    const header = req.headers.authorization;
    if (!header || !header.startsWith('Basic ')) {
        return unauthorized(res);
    }

    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const separatorIndex = decoded.indexOf(':');
    if (separatorIndex === -1) {
        return unauthorized(res);
    }

    const username = decoded.slice(0, separatorIndex);
    const password = decoded.slice(separatorIndex + 1);

    if (!safeEqual(username, config.adminUsername) || !safeEqual(password, config.adminPassword)) {
        return unauthorized(res);
    }

    return next();
};
