/**
 * VisualCore — QC Pipeline Tests
 *
 * Tests the retry + fallback logic with mocked providers:
 *   - Pass on first attempt
 *   - Retry with seed variation on QC failure
 *   - Fallback to API after max retries
 *   - No fallback configured → return failed
 *   - Upscale skips QC
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QCPipeline } from '../src/create/qc/pipeline.js';
import type { GenerateProvider, GenerateRequest, GenerateResponse } from '@gstack/types';

// ─── Mock Provider Factory ───

function createMockProvider(
  name: string,
  results: GenerateResponse[],
): GenerateProvider {
  let callIndex = 0;
  return {
    name: name as any,
    isAvailable: vi.fn().mockResolvedValue(true),
    generate: vi.fn().mockImplementation(async () => {
      const result = results[callIndex] ?? results[results.length - 1];
      callIndex++;
      return result;
    }),
  };
}

function makeResponse(overrides: Partial<GenerateResponse> = {}): GenerateResponse {
  return {
    id: 'test-id',
    status: 'done',
    provider: 'flux-klein',
    cost: 0,
    created_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    output: {
      url: '/tmp/test-output.png',
      width: 768,
      height: 432,
      format: 'png',
    },
    ...overrides,
  };
}

// ─── QC Config ───

const qcConfig = {
  clip_threshold: 0.25,
  aesthetic_threshold: 5.0,
  nsfw_threshold: 0.3,
  temporal_threshold: 0.8,
  max_retries: 3,
  fallback_to_api: true,
};

describe('QCPipeline', () => {
  let pipeline: QCPipeline;

  beforeEach(() => {
    pipeline = new QCPipeline(qcConfig);
  });

  it('returns result directly when generation succeeds (QC scoring is external)', async () => {
    const provider = createMockProvider('flux-klein', [makeResponse()]);

    // QC scoring requires external Python — in test it will fall back to basic checks
    // which auto-pass for images with valid output URL
    const req: GenerateRequest = { type: 'text-to-image', prompt: 'a nebula' };
    const result = await pipeline.generateWithQC(req, provider);

    expect(result.status).toBe('done');
    expect(provider.generate).toHaveBeenCalledTimes(1);
  });

  it('retries when generation fails', async () => {
    const failedResponse = makeResponse({ status: 'failed', error: 'GPU error', output: undefined });
    const successResponse = makeResponse();

    const provider = createMockProvider('flux-klein', [
      failedResponse,
      failedResponse,
      successResponse,
    ]);

    const req: GenerateRequest = { type: 'text-to-image', prompt: 'test' };
    const result = await pipeline.generateWithQC(req, provider);

    expect(result.status).toBe('done');
    expect(provider.generate).toHaveBeenCalledTimes(3);
  });

  it('falls back to API provider after max retries exhausted', async () => {
    const failedResponse = makeResponse({ status: 'failed', error: 'fail', output: undefined });
    const fallbackResponse = makeResponse({ provider: 'seedance-remote', cost: 0.11 });

    const localProvider = createMockProvider('flux-klein', [
      failedResponse, failedResponse, failedResponse,
    ]);
    const fallbackProvider = createMockProvider('seedance-remote', [fallbackResponse]);

    const req: GenerateRequest = { type: 'text-to-image', prompt: 'test' };
    const result = await pipeline.generateWithQC(req, localProvider, fallbackProvider);

    expect(localProvider.generate).toHaveBeenCalledTimes(3);
    expect(fallbackProvider.generate).toHaveBeenCalledTimes(1);
    expect(result.provider).toBe('seedance-remote');
    expect(result.qc?.issues).toContain('Fallback to external API after QC retries exhausted');
  });

  it('returns failed when retries exhausted and no fallback configured', async () => {
    const noFallbackPipeline = new QCPipeline({ ...qcConfig, fallback_to_api: false });
    const failedResponse = makeResponse({ status: 'failed', error: 'fail', output: undefined });

    const provider = createMockProvider('flux-klein', [
      failedResponse, failedResponse, failedResponse,
    ]);

    const req: GenerateRequest = { type: 'text-to-image', prompt: 'test' };
    const result = await noFallbackPipeline.generateWithQC(req, provider);

    expect(result.status).toBe('failed');
    expect(result.error).toContain('QC failed after 3 attempts');
  });

  it('skips QC for upscale type', async () => {
    const provider = createMockProvider('realesrgan', [makeResponse({ provider: 'realesrgan' })]);

    const req: GenerateRequest = {
      type: 'upscale',
      prompt: '',
      source_image_url: '/tmp/video.mp4',
      upscale_factor: 2,
    };
    const result = await pipeline.generateWithQC(req, provider);

    expect(result.status).toBe('done');
    expect(provider.generate).toHaveBeenCalledTimes(1);
    // QC result for upscale should auto-pass
    expect(result.qc?.pass).toBe(true);
  });

  it('varies seed on each retry attempt', async () => {
    const failedResponse = makeResponse({ status: 'failed', error: 'fail', output: undefined });
    const successResponse = makeResponse();

    const provider = createMockProvider('flux-klein', [
      failedResponse, failedResponse, successResponse,
    ]);

    const req: GenerateRequest = { type: 'text-to-image', prompt: 'test', seed: 42 };
    await pipeline.generateWithQC(req, provider);

    const calls = (provider.generate as any).mock.calls;
    expect(calls[0][0].seed).toBe(42);       // attempt 1: seed + 0
    expect(calls[1][0].seed).toBe(43);       // attempt 2: seed + 1
    expect(calls[2][0].seed).toBe(44);       // attempt 3: seed + 2
  });

  it('handles response with no output URL', async () => {
    const noUrlResponse = makeResponse({ output: undefined });
    const successResponse = makeResponse();

    const provider = createMockProvider('flux-klein', [noUrlResponse, successResponse]);

    const req: GenerateRequest = { type: 'text-to-image', prompt: 'test' };
    const result = await pipeline.generateWithQC(req, provider);

    expect(result.status).toBe('done');
    expect(provider.generate).toHaveBeenCalledTimes(2);
  });
});
