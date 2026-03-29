/**
 * VisualCore — RenderForge Create API Provider Types
 * 
 * Core interfaces for local GPU inference providers (Flux, HunyuanVideo)
 * and remote API fallback (Seedance).
 */

// ─── Request / Response ───

export interface GenerateRequest {
  /** Generation type */
  type: 'text-to-image' | 'image-to-video' | 'upscale';

  /** Text prompt describing the desired output */
  prompt: string;

  /** Negative prompt — elements to exclude */
  negative_prompt?: string;

  /** Tier-specific LoRA style preset (e.g. 't1_space', 't7_crime') */
  style?: string;

  /** Output aspect ratio */
  aspect_ratio?: '16:9' | '9:16' | '1:1' | '4:3' | '4:5';

  /** Output resolution tier */
  resolution?: 'preview' | 'sd' | 'hd' | '1080' | '4k';

  /** Video duration in seconds (default: 5) */
  duration?: number;

  /** Visual priority — 'high' routes to Seedance API for critical scenes */
  visual_priority?: 'normal' | 'high';

  /** Source image URL — required for image-to-video and upscale */
  source_image_url?: string;

  /** Reproducibility seed (-1 = random) */
  seed?: number;

  /** Upscale factor (2 or 4) */
  upscale_factor?: 2 | 4;

  /** Whether this is a thumbnail (enables text rendering LoRA) */
  is_thumbnail?: boolean;

  /** Callback URL for async completion */
  callback_url?: string;
}

export interface GenerateResponse {
  /** Unique generation ID */
  id: string;

  /** Current status */
  status: GenerateStatus;

  /** Which provider handled this request */
  provider: ProviderName;

  /** Output asset details (present when status === 'done') */
  output?: GenerateOutput;

  /** Cost in USD ($0 for local, API price for remote) */
  cost: number;

  /** Local GPU processing time in ms */
  gpu_time_ms?: number;

  /** Quality check results */
  qc?: QCResult;

  /** Error message (present when status === 'failed') */
  error?: string;

  /** ISO timestamp */
  created_at: string;
  completed_at?: string;
}

export interface GenerateOutput {
  /** Asset URL (RenderForge Serve API path) */
  url: string;
  width: number;
  height: number;
  /** Duration in seconds (video only) */
  duration?: number;
  format: 'png' | 'jpg' | 'mp4' | 'gif';
}

export type GenerateStatus = 'queued' | 'processing' | 'done' | 'failed';

// ─── Provider ───

export type ProviderName =
  | 'flux-klein'
  | 'flux-dev'
  | 'hunyuan-local'
  | 'seedance-remote'
  | 'realesrgan'
  | 'seedream-remote';

export interface GenerateProvider {
  /** Provider identifier */
  readonly name: ProviderName;

  /** Check if the provider is available (model loaded, API reachable, etc.) */
  isAvailable(): Promise<boolean>;

  /** Generate an asset */
  generate(req: GenerateRequest): Promise<GenerateResponse>;

  /** Abort a running generation (best-effort) */
  abort?(jobId: string): Promise<void>;
}

// ─── Quality Control ───

export interface QCResult {
  pass: boolean;
  scores: QCScores;
  issues: string[];
  attempt: number;
}

export interface QCScores {
  /** CLIP score: prompt-image alignment (0–1, threshold: 0.25) */
  clip_score?: number;
  /** Aesthetic quality (0–10, threshold: 5.0) */
  aesthetic_score?: number;
  /** NSFW probability (0–1, reject > 0.3) */
  nsfw_score?: number;
  /** Video temporal consistency (0–1, threshold: 0.8) */
  temporal_consistency?: number;
  /** Video motion detected (false = static/frozen) */
  motion_detected?: boolean;
}

// ─── GPU Memory ───

export type ModelSlot = 'flux-klein' | 'flux-dev' | 'hunyuan' | 'fish-speech' | 'realesrgan';

export interface GPUStatus {
  current_model: ModelSlot | null;
  resident_models: ModelSlot[];
  vram_used_gb: number;
  vram_total_gb: number;
  is_swapping: boolean;
  swap_queue_depth: number;
}

// ─── Config ───

export interface VisualCoreConfig {
  comfyui: {
    host: string;
    port: number;
    /** WebSocket protocol (ws or wss) */
    protocol: 'ws' | 'wss';
  };
  hunyuan: {
    host: string;
    port: number;
    enable_step_distill: boolean;
    default_steps: number;
  };
  seedance: {
    api_key: string;
    api_url: string;
    tier: 'fast' | 'pro';
  };
  seedream: {
    api_key: string;
    api_url: string;
  };
  qc: {
    clip_threshold: number;
    aesthetic_threshold: number;
    nsfw_threshold: number;
    max_retries: number;
    fallback_to_api: boolean;
  };
  gpu: {
    swap_strategy: 'on-demand' | 'scheduled';
    default_model: ModelSlot;
    fish_speech_resident: boolean;
    vram_total_gb: number;
  };
  lora_presets: Record<string, string>;
}

// ─── Resolution Helpers ───

export interface Dimensions {
  width: number;
  height: number;
}

const RESOLUTION_BASE: Record<string, number> = {
  preview: 384,
  sd: 512,
  hd: 768,
  '1080': 1024,
  '4k': 2048,
};

const RATIO_MULTIPLIERS: Record<string, [number, number]> = {
  '16:9': [1, 9 / 16],
  '9:16': [9 / 16, 1],
  '1:1': [1, 1],
  '4:3': [1, 3 / 4],
  '4:5': [4 / 5, 1],
};

export function resolveDimensions(
  ratio: string = '16:9',
  resolution: string = 'hd',
): Dimensions {
  const base = RESOLUTION_BASE[resolution] ?? 1024;
  const [wMul, hMul] = RATIO_MULTIPLIERS[ratio] ?? [1, 9 / 16];

  // Round to nearest 8 (required by most diffusion models)
  const width = Math.round((base * wMul) / 8) * 8;
  const height = Math.round((base * hMul) / 8) * 8;

  return { width, height };
}

// ─── Cost Tracking ───

export interface CostEntry {
  provider: ProviderName;
  type: GenerateRequest['type'];
  cost_usd: number;
  gpu_time_ms: number;
  timestamp: string;
}
