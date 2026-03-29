/**
 * VisualCore — BullMQ Create Queue
 *
 * Manages async generation jobs with:
 *   - Priority levels (thumbnails > video-high > images > video-normal > shorts)
 *   - Batch optimization (group same-model jobs to minimize GPU swaps)
 *   - Concurrency: 1 (single GPU, one job at a time)
 */

import { Queue, Worker, type Job } from 'bullmq';
import { type GenerateRequest, type GenerateResponse, type VisualCoreConfig } from '../providers/types.js';
import { ProviderRouter } from '../providers/router.js';
import { QCPipeline } from '../qc/pipeline.js';
import { GPUMemoryManager } from '../gpu/memory-manager.js';
import { logger } from '../../config/logger.js';

// ─── Priority Levels ───

export enum CreatePriority {
  /** Thumbnails needed right before upload */
  THUMBNAIL = 1,
  /** High-priority video scenes (Seedance API, no GPU wait) */
  VIDEO_HIGH = 2,
  /** Longform body images */
  IMAGE_LONGFORM = 3,
  /** Normal-priority video clips (HunyuanVideo local) */
  VIDEO_NORMAL = 4,
  /** Shorts images */
  IMAGE_SHORTS = 5,
  /** Post-processing upscale */
  UPSCALE = 6,
}

// ─── Job Data ───

interface CreateJobData {
  request: GenerateRequest;
  priority: CreatePriority;
  batch_id?: string;        // Group identifier for batch tracking
  callback_url?: string;    // Webhook on completion
}

interface CreateJobResult {
  response: GenerateResponse;
  batch_id?: string;
}

// ─── Batch Request ───

export interface CreateBatchRequest {
  items: Array<{
    request: GenerateRequest;
    priority?: CreatePriority;
  }>;
  callback_url?: string;
}

export interface CreateBatchResponse {
  batch_id: string;
  job_ids: string[];
  total: number;
  optimized_order: string[];  // Shows the reordered types
}

// ─── Queue Setup ───

export function createCreateQueue(redisUrl: string): Queue<CreateJobData, CreateJobResult> {
  return new Queue<CreateJobData, CreateJobResult>('create', {
    connection: parseRedisUrl(redisUrl),
    defaultJobOptions: {
      removeOnComplete: { count: 1000 },  // Keep last 1000 completed
      removeOnFail: { count: 500 },
      attempts: 1,  // Retries handled by QC pipeline, not BullMQ
    },
  });
}

// ─── Worker ───

export function createCreateWorker(
  redisUrl: string,
  router: ProviderRouter,
  qcPipeline: QCPipeline,
  gpu: GPUMemoryManager,
): Worker<CreateJobData, CreateJobResult> {
  const worker = new Worker<CreateJobData, CreateJobResult>(
    'create',
    async (job: Job<CreateJobData, CreateJobResult>) => {
      const { request, batch_id } = job.data;

      logger.info('Processing create job', {
        job_id: job.id,
        type: request.type,
        priority: job.data.priority,
        batch_id,
      });

      // Route to provider
      const provider = await router.route(request);

      // Determine fallback provider for QC failures
      let fallbackProvider;
      if (request.type === 'text-to-image') {
        fallbackProvider = router.getProvider('seedance-remote');
      } else if (request.type === 'image-to-video' && request.visual_priority !== 'high') {
        fallbackProvider = router.getProvider('seedance-remote');
      }

      // Generate with QC
      const response = await qcPipeline.generateWithQC(
        request,
        provider,
        fallbackProvider,
      );

      // Webhook callback
      if (job.data.callback_url && response.status === 'done') {
        await sendWebhook(job.data.callback_url, {
          job_id: job.id,
          batch_id,
          response,
        }).catch(err => logger.warn('Webhook failed', { error: err }));
      }

      return { response, batch_id };
    },
    {
      connection: parseRedisUrl(redisUrl),
      concurrency: 1,       // Single GPU — one job at a time
      limiter: {
        max: 1,
        duration: 500,       // Min 500ms between jobs (swap buffer)
      },
    },
  );

  worker.on('completed', (job) => {
    logger.info('Create job completed', {
      job_id: job.id,
      provider: job.returnvalue.response.provider,
      cost: `$${job.returnvalue.response.cost.toFixed(4)}`,
      gpu_ms: job.returnvalue.response.gpu_time_ms,
    });
  });

  worker.on('failed', (job, err) => {
    logger.error('Create job failed', {
      job_id: job?.id,
      error: err.message,
    });
  });

  return worker;
}

// ─── Batch Submission ───

/**
 * Submit a batch of generation requests with optimized ordering.
 * Groups same-type jobs together to minimize GPU model swaps.
 *
 * Swap-optimal order: images → videos → upscales
 * (max 2 swaps instead of potentially N swaps)
 */
export async function submitBatch(
  queue: Queue<CreateJobData, CreateJobResult>,
  batch: CreateBatchRequest,
): Promise<CreateBatchResponse> {
  const batchId = `batch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // Optimize order: group by type to minimize GPU swaps
  const optimized = optimizeBatchOrder(batch.items);

  const jobIds: string[] = [];

  for (const item of optimized) {
    const priority = item.priority ?? inferPriority(item.request);

    const job = await queue.add(
      `create_${item.request.type}`,
      {
        request: item.request,
        priority,
        batch_id: batchId,
        callback_url: batch.callback_url,
      },
      {
        priority,  // BullMQ priority (lower = higher priority)
      },
    );

    jobIds.push(job.id!);
  }

  logger.info('Batch submitted', {
    batch_id: batchId,
    total: jobIds.length,
    order: optimized.map(i => i.request.type),
  });

  return {
    batch_id: batchId,
    job_ids: jobIds,
    total: jobIds.length,
    optimized_order: optimized.map(i => i.request.type),
  };
}

/**
 * Reorder batch items to minimize GPU model swaps.
 * Groups: text-to-image → image-to-video → upscale
 * Within each group, high-priority (remote API) items go first (no GPU needed).
 */
function optimizeBatchOrder(
  items: CreateBatchRequest['items'],
): CreateBatchRequest['items'] {
  const remoteVideos = items.filter(
    i => i.request.type === 'image-to-video' && i.request.visual_priority === 'high',
  );
  const thumbnails = items.filter(
    i => i.request.type === 'text-to-image' && i.request.is_thumbnail,
  );
  const images = items.filter(
    i => i.request.type === 'text-to-image' && !i.request.is_thumbnail,
  );
  const localVideos = items.filter(
    i => i.request.type === 'image-to-video' && i.request.visual_priority !== 'high',
  );
  const upscales = items.filter(
    i => i.request.type === 'upscale',
  );

  // Remote first (no GPU swap), then images (Flux), then videos (HunyuanVideo), then upscale
  return [...remoteVideos, ...thumbnails, ...images, ...localVideos, ...upscales];
}

/**
 * Auto-assign priority based on request type and flags.
 */
function inferPriority(req: GenerateRequest): CreatePriority {
  if (req.is_thumbnail) return CreatePriority.THUMBNAIL;
  if (req.type === 'image-to-video' && req.visual_priority === 'high') return CreatePriority.VIDEO_HIGH;
  if (req.type === 'text-to-image') return CreatePriority.IMAGE_LONGFORM;
  if (req.type === 'image-to-video') return CreatePriority.VIDEO_NORMAL;
  if (req.type === 'upscale') return CreatePriority.UPSCALE;
  return CreatePriority.IMAGE_LONGFORM;
}

// ─── Helpers ───

function parseRedisUrl(url: string): { host: string; port: number } {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parseInt(parsed.port) || 6379,
  };
}

async function sendWebhook(url: string, data: unknown): Promise<void> {
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(10_000),
  });
}
