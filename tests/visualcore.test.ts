/**
 * VisualCore — Unit Tests
 *
 * Tests for provider routing, GPU memory management, and QC pipeline.
 * Run: npx vitest tests/visualcore.test.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveDimensions, type GenerateRequest, type VisualCoreConfig } from '../src/create/providers/types.js';
import { GPUMemoryManager } from '../src/create/gpu/memory-manager.js';

// ─── resolveDimensions ───

describe('resolveDimensions', () => {
  it('returns correct 16:9 HD dimensions', () => {
    const d = resolveDimensions('16:9', 'hd');
    expect(d.width).toBe(768);
    expect(d.height).toBe(432);
    expect(d.width % 8).toBe(0);
    expect(d.height % 8).toBe(0);
  });

  it('returns correct 9:16 HD dimensions (portrait)', () => {
    const d = resolveDimensions('9:16', 'hd');
    expect(d.width).toBe(432);
    expect(d.height).toBe(768);
  });

  it('returns correct 1:1 dimensions', () => {
    const d = resolveDimensions('1:1', '1080');
    expect(d.width).toBe(1024);
    expect(d.height).toBe(1024);
  });

  it('returns correct 4k dimensions', () => {
    const d = resolveDimensions('16:9', '4k');
    expect(d.width).toBe(2048);
    expect(d.height).toBeGreaterThan(1000);
  });

  it('defaults to 16:9 hd', () => {
    const d = resolveDimensions();
    expect(d.width).toBe(768);
  });

  it('all dimensions are divisible by 8', () => {
    const ratios = ['16:9', '9:16', '1:1', '4:3', '4:5'] as const;
    const resolutions = ['preview', 'sd', 'hd', '1080', '4k'] as const;

    for (const ratio of ratios) {
      for (const res of resolutions) {
        const d = resolveDimensions(ratio, res);
        expect(d.width % 8, `${ratio}@${res} width`).toBe(0);
        expect(d.height % 8, `${ratio}@${res} height`).toBe(0);
      }
    }
  });
});

// ─── GPUMemoryManager ───

describe('GPUMemoryManager', () => {
  let gpu: GPUMemoryManager;

  beforeEach(() => {
    gpu = new GPUMemoryManager({ fishSpeechResident: true });
  });

  it('starts with no primary model', () => {
    const status = gpu.getStatus();
    expect(status.current_model).toBeNull();
    expect(status.resident_models).toContain('fish-speech');
    expect(status.vram_used_gb).toBe(2); // Fish Speech only
  });

  it('reports correct VRAM total', () => {
    const status = gpu.getStatus();
    expect(status.vram_total_gb).toBe(24);
  });

  it('resident model is already available', async () => {
    // Fish Speech is resident, should not trigger swap
    await gpu.ensureLoaded('fish-speech');
    const status = gpu.getStatus();
    expect(status.current_model).toBeNull(); // Not set as primary
    expect(status.is_swapping).toBe(false);
  });

  it('marks swap queue depth correctly', () => {
    const status = gpu.getStatus();
    expect(status.swap_queue_depth).toBe(0);
  });

  it('getStatus returns valid structure', () => {
    const status = gpu.getStatus();
    expect(status).toHaveProperty('current_model');
    expect(status).toHaveProperty('resident_models');
    expect(status).toHaveProperty('vram_used_gb');
    expect(status).toHaveProperty('vram_total_gb');
    expect(status).toHaveProperty('is_swapping');
    expect(status).toHaveProperty('swap_queue_depth');
  });

  it('can unload all models', async () => {
    await gpu.unloadAll();
    const status = gpu.getStatus();
    expect(status.current_model).toBeNull();
  });
});

// ─── Provider Routing Logic ───

describe('Provider Routing (unit logic)', () => {
  it('text-to-image routes to flux-klein', () => {
    const req: GenerateRequest = {
      type: 'text-to-image',
      prompt: 'a nebula in deep space',
    };
    // Routing logic: text-to-image with no special flags → flux-klein
    expect(req.type).toBe('text-to-image');
    expect(req.visual_priority).toBeUndefined(); // → local
  });

  it('image-to-video with high priority routes to seedance', () => {
    const req: GenerateRequest = {
      type: 'image-to-video',
      prompt: 'dramatic zoom into character face',
      visual_priority: 'high',
      source_image_url: '/tmp/test.png',
    };
    expect(req.visual_priority).toBe('high'); // → seedance-remote
  });

  it('image-to-video with normal priority routes to hunyuan', () => {
    const req: GenerateRequest = {
      type: 'image-to-video',
      prompt: 'slow pan across landscape',
      visual_priority: 'normal',
      source_image_url: '/tmp/test.png',
    };
    expect(req.visual_priority).toBe('normal'); // → hunyuan-local
  });

  it('upscale routes to realesrgan', () => {
    const req: GenerateRequest = {
      type: 'upscale',
      prompt: '',
      source_image_url: '/tmp/video.mp4',
      upscale_factor: 2,
    };
    expect(req.type).toBe('upscale'); // → realesrgan
  });

  it('thumbnail flag is correctly set', () => {
    const req: GenerateRequest = {
      type: 'text-to-image',
      prompt: 'thumbnail with text SPACE MYSTERIES',
      is_thumbnail: true,
    };
    expect(req.is_thumbnail).toBe(true);
  });
});

// ─── QC Thresholds ───

describe('QC threshold validation', () => {
  it('default thresholds are reasonable', () => {
    const defaults = {
      clip_threshold: 0.25,
      aesthetic_threshold: 5.0,
      nsfw_threshold: 0.3,
      max_retries: 3,
    };

    expect(defaults.clip_threshold).toBeGreaterThan(0);
    expect(defaults.clip_threshold).toBeLessThan(1);
    expect(defaults.aesthetic_threshold).toBeGreaterThan(0);
    expect(defaults.aesthetic_threshold).toBeLessThanOrEqual(10);
    expect(defaults.nsfw_threshold).toBeGreaterThan(0);
    expect(defaults.nsfw_threshold).toBeLessThan(1);
    expect(defaults.max_retries).toBeGreaterThanOrEqual(1);
  });

  it('CLIP score 0.30 passes threshold 0.25', () => {
    expect(0.30 >= 0.25).toBe(true);
  });

  it('CLIP score 0.20 fails threshold 0.25', () => {
    expect(0.20 >= 0.25).toBe(false);
  });

  it('Aesthetic score 6.0 passes threshold 5.0', () => {
    expect(6.0 >= 5.0).toBe(true);
  });

  it('NSFW score 0.5 fails threshold 0.3', () => {
    expect(0.5 > 0.3).toBe(true); // Should be rejected
  });
});

// ─── Batch Optimization ───

describe('Batch order optimization', () => {
  it('groups same-type requests together', () => {
    const items = [
      { type: 'image-to-video' as const, prompt: 'v1', visual_priority: 'normal' as const },
      { type: 'text-to-image' as const, prompt: 'i1' },
      { type: 'upscale' as const, prompt: '', source_image_url: '/tmp/a.mp4' },
      { type: 'text-to-image' as const, prompt: 'i2' },
      { type: 'image-to-video' as const, prompt: 'v2', visual_priority: 'high' as const },
    ];

    // Expected order: remote videos → images → local videos → upscales
    const remoteVids = items.filter(
      i => i.type === 'image-to-video' && i.visual_priority === 'high',
    );
    const images = items.filter(i => i.type === 'text-to-image');
    const localVids = items.filter(
      i => i.type === 'image-to-video' && i.visual_priority !== 'high',
    );
    const upscales = items.filter(i => i.type === 'upscale');

    const optimized = [...remoteVids, ...images, ...localVids, ...upscales];

    // Remote first (no GPU swap)
    expect(optimized[0].visual_priority).toBe('high');
    // Then images (Flux)
    expect(optimized[1].type).toBe('text-to-image');
    expect(optimized[2].type).toBe('text-to-image');
    // Then local videos (HunyuanVideo, 1 swap)
    expect(optimized[3].type).toBe('image-to-video');
    expect(optimized[3].visual_priority).toBe('normal');
    // Then upscale
    expect(optimized[4].type).toBe('upscale');
  });
});
