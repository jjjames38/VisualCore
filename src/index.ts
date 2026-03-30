/**
 * VisualCore — Entry Point
 *
 * Bootstraps the Fastify server and listens on the configured port.
 * Handles graceful shutdown on SIGINT/SIGTERM.
 */

import { config } from './config/index.js';
import { logger } from './config/logger.js';
import { createServer } from './server.js';

async function main(): Promise<void> {
  const app = await createServer();

  const { port, host } = config;

  await app.listen({ port, host });

  logger.info(`VisualCore server listening on http://${host}:${port}`);
  logger.info('Endpoints:', {
    health: `GET /`,
    providers: `GET /health`,
    status: `GET /status`,
    generate: `POST /create/v1/generate`,
    poll: `GET /create/v1/generate/:id`,
    batch: `POST /create/v1/generate/batch`,
  });

  // ── Graceful Shutdown ──
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down...`);
    await app.close();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error('Failed to start VisualCore', { error: String(err) });
  process.exit(1);
});
