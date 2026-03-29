/**
 * VisualCore — Seedance Remote Provider (Fallback)
 *
 * Used only for visual_priority === 'high' scenes (emotional peaks,
 * character close-ups, complex camera work). ~20% of video clips.
 *
 * Cost: $0.022/second (Fast tier)
 * Monthly budget at Scale2: ~$27 (248 clips × 5s × $0.022)
 */

import { randomUUID } from 'node:crypto';
import {
  type GenerateProvider,
  type GenerateRequest,
  type GenerateResponse,
  type ProviderName,
} from './types.js';
import { logger } from '../../config/logger.js';

interface SeedanceConfig {
  api_key: string;
  api_url: string;
  tier: 'fast' | 'pro';
}

const TIER_COST_PER_SEC: Record<string, number> = {
  fast: 0.022,
  pro: 0.247,
};

export class SeedanceRemoteProvider implements GenerateProvider {
  readonly name: ProviderName = 'seedance-remote';

  private config: SeedanceConfig;

  constructor(config: SeedanceConfig) {
    this.config = config;
  }

  async isAvailable(): Promise<boolean> {
    if (!this.config.api_key || !this.config.api_url) {
      return false;
    }
    try {
      // Light health check (HEAD or a small endpoint)
      const res = await fetch(this.config.api_url, {
        method: 'HEAD',
        headers: { Authorization: `Bearer ${this.config.api_key}` },
        signal: AbortSignal.timeout(5000),
      });
      // Accept 200, 401 (auth valid but wrong endpoint), 404
      return res.status < 500;
    } catch {
      return false;
    }
  }

  async generate(req: GenerateRequest): Promise<GenerateResponse> {
    const startTime = Date.now();
    const id = randomUUID();
    const duration = req.duration ?? 5;

    try {
      if (!this.config.api_key) {
        throw new Error('Seedance API key not configured');
      }

      logger.info('Seedance API call (high-priority scene)', {
        id,
        duration,
        tier: this.config.tier,
      });

      const res = await fetch(`${this.config.api_url}/v1/video/generate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.api_key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          prompt: req.prompt,
          image_url: req.source_image_url,
          duration,
          resolution: '1080p',
          style: this.config.tier,
        }),
        signal: AbortSignal.timeout(180_000), // 3min timeout for API
      });

      if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`Seedance API error (${res.status}): ${errorText}`);
      }

      const result = await res.json() as {
        id: string;
        video_url: string;
        width: number;
        height: number;
        duration: number;
      };

      const costPerSec = TIER_COST_PER_SEC[this.config.tier] ?? 0.022;
      const cost = duration * costPerSec;

      logger.info('Seedance API complete', { id, cost: `$${cost.toFixed(3)}` });

      return {
        id,
        status: 'done',
        provider: this.name,
        output: {
          url: result.video_url,
          width: result.width || 1920,
          height: result.height || 1080,
          duration,
          format: 'mp4',
        },
        cost,
        gpu_time_ms: 0, // Remote, no local GPU usage
        created_at: new Date(startTime).toISOString(),
        completed_at: new Date().toISOString(),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Seedance API failed', { id, error: message });

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
}
