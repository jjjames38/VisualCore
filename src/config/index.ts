/**
 * VisualCore — Configuration
 *
 * Parses environment variables into a typed VisualCoreConfig object.
 * Falls back to sensible defaults for local development.
 */

import dotenv from 'dotenv';
import { type VisualCoreConfig, type ModelSlot } from '@gstack/types';

dotenv.config();

function env(key: string, fallback: string = ''): string {
  return process.env[key] ?? fallback;
}

function envInt(key: string, fallback: number): number {
  const v = process.env[key];
  return v ? parseInt(v, 10) : fallback;
}

function envFloat(key: string, fallback: number): number {
  const v = process.env[key];
  return v ? parseFloat(v) : fallback;
}

function envBool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (!v) return fallback;
  return v === 'true' || v === '1';
}

/** Parse LORA_* env vars into { style_key: filename } map. */
function parseLoraPresets(): Record<string, string> {
  const presets: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('LORA_') && value) {
      // LORA_T1_SPACE → t1_space
      const style = key.slice(5).toLowerCase();
      presets[style] = value;
    }
  }
  return presets;
}

export const config = {
  /** Server */
  port: envInt('PORT', 3100),
  host: env('HOST', '0.0.0.0'),

  /** Redis */
  redisUrl: env('REDIS_URL', ''),

  /** Authentication */
  auth: {
    enabled: envBool('AUTH_ENABLED', false),
    apiKeys: env('API_KEYS', '').split(',').filter(Boolean),
  },

  /** Logging */
  logLevel: env('LOG_LEVEL', 'info') as 'debug' | 'info' | 'warn' | 'error',

  /** VisualCore provider config (matches VisualCoreConfig interface) */
  visualCore: {
    comfyui: {
      host: env('COMFYUI_HOST', 'localhost'),
      port: envInt('COMFYUI_PORT', 8188),
      protocol: env('COMFYUI_PROTOCOL', 'ws') as 'ws' | 'wss',
    },
    hunyuan: {
      host: env('HUNYUAN_HOST', 'localhost'),
      port: envInt('HUNYUAN_PORT', 8190),
      enable_step_distill: envBool('HUNYUAN_ENABLE_STEP_DISTILL', true),
      default_steps: envInt('HUNYUAN_DEFAULT_STEPS', 8),
    },
    seedance: {
      api_key: env('SEEDANCE_API_KEY', ''),
      api_url: env('SEEDANCE_API_URL', 'https://api.seedance.com/v1'),
      tier: env('SEEDANCE_TIER', 'fast') as 'fast' | 'pro',
    },
    seedream: {
      api_key: env('SEEDREAM_API_KEY', ''),
      api_url: env('SEEDREAM_API_URL', 'https://api.seedream.com/v1'),
    },
    qc: {
      clip_threshold: envFloat('QC_CLIP_THRESHOLD', 0.25),
      aesthetic_threshold: envFloat('QC_AESTHETIC_THRESHOLD', 5.0),
      nsfw_threshold: envFloat('QC_NSFW_THRESHOLD', 0.3),
      max_retries: envInt('QC_MAX_RETRIES', 3),
      fallback_to_api: envBool('QC_FALLBACK_TO_API', true),
    },
    gpu: {
      swap_strategy: env('GPU_SWAP_STRATEGY', 'on-demand') as 'on-demand' | 'scheduled',
      default_model: env('GPU_DEFAULT_MODEL', 'flux-klein') as ModelSlot,
      fish_speech_resident: envBool('GPU_FISH_SPEECH_RESIDENT', true),
      vram_total_gb: envInt('GPU_VRAM_TOTAL_GB', 24),
    },
    lora_presets: parseLoraPresets(),
  } satisfies VisualCoreConfig,
};

export type AppConfig = typeof config;
