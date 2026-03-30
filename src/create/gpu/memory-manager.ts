/**
 * VisualCore — GPU Memory Manager
 *
 * Manages model loading/unloading on a single RTX 4090 (24GB VRAM).
 * Prevents OOM by ensuring incompatible models don't coexist.
 *
 * VRAM Budget:
 *   Flux Klein 4B  → ~8GB
 *   HunyuanVideo   → ~14GB (with offloading)
 *   Fish Speech S2  → ~2GB  (always resident)
 *   Real-ESRGAN    → ~1GB
 *
 * Compatible pairs:
 *   [flux-klein, fish-speech]    → 8 + 2 = 10GB ✅
 *   [realesrgan, fish-speech]    → 1 + 2 = 3GB  ✅
 *   [hunyuan, fish-speech]       → 14 + 2 = 16GB ⚠️ tight but works with offloading
 *
 * Incompatible:
 *   [flux-klein, hunyuan]        → 8 + 14 = 22GB ❌ too close to 24GB limit
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { type ModelSlot, type GPUStatus } from '@gstack/types';
import { logger } from '../../config/logger.js';
import { EventEmitter } from 'node:events';

const execFileAsync = promisify(execFile);

interface ModelInfo {
  vram_gb: number;
  load_time_ms: number;
  unload_time_ms: number;
  health_url?: string;
  load_url?: string;
  unload_url?: string;
}

const MODEL_REGISTRY: Record<ModelSlot, ModelInfo> = {
  'flux-klein': {
    vram_gb: 8,
    load_time_ms: 3000,
    unload_time_ms: 2000,
    health_url: 'http://localhost:8188/system_stats',
    unload_url: 'http://localhost:8188/free',
  },
  'flux-dev': {
    vram_gb: 20,
    load_time_ms: 8000,
    unload_time_ms: 3000,
    health_url: 'http://localhost:8188/system_stats',
    unload_url: 'http://localhost:8188/free',
  },
  'hunyuan': {
    vram_gb: 14,
    load_time_ms: 8000,
    unload_time_ms: 3000,
    health_url: 'http://localhost:8190/health',
    load_url: 'http://localhost:8190/warmup',
    unload_url: 'http://localhost:8190/unload',
  },
  'fish-speech': {
    vram_gb: 2,
    load_time_ms: 2000,
    unload_time_ms: 1000,
    health_url: 'http://localhost:8080/health',
  },
  'realesrgan': {
    vram_gb: 1,
    load_time_ms: 1000,
    unload_time_ms: 500,
  },
};

const VRAM_TOTAL_GB = 24;
const VRAM_SAFETY_MARGIN_GB = 2;
const VRAM_AVAILABLE_GB = VRAM_TOTAL_GB - VRAM_SAFETY_MARGIN_GB;

interface SwapRequest {
  model: ModelSlot;
  resolve: () => void;
  reject: (err: Error) => void;
}

export class GPUMemoryManager extends EventEmitter {
  private primaryModel: ModelSlot | null = null;
  private residentModels: Set<ModelSlot> = new Set();
  private swapping = false;
  private swapQueue: SwapRequest[] = [];
  private residentVram = 0;
  /** Last queried actual VRAM from nvidia-smi (null if unavailable) */
  private lastActualVram: number | null = null;

  constructor(options?: { fishSpeechResident?: boolean }) {
    super();

    if (options?.fishSpeechResident !== false) {
      const fishInfo = MODEL_REGISTRY['fish-speech'];
      this.residentModels.add('fish-speech');
      this.residentVram += fishInfo.vram_gb;
      logger.info('GPU Memory Manager: Fish Speech marked as resident', {
        vram_used: `${this.residentVram}GB`,
      });
    }
  }

  async ensureLoaded(model: ModelSlot): Promise<void> {
    if (this.primaryModel === model) return;
    if (this.residentModels.has(model)) return;

    if (this.swapping) {
      logger.debug('Swap in progress, queuing request', { model, queue_depth: this.swapQueue.length });
      return new Promise<void>((resolve, reject) => {
        this.swapQueue.push({ model, resolve, reject });
      });
    }

    await this.performSwap(model);
  }

  private async performSwap(target: ModelSlot): Promise<void> {
    this.swapping = true;
    const startTime = Date.now();

    try {
      const targetInfo = MODEL_REGISTRY[target];
      if (!targetInfo) {
        throw new Error(`Unknown model: ${target}`);
      }

      // VRAM budget is enforced upstream by GPUSchedulerWorker.
      // Soft warning only (observability, not enforcement).
      const neededVram = targetInfo.vram_gb + this.residentVram;
      if (neededVram > VRAM_AVAILABLE_GB * 0.9) {
        logger.warn('VRAM usage above 90%', {
          model: target,
          needed_gb: neededVram,
          available_gb: VRAM_AVAILABLE_GB,
        });
      }

      if (this.primaryModel) {
        await this.unloadModel(this.primaryModel);
        this.primaryModel = null;
      }

      await this.sleep(1000);

      await this.loadModel(target);
      this.primaryModel = target;

      // Query actual VRAM after swap for monitoring
      await this.refreshActualVram();

      const elapsed = Date.now() - startTime;
      logger.info('Model swap complete', {
        model: target,
        elapsed_ms: elapsed,
        vram_estimated: `${targetInfo.vram_gb + this.residentVram}GB / ${VRAM_TOTAL_GB}GB`,
        vram_actual: this.lastActualVram != null ? `${this.lastActualVram.toFixed(1)}GB` : 'unknown',
      });

      this.emit('swap', { model: target, elapsed_ms: elapsed });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Model swap failed', { target, error: message });
      this.emit('swap_error', { model: target, error: message });
      throw error;
    } finally {
      this.swapping = false;
      this.processQueue();
    }
  }

  private processQueue(): void {
    if (this.swapQueue.length === 0) return;

    const next = this.swapQueue.shift()!;
    const sameModel = this.swapQueue.filter(r => r.model === next.model);
    this.swapQueue = this.swapQueue.filter(r => r.model !== next.model);

    this.performSwap(next.model)
      .then(() => {
        next.resolve();
        sameModel.forEach(r => r.resolve());
      })
      .catch((err) => {
        next.reject(err);
        sameModel.forEach(r => r.reject(err));
      });
  }

  private async loadModel(model: ModelSlot): Promise<void> {
    const info = MODEL_REGISTRY[model];
    logger.debug('Loading model', { model, estimated_ms: info.load_time_ms });

    if (info.load_url) {
      try {
        const res = await fetch(info.load_url, {
          method: 'POST',
          signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok) {
          logger.warn(`Model load endpoint returned ${res.status}`, { model });
        }
      } catch (error) {
        logger.warn('Model load endpoint failed (will load on first use)', { model, error });
      }
    }
  }

  private async unloadModel(model: ModelSlot): Promise<void> {
    const info = MODEL_REGISTRY[model];
    logger.debug('Unloading model', { model });

    if (info.unload_url) {
      try {
        await fetch(info.unload_url, {
          method: 'POST',
          signal: AbortSignal.timeout(10_000),
        });
      } catch (error) {
        logger.warn('Model unload endpoint failed', { model, error });
      }
    }

    await this.sleep(info.unload_time_ms);
  }

  // ─── Actual VRAM Monitoring ───

  /**
   * Query actual GPU VRAM usage.
   * Priority: ComfyUI /system_stats → nvidia-smi → null (unavailable)
   */
  async refreshActualVram(): Promise<number | null> {
    // Try ComfyUI system_stats first
    try {
      const res = await fetch('http://localhost:8188/system_stats', {
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        const stats = await res.json() as {
          system?: { vram_used?: number; vram_total?: number };
          devices?: Array<{ vram_used: number; vram_total: number }>;
        };
        // ComfyUI returns bytes; convert to GB
        const device = stats.devices?.[0];
        if (device?.vram_used) {
          this.lastActualVram = device.vram_used / (1024 ** 3);
          return this.lastActualVram;
        }
      }
    } catch {
      // ComfyUI not available, try nvidia-smi
    }

    // Try nvidia-smi (no shell — execFile with args)
    try {
      const { stdout } = await execFileAsync(
        'nvidia-smi',
        ['--query-gpu=memory.used', '--format=csv,noheader,nounits'],
        { timeout: 5000 },
      );
      const mbUsed = parseFloat(stdout.trim().split('\n')[0]);
      if (!isNaN(mbUsed)) {
        this.lastActualVram = mbUsed / 1024;
        return this.lastActualVram;
      }
    } catch {
      // nvidia-smi not available (dev environment)
    }

    this.lastActualVram = null;
    return null;
  }

  getStatus(): GPUStatus {
    const primaryVram = this.primaryModel
      ? MODEL_REGISTRY[this.primaryModel]?.vram_gb ?? 0
      : 0;

    return {
      current_model: this.primaryModel,
      resident_models: Array.from(this.residentModels),
      vram_used_gb: primaryVram + this.residentVram,
      vram_actual_gb: this.lastActualVram,
      vram_total_gb: VRAM_TOTAL_GB,
      is_swapping: this.swapping,
      swap_queue_depth: this.swapQueue.length,
    };
  }

  async unloadAll(): Promise<void> {
    if (this.primaryModel) {
      await this.unloadModel(this.primaryModel);
      this.primaryModel = null;
    }
    logger.info('All models unloaded');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
