/**
 * VisualCore — Fastify Server Factory
 *
 * Creates and configures the HTTP server with all services:
 *   - GPU Memory Manager
 *   - Provider Router (Flux, Hunyuan, Seedance, ESRGAN)
 *   - QC Pipeline
 *   - BullMQ Queue + Worker (when Redis available)
 *   - API routes (generate, health)
 *
 * Usage:
 *   const app = await createServer();
 *   await app.listen({ port: 3100 });
 */

import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { Redis } from 'ioredis';
import { config } from './config/index.js';
import { logger } from './config/logger.js';
import { GPUMemoryManager } from './create/gpu/memory-manager.js';
import { ProviderRouter } from './create/providers/router.js';
import { QCPipeline } from './create/qc/pipeline.js';
import { createCreateQueue, createCreateWorker } from './create/queue/create-jobs.js';
import { healthRoutes } from './api/health.js';
import { generateRoutes } from './api/generate.js';
import type { Queue, Worker } from 'bullmq';

interface ServerOptions {
  /** Skip queue/worker init for testing without Redis */
  testing?: boolean;
}

export async function createServer(opts?: ServerOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false, // We use our own logger
  });

  // ── CORS ──
  await app.register(cors, { origin: true });

  // ── Core Services ──
  const vc = config.visualCore;

  const gpu = new GPUMemoryManager({
    fishSpeechResident: vc.gpu.fish_speech_resident,
  });

  const router = new ProviderRouter(vc, gpu);

  const qcPipeline = new QCPipeline({
    clip_threshold: vc.qc.clip_threshold,
    aesthetic_threshold: vc.qc.aesthetic_threshold,
    nsfw_threshold: vc.qc.nsfw_threshold,
    temporal_threshold: 0.8,
    max_retries: vc.qc.max_retries,
    fallback_to_api: vc.qc.fallback_to_api,
  });

  // ── Attach to app for route access ──
  (app as any).router = router;
  (app as any).gpu = gpu;
  (app as any).qcPipeline = qcPipeline;
  (app as any).authConfig = config.auth;

  // ── BullMQ (only when Redis is available and not testing) ──
  let queue: Queue | undefined;
  let worker: Worker | undefined;
  let redis: InstanceType<typeof Redis> | undefined;

  if (!opts?.testing && config.redisUrl) {
    try {
      redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
      queue = createCreateQueue(config.redisUrl);
      worker = createCreateWorker(config.redisUrl, router, qcPipeline, gpu);
      (app as any).queue = queue;

      logger.info('BullMQ initialized', { redis: config.redisUrl });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn('BullMQ init failed (running without queue)', { error: msg });
    }
  } else {
    const reason = opts?.testing ? 'testing mode' : 'REDIS_URL not set';
    logger.info(`Queue disabled (${reason}) — direct execution mode`);
  }

  // ── Routes ──
  await app.register(healthRoutes);
  await app.register(generateRoutes);

  // ── Graceful Shutdown ──
  app.addHook('onClose', async () => {
    logger.info('Shutting down...');

    if (worker) {
      await worker.close();
      logger.info('Worker closed');
    }

    if (queue) {
      await queue.close();
      logger.info('Queue closed');
    }

    if (redis) {
      redis.disconnect();
    }

    // Dispose providers (closes persistent WebSocket connections)
    router.dispose();

    await gpu.unloadAll();
    logger.info('GPU models unloaded');
  });

  return app;
}
