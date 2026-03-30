/**
 * VisualCore — HTTP API Tests
 *
 * Tests Fastify endpoints via inject (no actual server listen):
 *   - GET / — liveness
 *   - GET /health — provider health
 *   - GET /status — GPU + queue status
 *   - POST /create/v1/generate — validation + direct mode
 *   - GET /create/v1/generate/:id — queue not available
 *   - POST /create/v1/generate/batch — queue not available
 *   - Auth middleware
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from '../src/server.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

beforeAll(async () => {
  app = await createServer({ testing: true });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('Health endpoints', () => {
  it('GET / returns liveness', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.name).toBe('visualcore');
    expect(body.version).toBe('1.0.0');
    expect(body.status).toBe('ok');
  });

  it('GET /health returns provider statuses', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body).toHaveProperty('status');
    expect(body).toHaveProperty('providers');
    expect(body.providers).toHaveProperty('flux-klein');
    expect(body.providers).toHaveProperty('hunyuan-local');
    expect(body.providers).toHaveProperty('seedance-remote');
    expect(body.providers).toHaveProperty('realesrgan');
  });

  it('GET /status returns GPU and queue info', async () => {
    const res = await app.inject({ method: 'GET', url: '/status' });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.gpu).toHaveProperty('current_model');
    expect(body.gpu).toHaveProperty('vram_used_gb');
    expect(body.gpu).toHaveProperty('vram_actual_gb');
    expect(body.gpu).toHaveProperty('vram_total_gb');
    expect(body.gpu.vram_total_gb).toBe(24);
    expect(body.queue).toEqual({ waiting: 0, active: 0, completed: 0, failed: 0 });
  });
});

describe('POST /create/v1/generate — validation', () => {
  it('rejects missing body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/create/v1/generate',
      headers: { 'content-type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().success).toBe(false);
  });

  it('rejects invalid type', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/create/v1/generate',
      payload: { type: 'invalid', prompt: 'test' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('type is required');
  });

  it('rejects text-to-image without prompt', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/create/v1/generate',
      payload: { type: 'text-to-image' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('prompt is required');
  });

  it('rejects image-to-video without source_image_url', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/create/v1/generate',
      payload: { type: 'image-to-video', prompt: 'zoom in' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('source_image_url is required');
  });

  it('rejects upscale without source_image_url', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/create/v1/generate',
      payload: { type: 'upscale', prompt: '' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('source_image_url is required');
  });
});

describe('POST /create/v1/generate — direct mode (no queue)', () => {
  it('attempts direct generation for valid T2I request', async () => {
    // ComfyUI is not running → will fail with provider error
    const res = await app.inject({
      method: 'POST',
      url: '/create/v1/generate',
      payload: { type: 'text-to-image', prompt: 'a nebula in deep space' },
    });

    // Should fail because ComfyUI is not available, but returns 500 not 400
    expect(res.statusCode).toBe(500);
    expect(res.json().success).toBe(false);
    expect(res.json().message).toContain('No image provider available');
  });
});

describe('GET /create/v1/generate/:id — no queue', () => {
  it('returns 503 when queue not configured', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/create/v1/generate/nonexistent-id',
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().message).toContain('Queue not available');
  });
});

describe('POST /create/v1/generate/batch — no queue', () => {
  it('returns 503 when queue not configured', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/create/v1/generate/batch',
      payload: {
        items: [{ request: { type: 'text-to-image', prompt: 'test' } }],
      },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().message).toContain('Queue not available');
  });

  it('rejects empty items array', async () => {
    // Need queue for batch validation to reach the queue check
    const res = await app.inject({
      method: 'POST',
      url: '/create/v1/generate/batch',
      payload: { items: [] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('items array is required');
  });
});

describe('Auth middleware', () => {
  it('passes when auth is disabled (default in test)', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
  });
});
