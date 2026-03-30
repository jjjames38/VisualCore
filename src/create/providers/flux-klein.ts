/**
 * VisualCore — Flux Klein Local Provider
 *
 * Generates images via ComfyUI running Flux.2 Klein 4B locally.
 * Communicates over WebSocket for prompt queuing and completion events.
 *
 * Key specs:
 *   - Model: Flux.2 Klein 4B (Apache 2.0)
 *   - VRAM: ~8GB
 *   - Speed: <1 second per image on RTX 4090
 *   - Steps: 4–8 (distilled model)
 */

import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  type GenerateProvider,
  type GenerateRequest,
  type GenerateResponse,
  type ProviderName,
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

export class FluxKleinProvider implements GenerateProvider {
  readonly name: ProviderName = 'flux-klein';

  private config: ComfyUIConfig;
  private loraPresets: Record<string, string>;
  private clientId: string;
  private baseUrl: string;

  constructor(config: ComfyUIConfig, loraPresets: Record<string, string> = {}) {
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
      // 1. Build ComfyUI workflow
      const workflow = this.buildWorkflow(req);

      // 2. Queue the prompt
      const promptId = await this.queuePrompt(workflow);
      logger.info('ComfyUI prompt queued', { id, promptId });

      // 3. Wait for completion via WebSocket
      await this.waitForCompletion(promptId);

      // 4. Fetch the output image
      const output = await this.fetchOutput(promptId);

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

  private buildWorkflow(req: GenerateRequest): object {
    const dims = resolveDimensions(req.aspect_ratio ?? '16:9', req.resolution ?? 'hd');
    const seed = req.seed != null && req.seed >= 0 ? req.seed : Math.floor(Math.random() * 2 ** 32);
    const lora = req.style ? this.loraPresets[req.style] : undefined;
    const isThumb = req.is_thumbnail;

    // Node IDs
    const NODE_CKPT = '1';
    const NODE_CLIP_POS = '2';
    const NODE_CLIP_NEG = '3';
    const NODE_LATENT = '4';
    const NODE_SAMPLER = '5';
    const NODE_DECODE = '6';
    const NODE_SAVE = '7';
    const NODE_LORA = '8';

    // Determine model source (with or without LoRA)
    const modelSource: [string, number] = lora ? [NODE_LORA, 0] : [NODE_CKPT, 0];
    const clipSource: [string, number] = lora ? [NODE_LORA, 1] : [NODE_CKPT, 1];

    const prompt: Record<string, object> = {
      [NODE_CKPT]: {
        class_type: 'CheckpointLoaderSimple',
        inputs: {
          ckpt_name: 'flux2-klein-4b.safetensors',
        },
      },
      [NODE_CLIP_POS]: {
        class_type: 'CLIPTextEncode',
        inputs: {
          text: req.prompt,
          clip: clipSource,
        },
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
        inputs: {
          width: dims.width,
          height: dims.height,
          batch_size: 1,
        },
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
        inputs: {
          samples: [NODE_SAMPLER, 0],
          vae: [NODE_CKPT, 2],
        },
      },
      [NODE_SAVE]: {
        class_type: 'SaveImage',
        inputs: {
          images: [NODE_DECODE, 0],
          filename_prefix: `rf_${isThumb ? 'thumb' : 'img'}`,
        },
      },
    };

    // Add LoRA loader if style specified
    if (lora) {
      // Thumbnail uses text-rendering LoRA
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

  // ─── ComfyUI Communication ───

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

  private waitForCompletion(promptId: string, timeoutMs = 60_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const wsUrl = `${this.config.protocol}://${this.config.host}:${this.config.port}/ws?clientId=${this.clientId}`;
      const ws = new WebSocket(wsUrl);
      let settled = false;

      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          ws.close();
          reject(new Error(`ComfyUI generation timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      ws.on('message', (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());

          if (msg.type === 'executed' && msg.data?.prompt_id === promptId) {
            if (!settled) {
              settled = true;
              clearTimeout(timeout);
              ws.close();
              resolve();
            }
          }

          if (msg.type === 'execution_error' && msg.data?.prompt_id === promptId) {
            if (!settled) {
              settled = true;
              clearTimeout(timeout);
              ws.close();
              reject(new Error(`ComfyUI execution error: ${JSON.stringify(msg.data)}`));
            }
          }
        } catch {
          // Ignore non-JSON messages (binary progress data)
        }
      });

      ws.on('error', (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(new Error(`ComfyUI WebSocket error: ${err.message}`));
        }
      });
    });
  }

  private async fetchOutput(promptId: string): Promise<{ url: string; width: number; height: number }> {
    const res = await fetch(`${this.baseUrl}/history/${promptId}`);

    if (!res.ok) {
      throw new Error(`Failed to fetch ComfyUI history: ${res.status}`);
    }

    const history = (await res.json()) as Record<string, ComfyUIHistoryEntry>;
    const entry = history[promptId];

    if (!entry) {
      throw new Error(`No history entry for prompt ${promptId}`);
    }

    // Find the SaveImage output node
    for (const nodeOutput of Object.values(entry.outputs)) {
      if (nodeOutput.images && nodeOutput.images.length > 0) {
        const img = nodeOutput.images[0];
        const imageUrl = `${this.baseUrl}/view?filename=${img.filename}&subfolder=${img.subfolder}&type=output`;
        // Note: actual width/height would be parsed from the image.
        // For now, return the requested dims (ComfyUI generates at exact requested resolution).
        return { url: imageUrl, width: 0, height: 0 };
      }
    }

    throw new Error(`No output images found for prompt ${promptId}`);
  }
}
