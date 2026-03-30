/**
 * VisualCore — Provider Router Tests
 *
 * Tests routing logic with mocked providers to verify:
 *   - type-based routing (T2I → flux, I2V → hunyuan, upscale → esrgan)
 *   - visual_priority routing (high → seedance)
 *   - fallback when local provider is unavailable
 *   - GPU prepareGPU is called correctly
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProviderRouter } from '../src/create/providers/router.js';
import { GPUMemoryManager } from '../src/create/gpu/memory-manager.js';
import type { GenerateRequest, VisualCoreConfig } from '@gstack/types';

// ─── Mock Config ───

const mockConfig: VisualCoreConfig = {
  comfyui: { host: 'localhost', port: 8188, protocol: 'ws' },
  hunyuan: { host: 'localhost', port: 8190, enable_step_distill: true, default_steps: 8 },
  seedance: { api_key: 'test-key', api_url: 'https://api.seedance.test', tier: 'fast' },
  seedream: { api_key: '', api_url: '' },
  qc: { clip_threshold: 0.25, aesthetic_threshold: 5.0, nsfw_threshold: 0.3, max_retries: 3, fallback_to_api: true },
  gpu: { swap_strategy: 'on-demand', default_model: 'flux-klein', fish_speech_resident: false, vram_total_gb: 24 },
  lora_presets: { t1_space: 'space_v1.safetensors' },
};

describe('ProviderRouter', () => {
  let router: ProviderRouter;
  let gpu: GPUMemoryManager;

  beforeEach(() => {
    gpu = new GPUMemoryManager({ fishSpeechResident: false });
    router = new ProviderRouter(mockConfig, gpu);
  });

  it('registers all 4 providers', () => {
    expect(router.getProvider('flux-klein')).toBeDefined();
    expect(router.getProvider('hunyuan-local')).toBeDefined();
    expect(router.getProvider('seedance-remote')).toBeDefined();
    expect(router.getProvider('realesrgan')).toBeDefined();
  });

  it('routes text-to-image to flux-klein when available', async () => {
    // Mock flux-klein as available
    const flux = router.getProvider('flux-klein')!;
    vi.spyOn(flux, 'isAvailable').mockResolvedValue(true);
    vi.spyOn(gpu, 'ensureLoaded').mockResolvedValue();

    const req: GenerateRequest = { type: 'text-to-image', prompt: 'a nebula' };
    const provider = await router.route(req);

    expect(provider.name).toBe('flux-klein');
    expect(gpu.ensureLoaded).toHaveBeenCalledWith('flux-klein');
  });

  it('routes upscale to realesrgan', async () => {
    vi.spyOn(gpu, 'ensureLoaded').mockResolvedValue();

    const req: GenerateRequest = {
      type: 'upscale',
      prompt: '',
      source_image_url: '/tmp/img.png',
      upscale_factor: 2,
    };
    const provider = await router.route(req);

    expect(provider.name).toBe('realesrgan');
    expect(gpu.ensureLoaded).toHaveBeenCalledWith('realesrgan');
  });

  it('routes image-to-video normal priority to hunyuan-local', async () => {
    const hunyuan = router.getProvider('hunyuan-local')!;
    vi.spyOn(hunyuan, 'isAvailable').mockResolvedValue(true);
    vi.spyOn(gpu, 'ensureLoaded').mockResolvedValue();

    const req: GenerateRequest = {
      type: 'image-to-video',
      prompt: 'slow pan',
      visual_priority: 'normal',
      source_image_url: '/tmp/img.png',
    };
    const provider = await router.route(req);

    expect(provider.name).toBe('hunyuan-local');
    expect(gpu.ensureLoaded).toHaveBeenCalledWith('hunyuan');
  });

  it('routes image-to-video high priority to seedance-remote', async () => {
    const seedance = router.getProvider('seedance-remote')!;
    vi.spyOn(seedance, 'isAvailable').mockResolvedValue(true);
    vi.spyOn(gpu, 'ensureLoaded').mockResolvedValue();

    const req: GenerateRequest = {
      type: 'image-to-video',
      prompt: 'dramatic zoom',
      visual_priority: 'high',
      source_image_url: '/tmp/img.png',
    };
    const provider = await router.route(req);

    expect(provider.name).toBe('seedance-remote');
    // Remote provider should NOT call GPU ensureLoaded
    expect(gpu.ensureLoaded).not.toHaveBeenCalled();
  });

  it('falls back to seedance when hunyuan is unavailable for normal video', async () => {
    const hunyuan = router.getProvider('hunyuan-local')!;
    vi.spyOn(hunyuan, 'isAvailable').mockResolvedValue(false);
    vi.spyOn(gpu, 'ensureLoaded').mockResolvedValue();

    const req: GenerateRequest = {
      type: 'image-to-video',
      prompt: 'slow pan',
      visual_priority: 'normal',
      source_image_url: '/tmp/img.png',
    };
    const provider = await router.route(req);

    expect(provider.name).toBe('seedance-remote');
  });

  it('falls back to hunyuan when seedance unavailable for high priority', async () => {
    const seedance = router.getProvider('seedance-remote')!;
    const hunyuan = router.getProvider('hunyuan-local')!;
    vi.spyOn(seedance, 'isAvailable').mockResolvedValue(false);
    vi.spyOn(hunyuan, 'isAvailable').mockResolvedValue(true);
    vi.spyOn(gpu, 'ensureLoaded').mockResolvedValue();

    const req: GenerateRequest = {
      type: 'image-to-video',
      prompt: 'dramatic',
      visual_priority: 'high',
      source_image_url: '/tmp/img.png',
    };
    const provider = await router.route(req);

    expect(provider.name).toBe('hunyuan-local');
  });

  it('throws when no image provider is available', async () => {
    const flux = router.getProvider('flux-klein')!;
    vi.spyOn(flux, 'isAvailable').mockResolvedValue(false);

    const req: GenerateRequest = { type: 'text-to-image', prompt: 'test' };
    await expect(router.route(req)).rejects.toThrow('No image provider available');
  });

  it('healthCheck returns all providers status', async () => {
    const flux = router.getProvider('flux-klein')!;
    const hunyuan = router.getProvider('hunyuan-local')!;
    const seedance = router.getProvider('seedance-remote')!;
    const esrgan = router.getProvider('realesrgan')!;

    vi.spyOn(flux, 'isAvailable').mockResolvedValue(true);
    vi.spyOn(hunyuan, 'isAvailable').mockResolvedValue(false);
    vi.spyOn(seedance, 'isAvailable').mockResolvedValue(true);
    vi.spyOn(esrgan, 'isAvailable').mockResolvedValue(false);

    const result = await router.healthCheck();

    expect(result['flux-klein']).toBe(true);
    expect(result['hunyuan-local']).toBe(false);
    expect(result['seedance-remote']).toBe(true);
    expect(result['realesrgan']).toBe(false);
  });

  it('dispose calls dispose on providers that support it', () => {
    const flux = router.getProvider('flux-klein')! as any;
    const disposeSpy = vi.spyOn(flux, 'dispose').mockImplementation(() => {});

    router.dispose();

    expect(disposeSpy).toHaveBeenCalled();
  });
});
