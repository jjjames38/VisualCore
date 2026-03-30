/**
 * VisualCore — Health & Status Routes
 *
 * GET /           — Basic liveness check
 * GET /health     — Provider availability
 * GET /status     — GPU state + queue depth
 */

import type { FastifyInstance } from 'fastify';
import type { ProviderRouter } from '../create/providers/router.js';
import type { GPUMemoryManager } from '../create/gpu/memory-manager.js';
import type { Queue } from 'bullmq';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  // ── Liveness ──
  app.get('/', async () => ({
    name: 'visualcore',
    version: '1.0.0',
    status: 'ok',
  }));

  // ── Provider Health ──
  app.get('/health', async () => {
    const router = (app as any).router as ProviderRouter | undefined;

    if (!router) {
      return { status: 'degraded', providers: {} };
    }

    const providers = await router.healthCheck();
    const allUp = Object.values(providers).some(v => v);

    return {
      status: allUp ? 'ok' : 'degraded',
      providers,
    };
  });

  // ── GPU + Queue Status ──
  app.get('/status', async () => {
    const gpu = (app as any).gpu as GPUMemoryManager | undefined;
    const queue = (app as any).queue as Queue | undefined;

    const gpuStatus = gpu?.getStatus() ?? {
      current_model: null,
      resident_models: [],
      vram_used_gb: 0,
      vram_total_gb: 24,
      is_swapping: false,
      swap_queue_depth: 0,
    };

    let queueStatus = { waiting: 0, active: 0, completed: 0, failed: 0 };
    if (queue) {
      const [waiting, active, completed, failed] = await Promise.all([
        queue.getWaitingCount(),
        queue.getActiveCount(),
        queue.getCompletedCount(),
        queue.getFailedCount(),
      ]);
      queueStatus = { waiting, active, completed, failed };
    }

    return { gpu: gpuStatus, queue: queueStatus };
  });
}
