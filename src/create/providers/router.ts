/**
 * VisualCore — Provider Router
 *
 * Routes GenerateRequests to the correct provider based on:
 *   - type (text-to-image / image-to-video / upscale)
 *   - visual_priority (normal → local GPU, high → Seedance API)
 *   - is_thumbnail flag
 *   - fallback logic (local unavailable → remote API)
 */

import { type GenerateRequest, type GenerateProvider, type ProviderName, type VisualCoreConfig } from './types.js';
import { FluxKleinProvider } from './flux-klein.js';
import { HunyuanLocalProvider } from './hunyuan-local.js';
import { SeedanceRemoteProvider } from './seedance-remote.js';
import { RealEsrganProvider } from './realesrgan.js';
import { GPUMemoryManager } from '../gpu/memory-manager.js';
import { logger } from '../../config/logger.js';

export class ProviderRouter {
  private providers: Map<ProviderName, GenerateProvider> = new Map();
  private gpu: GPUMemoryManager;
  private config: VisualCoreConfig;

  constructor(config: VisualCoreConfig, gpu: GPUMemoryManager) {
    this.config = config;
    this.gpu = gpu;

    // Register providers
    this.providers.set('flux-klein', new FluxKleinProvider(config.comfyui, config.lora_presets));
    this.providers.set('hunyuan-local', new HunyuanLocalProvider(config.hunyuan));
    this.providers.set('seedance-remote', new SeedanceRemoteProvider(config.seedance));
    this.providers.set('realesrgan', new RealEsrganProvider());

    logger.info('ProviderRouter initialized', {
      providers: Array.from(this.providers.keys()),
    });
  }

  /**
   * Determine the best provider for a given request.
   */
  async route(req: GenerateRequest): Promise<GenerateProvider> {
    const name = await this.selectProvider(req);
    const provider = this.providers.get(name);

    if (!provider) {
      throw new Error(`Provider '${name}' not registered`);
    }

    // Ensure the correct GPU model is loaded before returning
    await this.prepareGPU(name);

    logger.info('Request routed', {
      type: req.type,
      priority: req.visual_priority,
      provider: name,
    });

    return provider;
  }

  /**
   * Core routing logic.
   */
  private async selectProvider(req: GenerateRequest): Promise<ProviderName> {
    // ── Upscale ──
    if (req.type === 'upscale') {
      return 'realesrgan';
    }

    // ── Image-to-Video ──
    if (req.type === 'image-to-video') {
      // High priority scenes → Seedance API (better motion quality)
      if (req.visual_priority === 'high') {
        const seedance = this.providers.get('seedance-remote');
        if (seedance && (await seedance.isAvailable())) {
          return 'seedance-remote';
        }
        logger.warn('Seedance API unavailable, falling back to HunyuanVideo local');
      }

      // Normal priority → local HunyuanVideo
      const hunyuan = this.providers.get('hunyuan-local');
      if (hunyuan && (await hunyuan.isAvailable())) {
        return 'hunyuan-local';
      }

      // Fallback: if local is down, use Seedance API
      logger.warn('HunyuanVideo local unavailable, falling back to Seedance API');
      return 'seedance-remote';
    }

    // ── Text-to-Image (default) ──
    const flux = this.providers.get('flux-klein');
    if (flux && (await flux.isAvailable())) {
      return 'flux-klein';
    }

    // Fallback: Seedream API if local Flux is unavailable
    logger.warn('Flux Klein local unavailable, would need Seedream API fallback');
    throw new Error('No image provider available. Ensure ComfyUI is running.');
  }

  /**
   * Ensure the required GPU model is loaded (triggers swap if needed).
   */
  private async prepareGPU(provider: ProviderName): Promise<void> {
    switch (provider) {
      case 'flux-klein':
        await this.gpu.ensureLoaded('flux-klein');
        break;
      case 'hunyuan-local':
        await this.gpu.ensureLoaded('hunyuan');
        break;
      case 'realesrgan':
        await this.gpu.ensureLoaded('realesrgan');
        break;
      // Remote providers don't need GPU
      case 'seedance-remote':
        break;
    }
  }

  /**
   * Get a specific provider by name (for direct access / testing).
   */
  getProvider(name: ProviderName): GenerateProvider | undefined {
    return this.providers.get(name);
  }

  /**
   * Health check — returns availability of all providers.
   */
  async healthCheck(): Promise<Record<ProviderName, boolean>> {
    const results: Partial<Record<ProviderName, boolean>> = {};

    for (const [name, provider] of this.providers) {
      try {
        results[name] = await provider.isAvailable();
      } catch {
        results[name] = false;
      }
    }

    return results as Record<ProviderName, boolean>;
  }
}
