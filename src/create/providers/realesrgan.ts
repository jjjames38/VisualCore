/**
 * VisualCore — Real-ESRGAN Upscale Provider
 *
 * Upscales 480p video/images to 720p/1080p using Real-ESRGAN.
 * Uses realesrgan-ncnn-vulkan CLI for GPU-accelerated upscaling.
 */

import { randomUUID } from 'node:crypto';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import {
  type GenerateProvider,
  type GenerateRequest,
  type GenerateResponse,
  type ProviderName,
} from '@gstack/types';
import { logger } from '../../config/logger.js';

const execAsync = promisify(exec);

const REALESRGAN_BIN = process.env.REALESRGAN_BIN || 'realesrgan-ncnn-vulkan';

export class RealEsrganProvider implements GenerateProvider {
  readonly name: ProviderName = 'realesrgan';

  async isAvailable(): Promise<boolean> {
    try {
      await execAsync(`${REALESRGAN_BIN} -h`);
      return true;
    } catch {
      // Try python version
      try {
        await execAsync('python -c "import realesrgan"');
        return true;
      } catch {
        return false;
      }
    }
  }

  async generate(req: GenerateRequest): Promise<GenerateResponse> {
    const startTime = Date.now();
    const id = randomUUID();

    if (req.type !== 'upscale') {
      return {
        id,
        status: 'failed',
        provider: this.name,
        cost: 0,
        error: 'RealEsrganProvider only supports upscale type',
        created_at: new Date(startTime).toISOString(),
      };
    }

    if (!req.source_image_url) {
      return {
        id,
        status: 'failed',
        provider: this.name,
        cost: 0,
        error: 'source_image_url is required for upscale',
        created_at: new Date(startTime).toISOString(),
      };
    }

    try {
      const factor = req.upscale_factor ?? 2;
      const inputPath = req.source_image_url;
      const ext = path.extname(inputPath);
      const outputPath = inputPath.replace(ext, `_${factor}x${ext}`);

      // Detect if input is video or image
      const isVideo = ['.mp4', '.webm', '.mov', '.avi'].includes(ext.toLowerCase());

      if (isVideo) {
        await this.upscaleVideo(inputPath, outputPath, factor);
      } else {
        await this.upscaleImage(inputPath, outputPath, factor);
      }

      const gpuTimeMs = Date.now() - startTime;

      // Get output dimensions
      const dims = await this.getMediaDimensions(outputPath);

      logger.info('Upscale complete', {
        id,
        factor: `${factor}x`,
        elapsed_ms: gpuTimeMs,
        output: outputPath,
      });

      return {
        id,
        status: 'done',
        provider: this.name,
        output: {
          url: outputPath,
          width: dims.width,
          height: dims.height,
          duration: isVideo ? req.duration : undefined,
          format: isVideo ? 'mp4' : 'png',
        },
        cost: 0,
        gpu_time_ms: gpuTimeMs,
        created_at: new Date(startTime).toISOString(),
        completed_at: new Date().toISOString(),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Upscale failed', { id, error: message });

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

  private async upscaleImage(input: string, output: string, factor: number): Promise<void> {
    const model = factor >= 4 ? 'realesrgan-x4plus' : 'realesrgan-x4plus';
    const cmd = `${REALESRGAN_BIN} -i "${input}" -o "${output}" -s ${factor} -n ${model}`;

    logger.debug('Running Real-ESRGAN', { cmd });
    const { stderr } = await execAsync(cmd, { timeout: 600_000 });

    if (!existsSync(output)) {
      throw new Error(`Upscale output not found: ${output}. stderr: ${stderr}`);
    }
  }

  private async upscaleVideo(input: string, output: string, factor: number): Promise<void> {
    // For video: extract frames → upscale → reassemble
    // Using ffmpeg + realesrgan pipeline
    const tmpDir = `/tmp/upscale_${randomUUID()}`;

    try {
      // 1. Extract frames
      await execAsync(`mkdir -p ${tmpDir}/frames ${tmpDir}/upscaled`);
      await execAsync(`ffmpeg -i "${input}" -qscale:v 2 "${tmpDir}/frames/frame_%06d.png"`, {
        timeout: 120_000,
      });

      // 2. Upscale all frames
      await execAsync(
        `${REALESRGAN_BIN} -i "${tmpDir}/frames" -o "${tmpDir}/upscaled" -s ${factor} -n realesrgan-x4plus-anime -f png`,
        { timeout: 600_000 },
      );

      // 3. Get original framerate
      const { stdout: probeOut } = await execAsync(
        `ffprobe -v quiet -select_streams v:0 -show_entries stream=r_frame_rate -of csv=p=0 "${input}"`,
      );
      const fps = probeOut.trim() || '24/1';

      // 4. Reassemble
      // Copy audio from original if present
      const hasAudio = await this.hasAudioStream(input);
      const audioFlag = hasAudio ? `-i "${input}" -map 0:v -map 1:a -c:a copy` : '';

      await execAsync(
        `ffmpeg -framerate ${fps} -i "${tmpDir}/upscaled/frame_%06d.png" ${audioFlag} -c:v libx264 -pix_fmt yuv420p -crf 18 -preset fast "${output}"`,
        { timeout: 300_000 },
      );

      if (!existsSync(output)) {
        throw new Error(`Video upscale output not found: ${output}`);
      }
    } finally {
      // Cleanup temp frames
      await execAsync(`rm -rf "${tmpDir}"`).catch(() => {});
    }
  }

  private async hasAudioStream(videoPath: string): Promise<boolean> {
    try {
      const { stdout } = await execAsync(
        `ffprobe -v quiet -select_streams a -show_entries stream=codec_type -of csv=p=0 "${videoPath}"`,
      );
      return stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  private async getMediaDimensions(filePath: string): Promise<{ width: number; height: number }> {
    try {
      const { stdout } = await execAsync(
        `ffprobe -v quiet -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "${filePath}"`,
      );
      const [w, h] = stdout.trim().split(',').map(Number);
      return { width: w || 0, height: h || 0 };
    } catch {
      return { width: 0, height: 0 };
    }
  }
}
