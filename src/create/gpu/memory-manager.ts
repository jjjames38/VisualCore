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

import { type ModelSlot, type GPUStatus } from '../providers/types.js';
import { logger } from '../../config/logger.js';
import { EventEmitter } from 'node:events';

interface ModelInfo {
  vram_gb: number;
  load_time_ms: number;     // Estimated load time
  unload_time_ms: number;   // Estimated unload time
  health_url?: string;      // Health check endpoint
  load_url?: string;        // Explicit load endpoint
  unload_url?: string;      // Explicit unload endpoint
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
const VRAM_SAFETY_MARGIN_GB = 2; // Keep 2GB free for system overhead
const VRAM_AVAILABLE_GB = VRAM_TOTAL_GB - VRAM_SAFETY_MARGIN_GB;

interface SwapRequest {
  model: ModelSlot;
  resolve: () => void;
  reject: (err: Error) => void;
}

export class GPUMemoryManager extends EventEmitter {
  /** Currently loaded primary model (not counting always-resident models) */
  private primaryModel: ModelSlot | null = null;

  /** Models that are always resident (very small VRAM footprint) */
  private residentModels: Set<ModelSlot> = new Set();

  /** Is a swap currently in progress? */
  private swapping = false;

  /** Queue of pending swap requests */
  private swapQueue: SwapRequest[] = [];

  /** Cumulative VRAM of resident models */
  private residentVram = 0;

  constructor(options?: { fishSpeechResident?: boolean }) {
    super();

    // Fish Speech is always resident by default
    if (options?.fishSpeechResident !== false) {
      const fishInfo = MODEL_REGISTRY['fish-speech'];
      this.residentModels.add('fish-speech');
      this.residentVram += fishInfo.vram_gb;
      logger.info('GPU Memory Manager: Fish Speech marked as resident', {
        vram_used: `${this.residentVram}GB`,
      });
    }
  }

  /**
   * Ensure a model is loaded. If a different model is currently loaded,
   * unload it first (swap). Queues concurrent requests.
   */
  async ensureLoaded(model: ModelSlot): Promise<void> {
    // Already loaded as primary?
    if (this.primaryModel === model) {
      return;
    }

    // Resident model? Always available.
    if (this.residentModels.has(model)) {
      return;
    }

    // If swap is in progress, queue this request
    if (this.swapping) {
      logger.debug('Swap in progress, queuing request', { model, queue_depth: this.swapQueue.length });
      return new Promise<void>((resolve, reject) => {
        this.swapQueue.push({ model, resolve, reject });
      });
    }

    await this.performSwap(model);
  }

  /**
   * Perform the actual model swap.
   */
  private async performSwap(target: ModelSlot): Promise<void> {
    this.swapping = true;
    const startTime = Date.now();

    try {
      const targetInfo = MODEL_REGISTRY[target];
      if (!targetInfo) {
        throw new Error(`Unknown model: ${target}`);
      }

      // Check VRAM budget
      const neededVram = targetInfo.vram_gb + this.residentVram;
      if (neededVram > VRAM_AVAILABLE_GB) {
        throw new Error(
          `Insufficient VRAM: ${target} needs ${targetInfo.vram_gb}GB + ` +
          `${this.residentVram}GB resident = ${neededVram}GB, ` +
          `but only ${VRAM_AVAILABLE_GB}GB available`,
        );
      }

      // Unload current primary model
      if (this.primaryModel) {
        await this.unloadModel(this.primaryModel);
        this.primaryModel = null;
      }

      // Small delay for VRAM to be released
      await this.sleep(1000);

      // Load target model
      await this.loadModel(target);
      this.primaryModel = target;

      const elapsed = Date.now() - startTime;
      logger.info('Model swap complete', {
        model: target,
        elapsed_ms: elapsed,
        vram_used: `${targetInfo.vram_gb + this.residentVram}GB / ${VRAM_TOTAL_GB}GB`,
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

  /**
   * Process queued swap requests after current swap completes.
   */
  private processQueue(): void {
    if (this.swapQueue.length === 0) return;

    // Deduplicate: if multiple requests want the same model, resolve them all
    const next = this.swapQueue.shift()!;

    // Find all requests for the same model and batch-resolve them
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

  /**
   * Load a model into GPU memory.
   */
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
        // Non-fatal: model may auto-load on first request
        logger.warn('Model load endpoint failed (will load on first use)', { model, error });
      }
    }
  }

  /**
   * Unload a model from GPU memory.
   */
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

    // Force garbage collection delay
    await this.sleep(info.unload_time_ms);
  }

  /**
   * Get current GPU status.
   */
  getStatus(): GPUStatus {
    const primaryVram = this.primaryModel
      ? MODEL_REGISTRY[this.primaryModel]?.vram_gb ?? 0
      : 0;

    return {
      current_model: this.primaryModel,
      resident_models: Array.from(this.residentModels),
      vram_used_gb: primaryVram + this.residentVram,
      vram_total_gb: VRAM_TOTAL_GB,
      is_swapping: this.swapping,
      swap_queue_depth: this.swapQueue.length,
    };
  }

  /**
   * Force unload all models (for shutdown / emergency).
   */
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
