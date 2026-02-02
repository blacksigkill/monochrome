import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import downloadRoutes from './routes/download-routes.js';
import { logger } from './logger.js';

// Create Express app
const app = express();

// CORS configuration
app.use(
    cors({
        origin: config.allowedOrigins,
        credentials: true,
    })
);

// Body parser
app.use(express.json());

// Request logging
app.use((req, res, next) => {
    logger.info(`${req.method} ${req.originalUrl}`);
    next();
});

// Routes
app.use('/api/download', downloadRoutes);

app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Error handler
app.use((err, req, res, next) => {
    logger.error(`Error: ${err.message}`);
    res.status(500).json({ error: 'Internal server error' });
});

// Start server
const port = config.port;
app.listen(port, () => {
    logger.info(`Monochrome Backend started on port ${port}`);
    logger.info(`Storage path: ${config.storagePath}`);
    logger.info(`Allowed origins: ${config.allowedOrigins.join(', ') || 'none'}`);
});

export default app;
