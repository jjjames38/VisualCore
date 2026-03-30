/**
 * VisualCore — Create API Routes
 *
 * POST /create/v1/generate         — Submit generation job
 * GET  /create/v1/generate/:id     — Query job status
 * POST /create/v1/generate/batch   — Submit batch of jobs
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Queue, Job } from 'bullmq';
import type { ProviderRouter } from '../create/providers/router.js';
import type { QCPipeline } from '../create/qc/pipeline.js';
import type { GenerateRequest, GenerateResponse } from '@gstack/types';
import { submitBatch, type CreateBatchRequest } from '../create/queue/create-jobs.js';
import { logger } from '../config/logger.js';

// ─── Request Body Types ───

interface GenerateBody {
  type: GenerateRequest['type'];
  prompt: string;
  negative_prompt?: string;
  style?: string;
  aspect_ratio?: string;
  resolution?: string;
  duration?: number;
  visual_priority?: 'normal' | 'high';
  source_image_url?: string;
  seed?: number;
  upscale_factor?: number;
  is_thumbnail?: boolean;
  callback_url?: string;
}

interface BatchBody {
  items: Array<{ request: GenerateBody; priority?: number }>;
  callback_url?: string;
}

// ─── Auth Middleware ───

function authHook(app: FastifyInstance) {
  const authConfig = (app as any).authConfig as { enabled: boolean; apiKeys: string[] } | undefined;

  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!authConfig?.enabled) return;

    const apiKey = req.headers['x-api-key'] as string | undefined;
    if (apiKey && authConfig.apiKeys.includes(apiKey)) return;

    reply.status(401).send({ success: false, message: 'Unauthorized: invalid x-api-key' });
  };
}

// ─── Validation ───

const VALID_TYPES = new Set(['text-to-image', 'image-to-video', 'upscale']);

function validateGenerateBody(body: unknown): { ok: true; data: GenerateBody } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'Request body is required' };
  }

  const b = body as Record<string, unknown>;

  if (!b.type || !VALID_TYPES.has(b.type as string)) {
    return { ok: false, error: "type is required: 'text-to-image' | 'image-to-video' | 'upscale'" };
  }

  if (b.type !== 'upscale' && (!b.prompt || typeof b.prompt !== 'string')) {
    return { ok: false, error: 'prompt is required (string)' };
  }

  if ((b.type === 'image-to-video' || b.type === 'upscale') && !b.source_image_url) {
    return { ok: false, error: 'source_image_url is required for image-to-video and upscale' };
  }

  return { ok: true, data: b as unknown as GenerateBody };
}

// ─── Routes ───

export async function generateRoutes(app: FastifyInstance): Promise<void> {
  const auth = authHook(app);

  // ── POST /create/v1/generate ──
  app.post('/create/v1/generate', { preHandler: auth }, async (req, reply) => {
    const validation = validateGenerateBody(req.body);
    if (!validation.ok) {
      return reply.status(400).send({ success: false, message: validation.error });
    }

    const generateReq: GenerateRequest = {
      type: validation.data.type,
      prompt: validation.data.prompt ?? '',
      negative_prompt: validation.data.negative_prompt,
      style: validation.data.style,
      aspect_ratio: validation.data.aspect_ratio as GenerateRequest['aspect_ratio'],
      resolution: validation.data.resolution as GenerateRequest['resolution'],
      duration: validation.data.duration,
      visual_priority: validation.data.visual_priority,
      source_image_url: validation.data.source_image_url,
      seed: validation.data.seed,
      upscale_factor: validation.data.upscale_factor as GenerateRequest['upscale_factor'],
      is_thumbnail: validation.data.is_thumbnail,
      callback_url: validation.data.callback_url,
    };

    const queue = (app as any).queue as Queue | undefined;

    // Queue mode: enqueue and return 202
    if (queue) {
      const job = await queue.add(`create_${generateReq.type}`, {
        request: generateReq,
        callback_url: generateReq.callback_url,
      });

      logger.info('Job enqueued', { job_id: job.id, type: generateReq.type });

      return reply.status(202).send({
        success: true,
        message: 'Generation queued',
        response: {
          id: job.id,
          status: 'queued',
          type: generateReq.type,
          created_at: new Date().toISOString(),
        },
      });
    }

    // Direct mode (no Redis / testing): execute synchronously
    const router = (app as any).router as ProviderRouter | undefined;
    const qcPipeline = (app as any).qcPipeline as QCPipeline | undefined;

    if (!router) {
      return reply.status(503).send({
        success: false,
        message: 'No providers available (router not initialized)',
      });
    }

    try {
      const provider = await router.route(generateReq);
      let result: GenerateResponse;

      if (qcPipeline) {
        result = await qcPipeline.generateWithQC(generateReq, provider);
      } else {
        result = await provider.generate(generateReq);
      }

      return reply.status(200).send({
        success: true,
        message: 'Generation complete',
        response: result,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Direct generation failed', { error: message });
      return reply.status(500).send({ success: false, message });
    }
  });

  // ── GET /create/v1/generate/:id ──
  app.get('/create/v1/generate/:id', { preHandler: auth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const queue = (app as any).queue as Queue | undefined;

    if (!queue) {
      return reply.status(503).send({
        success: false,
        message: 'Queue not available (Redis not configured)',
      });
    }

    const job = await queue.getJob(id) as Job | undefined;
    if (!job) {
      return reply.status(404).send({ success: false, message: 'Job not found' });
    }

    const state = await job.getState();
    const result = job.returnvalue as { response?: GenerateResponse } | undefined;

    return reply.send({
      success: true,
      response: {
        id: job.id,
        status: state === 'completed' ? 'done' : state,
        type: job.data?.request?.type,
        provider: result?.response?.provider,
        output: result?.response?.output,
        cost: result?.response?.cost,
        gpu_time_ms: result?.response?.gpu_time_ms,
        qc: result?.response?.qc,
        error: job.failedReason,
        created_at: new Date(job.timestamp).toISOString(),
        completed_at: job.finishedOn ? new Date(job.finishedOn).toISOString() : undefined,
      },
    });
  });

  // ── POST /create/v1/generate/batch ──
  app.post('/create/v1/generate/batch', { preHandler: auth }, async (req, reply) => {
    const body = req.body as BatchBody | undefined;

    if (!body?.items || !Array.isArray(body.items) || body.items.length === 0) {
      return reply.status(400).send({
        success: false,
        message: 'items array is required and must not be empty',
      });
    }

    const queue = (app as any).queue as Queue | undefined;
    if (!queue) {
      return reply.status(503).send({
        success: false,
        message: 'Queue not available (Redis not configured)',
      });
    }

    const batchReq: CreateBatchRequest = {
      items: body.items.map(item => ({
        request: {
          type: item.request.type,
          prompt: item.request.prompt ?? '',
          negative_prompt: item.request.negative_prompt,
          style: item.request.style,
          aspect_ratio: item.request.aspect_ratio as GenerateRequest['aspect_ratio'],
          resolution: item.request.resolution as GenerateRequest['resolution'],
          duration: item.request.duration,
          visual_priority: item.request.visual_priority,
          source_image_url: item.request.source_image_url,
          seed: item.request.seed,
          upscale_factor: item.request.upscale_factor as GenerateRequest['upscale_factor'],
          is_thumbnail: item.request.is_thumbnail,
        },
        priority: item.priority,
      })),
      callback_url: body.callback_url,
    };

    const result = await submitBatch(queue as any, batchReq);

    logger.info('Batch submitted', { batch_id: result.batch_id, total: result.total });

    return reply.status(202).send({
      success: true,
      message: `Batch queued: ${result.total} jobs`,
      response: result,
    });
  });
}
