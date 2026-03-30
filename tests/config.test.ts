/**
 * VisualCore — Config Parser Tests
 *
 * Tests environment variable parsing and default values.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('Config parser', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore env
    process.env = { ...originalEnv };
    // Clear module cache so config re-reads env
    vi.resetModules();
  });

  it('uses default values when no env vars set', async () => {
    // Clear relevant env vars
    delete process.env.PORT;
    delete process.env.REDIS_URL;
    delete process.env.AUTH_ENABLED;
    delete process.env.COMFYUI_HOST;

    const { config } = await import('../src/config/index.js');

    expect(config.port).toBe(3100);
    expect(config.host).toBe('0.0.0.0');
    expect(config.redisUrl).toBe('');
    expect(config.auth.enabled).toBe(false);
    expect(config.visualCore.comfyui.host).toBe('localhost');
    expect(config.visualCore.comfyui.port).toBe(8188);
    expect(config.visualCore.hunyuan.default_steps).toBe(8);
    expect(config.visualCore.qc.clip_threshold).toBe(0.25);
    expect(config.visualCore.gpu.vram_total_gb).toBe(24);
  });

  it('parses env vars correctly', async () => {
    process.env.PORT = '4000';
    process.env.REDIS_URL = 'redis://myredis:6379';
    process.env.AUTH_ENABLED = 'true';
    process.env.API_KEYS = 'key1,key2,key3';
    process.env.COMFYUI_HOST = 'gpu-server';
    process.env.COMFYUI_PORT = '9999';
    process.env.QC_CLIP_THRESHOLD = '0.30';
    process.env.GPU_VRAM_TOTAL_GB = '48';
    process.env.GPU_FISH_SPEECH_RESIDENT = 'false';

    const { config } = await import('../src/config/index.js');

    expect(config.port).toBe(4000);
    expect(config.redisUrl).toBe('redis://myredis:6379');
    expect(config.auth.enabled).toBe(true);
    expect(config.auth.apiKeys).toEqual(['key1', 'key2', 'key3']);
    expect(config.visualCore.comfyui.host).toBe('gpu-server');
    expect(config.visualCore.comfyui.port).toBe(9999);
    expect(config.visualCore.qc.clip_threshold).toBe(0.30);
    expect(config.visualCore.gpu.vram_total_gb).toBe(48);
    expect(config.visualCore.gpu.fish_speech_resident).toBe(false);
  });

  it('parses LoRA presets from LORA_* env vars', async () => {
    process.env.LORA_T1_SPACE = 'space_v2.safetensors';
    process.env.LORA_T7_CRIME = 'crime_dark.safetensors';
    process.env.LORA_THUMBNAIL = 'text_v1.safetensors';

    const { config } = await import('../src/config/index.js');

    expect(config.visualCore.lora_presets.t1_space).toBe('space_v2.safetensors');
    expect(config.visualCore.lora_presets.t7_crime).toBe('crime_dark.safetensors');
    expect(config.visualCore.lora_presets.thumbnail).toBe('text_v1.safetensors');
  });

  it('handles empty API_KEYS gracefully', async () => {
    process.env.API_KEYS = '';

    const { config } = await import('../src/config/index.js');

    expect(config.auth.apiKeys).toEqual([]);
  });

  it('parses boolean values correctly', async () => {
    process.env.AUTH_ENABLED = '1';
    process.env.QC_FALLBACK_TO_API = 'false';

    const { config } = await import('../src/config/index.js');

    expect(config.auth.enabled).toBe(true);
    expect(config.visualCore.qc.fallback_to_api).toBe(false);
  });
});
