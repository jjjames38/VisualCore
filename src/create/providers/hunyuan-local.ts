/**
 * VisualCore — HunyuanVideo 1.5 Local Provider
 *
 * Generates 5-second video clips from text+image via locally hosted HunyuanVideo 1.5.
 * Uses step-distilled model for ~19s/clip on RTX 4090 (8-step inference).
 *
 * Key specs:
 *   - Model: HunyuanVideo 1.5 (8.3B, Tencent open-source)
 *   - VRAM: 14GB (with CPU offloading)
 *   - Speed: ~19s per 5s clip (step-distilled, RTX 4090)
 *   - Output: 480p base → upscale to 720p/1080p via Real-ESRGAN
 */

import { randomUUID } from 'node:crypto';
import {
  type GenerateProvider,
  type GenerateRequest,
  type GenerateResponse,
  type ProviderName,
} from '@gstack/types';
import { logger } from '../../config/logger.js';

interface HunyuanConfig {
  host: string;
  port: number;
  enable_step_distill: boolean;
  default_steps: number;
}

interface HunyuanGenerateBody {
  prompt: string;
  image_path?: string;
  width: number;
  height: number;
  num_frames: number;
  num_inference_steps: number;
  enable_step_distill: boolean;
  seed: number;
  cfg_scale: number;
  enable_cpu_offload: boolean;
}

interface HunyuanResponse {
  video_path: string;
  elapsed_ms: number;
  width: number;
  height: number;
  num_frames: number;
  fps: number;
}

export class HunyuanLocalProvider implements GenerateProvider {
  readonly name: ProviderName = 'hunyuan-local';

  private config: HunyuanConfig;
  private baseUrl: string;

  constructor(config: HunyuanConfig) {
    this.config = config;
    this.baseUrl = `http://${config.host}:${config.port}`;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async generate(req: GenerateRequest): Promise<GenerateResponse> {
    const startTime = Date.now();
    const id = randomUUID();

    if (req.type !== 'image-to-video') {
      return {
        id,
        status: 'failed',
        provider: this.name,
        cost: 0,
        error: 'HunyuanLocalProvider only supports image-to-video',
        created_at: new Date(startTime).toISOString(),
      };
    }

    try {
      const duration = req.duration ?? 5;
      const fps = 24;
      const numFrames = duration * fps;

      // Resolution: generate at 480p (848×480 for 16:9), then upscale later
      const { width, height } = this.resolveBaseResolution(req.aspect_ratio ?? '16:9');

      const body: HunyuanGenerateBody = {
        prompt: req.prompt,
        image_path: req.source_image_url,
        width,
        height,
        num_frames: numFrames,
        num_inference_steps: this.config.default_steps,
        enable_step_distill: this.config.enable_step_distill,
        seed: req.seed != null && req.seed >= 0 ? req.seed : -1,
        cfg_scale: 7.0,
        enable_cpu_offload: true,
      };

      logger.info('HunyuanVideo generation started', {
        id,
        width,
        height,
        frames: numFrames,
        steps: body.num_inference_steps,
      });

      // Call local HunyuanVideo REST API
      const res = await fetch(`${this.baseUrl}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        // 5-minute timeout for video generation
        signal: AbortSignal.timeout(300_000),
      });

      if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`HunyuanVideo API error (${res.status}): ${errorText}`);
      }

      const result = (await res.json()) as HunyuanResponse;
      const gpuTimeMs = Date.now() - startTime;

      logger.info('HunyuanVideo generation complete', {
        id,
        elapsed_ms: result.elapsed_ms,
        video_path: result.video_path,
      });

      return {
        id,
        status: 'done',
        provider: this.name,
        output: {
          url: result.video_path,
          width: result.width,
          height: result.height,
          duration,
          format: 'mp4',
        },
        cost: 0,
        gpu_time_ms: gpuTimeMs,
        created_at: new Date(startTime).toISOString(),
        completed_at: new Date().toISOString(),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('HunyuanVideo generation failed', { id, error: message });

      return {
        id,
        status: 'failed',
        provider: this.name,
        cost: 0,
        error: message,
        created_at: new Date(startTime).toISOString(),
      };
    }
  }

  /**
   * Base resolution for 480p generation (upscale happens separately).
   * Dimensions rounded to nearest 16 for HunyuanVideo compatibility.
   */
  private resolveBaseResolution(ratio: string): { width: number; height: number } {
    const map: Record<string, { width: number; height: number }> = {
      '16:9': { width: 848, height: 480 },
      '9:16': { width: 480, height: 848 },
      '1:1': { width: 640, height: 640 },
      '4:3': { width: 640, height: 480 },
      '4:5': { width: 576, height: 720 },
    };
    return map[ratio] ?? map['16:9'];
  }

  /**
   * Warmup: preload model weights to reduce first-generation latency.
   */
  async warmup(): Promise<void> {
    try {
      await fetch(`${this.baseUrl}/warmup`, { method: 'POST' });
      logger.info('HunyuanVideo model warmed up');
    } catch (error) {
      logger.warn('HunyuanVideo warmup failed (non-critical)', { error });
    }
  }
}
