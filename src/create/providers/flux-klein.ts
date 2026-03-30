/**
 * VisualCore — Flux Klein Local Provider
 *
 * Generates images via ComfyUI running Flux.2 Klein 4B locally.
 * Uses a persistent WebSocket connection with auto-reconnect for
 * prompt queuing and completion events.
 *
 * Key specs:
 *   - Model: Flux.2 Klein 4B (Apache 2.0)
 *   - VRAM: ~8GB
 *   - Speed: <1 second per image on RTX 4090
 *   - Steps: 4–8 (distilled model)
 */

import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  type GenerateProvider,
  type GenerateRequest,
  type GenerateResponse,
  type ProviderName,
  type Dimensions,
  resolveDimensions,
} from '@gstack/types';
import { logger } from '../../config/logger.js';

interface ComfyUIConfig {
  host: string;
  port: number;
  protocol: 'ws' | 'wss';
}

interface ComfyUIPromptResponse {
  prompt_id: string;
}

interface ComfyUIHistoryEntry {
  outputs: Record<string, { images?: Array<{ filename: string; subfolder: string }> }>;
}

/** Pending prompt waiting for WS completion event. */
interface PendingPrompt {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ── Reconnect Config ──
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
const CONNECT_TIMEOUT_MS = 10_000;

export class FluxKleinProvider extends EventEmitter implements GenerateProvider {
  readonly name: ProviderName = 'flux-klein';

  private config: ComfyUIConfig;
  private loraPresets: Record<string, string>;
  private clientId: string;
  private baseUrl: string;

  // ── Persistent WebSocket ──
  private ws: WebSocket | null = null;
  private pendingPrompts: Map<string, PendingPrompt> = new Map();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private disposed = false;

  /** Resolvers waiting for the WS to become OPEN. */
  private connectionWaiters: Array<{
    resolve: (ws: WebSocket) => void;
    reject: (err: Error) => void;
  }> = [];
  private connecting = false;

  constructor(config: ComfyUIConfig, loraPresets: Record<string, string> = {}) {
    super();
    this.config = config;
    this.loraPresets = loraPresets;
    this.clientId = randomUUID();
    this.baseUrl = `http://${config.host}:${config.port}`;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/system_stats`, {
        signal: AbortSignal.timeout(3000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async generate(req: GenerateRequest): Promise<GenerateResponse> {
    const startTime = Date.now();
    const id = randomUUID();

    try {
      const dims = resolveDimensions(req.aspect_ratio ?? '16:9', req.resolution ?? 'hd');
      const workflow = this.buildWorkflow(req, dims);
      const promptId = await this.queuePrompt(workflow);
      logger.info('ComfyUI prompt queued', { id, promptId });

      await this.waitForCompletion(promptId);

      const output = await this.fetchOutput(promptId, dims);
      const gpuTimeMs = Date.now() - startTime;

      return {
        id,
        status: 'done',
        provider: this.name,
        output: {
          url: output.url,
          width: output.width,
          height: output.height,
          format: 'png',
        },
        cost: 0,
        gpu_time_ms: gpuTimeMs,
        created_at: new Date(startTime).toISOString(),
        completed_at: new Date().toISOString(),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Flux Klein generation failed', { id, error: message });

      return {
        id,
        status: 'failed',
        provider: this.name,
        cost: 0,
        error: message,
        created_at: new Date(startTime).toISOString(),
      };
    }
  }

  // ─── Workflow Builder ───

  private buildWorkflow(req: GenerateRequest, dims: Dimensions): object {
    const seed = req.seed != null && req.seed >= 0 ? req.seed : Math.floor(Math.random() * 2 ** 32);
    const lora = req.style ? this.loraPresets[req.style] : undefined;
    const isThumb = req.is_thumbnail;

    const NODE_CKPT = '1';
    const NODE_CLIP_POS = '2';
    const NODE_CLIP_NEG = '3';
    const NODE_LATENT = '4';
    const NODE_SAMPLER = '5';
    const NODE_DECODE = '6';
    const NODE_SAVE = '7';
    const NODE_LORA = '8';

    const modelSource: [string, number] = lora ? [NODE_LORA, 0] : [NODE_CKPT, 0];
    const clipSource: [string, number] = lora ? [NODE_LORA, 1] : [NODE_CKPT, 1];

    const prompt: Record<string, object> = {
      [NODE_CKPT]: {
        class_type: 'CheckpointLoaderSimple',
        inputs: { ckpt_name: 'flux2-klein-4b.safetensors' },
      },
      [NODE_CLIP_POS]: {
        class_type: 'CLIPTextEncode',
        inputs: { text: req.prompt, clip: clipSource },
      },
      [NODE_CLIP_NEG]: {
        class_type: 'CLIPTextEncode',
        inputs: {
          text: req.negative_prompt || 'ugly, blurry, low quality, watermark, text, signature',
          clip: clipSource,
        },
      },
      [NODE_LATENT]: {
        class_type: 'EmptyLatentImage',
        inputs: { width: dims.width, height: dims.height, batch_size: 1 },
      },
      [NODE_SAMPLER]: {
        class_type: 'KSampler',
        inputs: {
          model: modelSource,
          positive: [NODE_CLIP_POS, 0],
          negative: [NODE_CLIP_NEG, 0],
          latent_image: [NODE_LATENT, 0],
          seed,
          steps: 8,
          cfg: 3.5,
          sampler_name: 'euler',
          scheduler: 'normal',
          denoise: 1.0,
        },
      },
      [NODE_DECODE]: {
        class_type: 'VAEDecode',
        inputs: { samples: [NODE_SAMPLER, 0], vae: [NODE_CKPT, 2] },
      },
      [NODE_SAVE]: {
        class_type: 'SaveImage',
        inputs: {
          images: [NODE_DECODE, 0],
          filename_prefix: `rf_${isThumb ? 'thumb' : 'img'}`,
        },
      },
    };

    if (lora) {
      const loraName = isThumb ? 'text_rendering_v1.safetensors' : lora;
      prompt[NODE_LORA] = {
        class_type: 'LoraLoader',
        inputs: {
          model: [NODE_CKPT, 0],
          clip: [NODE_CKPT, 1],
          lora_name: loraName,
          strength_model: isThumb ? 0.9 : 0.8,
          strength_clip: isThumb ? 0.9 : 0.8,
        },
      };
    }

    return { prompt, client_id: this.clientId };
  }

  // ─── ComfyUI HTTP ───

  private async queuePrompt(workflow: object): Promise<string> {
    const res = await fetch(`${this.baseUrl}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(workflow),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`ComfyUI prompt queue failed (${res.status}): ${text}`);
    }

    const data = (await res.json()) as ComfyUIPromptResponse;
    return data.prompt_id;
  }

  // ─── Persistent WebSocket with Auto-Reconnect ───

  /**
   * Get or create a persistent WS connection to ComfyUI.
   *
   * - If already connected (OPEN), returns immediately.
   * - If a connection attempt is in progress, waits for its result.
   * - Otherwise opens a new connection.
   * - On unexpected close, schedules auto-reconnect with exponential backoff.
   */
  private ensureConnection(): Promise<WebSocket> {
    // Already open
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return Promise.resolve(this.ws);
    }

    // Connection in progress — queue a waiter
    if (this.connecting) {
      return new Promise<WebSocket>((resolve, reject) => {
        this.connectionWaiters.push({ resolve, reject });
      });
    }

    // New connection
    return this.connect();
  }

  private connect(): Promise<WebSocket> {
    if (this.disposed) {
      return Promise.reject(new Error('Provider disposed'));
    }

    this.connecting = true;

    return new Promise<WebSocket>((resolve, reject) => {
      // Include this as the first waiter so all share the same outcome
      this.connectionWaiters.push({ resolve, reject });

      const wsUrl = `${this.config.protocol}://${this.config.host}:${this.config.port}/ws?clientId=${this.clientId}`;
      const ws = new WebSocket(wsUrl);

      const timeout = setTimeout(() => {
        ws.close();
        this.settleWaiters(new Error('WebSocket connection timeout'));
      }, CONNECT_TIMEOUT_MS);

      ws.on('open', () => {
        clearTimeout(timeout);
        this.ws = ws;
        this.connecting = false;
        this.reconnectAttempt = 0;
        logger.info('ComfyUI WebSocket connected');
        this.settleWaiters(null, ws);
      });

      ws.on('message', (data: Buffer) => {
        this.handleMessage(data);
      });

      ws.on('close', (code, reason) => {
        const wasOpen = this.ws === ws;
        this.ws = null;

        if (wasOpen) {
          logger.warn('ComfyUI WebSocket closed', {
            code,
            reason: reason?.toString(),
            pending: this.pendingPrompts.size,
          });

          // Reject all pending prompts — the generation will be retried by QC pipeline
          this.rejectAllPending(new Error(`WebSocket closed (code=${code})`));

          // Schedule auto-reconnect (unless we're shutting down)
          if (!this.disposed) {
            this.scheduleReconnect();
          }
        }
      });

      ws.on('error', (err) => {
        logger.error('ComfyUI WebSocket error', { error: err.message });

        // If still connecting, settle waiters with the error
        if (this.connecting) {
          clearTimeout(timeout);
          this.settleWaiters(err);
        }
      });
    });
  }

  /** Resolve or reject all connection waiters and clear the list. */
  private settleWaiters(err: Error | null, ws?: WebSocket): void {
    this.connecting = false;
    const waiters = this.connectionWaiters.splice(0);
    for (const w of waiters) {
      if (err) {
        w.reject(err);
      } else {
        w.resolve(ws!);
      }
    }
  }

  /** Reject all pending prompt promises. */
  private rejectAllPending(err: Error): void {
    for (const [, pending] of this.pendingPrompts) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pendingPrompts.clear();
  }

  /**
   * Schedule a reconnect with exponential backoff.
   * Capped at RECONNECT_MAX_MS.
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.disposed) return;

    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempt),
      RECONNECT_MAX_MS,
    );
    this.reconnectAttempt++;

    logger.info('Scheduling WS reconnect', { attempt: this.reconnectAttempt, delay_ms: delay });

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.disposed) return;

      try {
        await this.connect();
        logger.info('ComfyUI WebSocket reconnected');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn('WS reconnect failed', { attempt: this.reconnectAttempt, error: msg });
        // connect() failure triggers close → scheduleReconnect again
      }
    }, delay);
  }

  // ─── WS Message Handling ───

  private handleMessage(data: Buffer): void {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === 'executed' && msg.data?.prompt_id) {
        const pending = this.pendingPrompts.get(msg.data.prompt_id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingPrompts.delete(msg.data.prompt_id);
          pending.resolve();
        }
      }

      if (msg.type === 'execution_error' && msg.data?.prompt_id) {
        const pending = this.pendingPrompts.get(msg.data.prompt_id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingPrompts.delete(msg.data.prompt_id);
          pending.reject(new Error(`ComfyUI execution error: ${JSON.stringify(msg.data)}`));
        }
      }

      // Emit progress events for monitoring
      if (msg.type === 'progress' && msg.data) {
        this.emit('progress', {
          prompt_id: msg.data.prompt_id,
          value: msg.data.value,
          max: msg.data.max,
        });
      }
    } catch {
      // Ignore non-JSON messages (binary progress data)
    }
  }

  /**
   * Wait for a specific prompt to complete via the persistent WebSocket.
   * The connection is established lazily on first call and kept alive.
   */
  private async waitForCompletion(promptId: string, timeoutMs = 60_000): Promise<void> {
    await this.ensureConnection();

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingPrompts.delete(promptId);
        reject(new Error(`ComfyUI generation timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingPrompts.set(promptId, { resolve, reject, timer });
    });
  }

  // ─── Output Fetching ───

  private async fetchOutput(
    promptId: string,
    dims: Dimensions,
  ): Promise<{ url: string; width: number; height: number }> {
    const res = await fetch(`${this.baseUrl}/history/${promptId}`);

    if (!res.ok) {
      throw new Error(`Failed to fetch ComfyUI history: ${res.status}`);
    }

    const history = (await res.json()) as Record<string, ComfyUIHistoryEntry>;
    const entry = history[promptId];

    if (!entry) {
      throw new Error(`No history entry for prompt ${promptId}`);
    }

    for (const nodeOutput of Object.values(entry.outputs)) {
      if (nodeOutput.images && nodeOutput.images.length > 0) {
        const img = nodeOutput.images[0];
        const imageUrl = `${this.baseUrl}/view?filename=${img.filename}&subfolder=${img.subfolder}&type=output`;
        return { url: imageUrl, width: dims.width, height: dims.height };
      }
    }

    throw new Error(`No output images found for prompt ${promptId}`);
  }

  // ─── Lifecycle ───

  /**
   * Close the persistent WebSocket and cancel all pending work.
   * Call this during server shutdown.
   */
  dispose(): void {
    this.disposed = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.settleWaiters(new Error('Provider disposed'));
    this.rejectAllPending(new Error('Provider disposed'));

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    logger.info('FluxKleinProvider disposed');
  }
}
