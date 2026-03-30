/**
 * VisualCore — Real-ESRGAN Upscale Provider
 *
 * Upscales 480p video/images to 720p/1080p using Real-ESRGAN.
 * Uses realesrgan-ncnn-vulkan CLI for GPU-accelerated upscaling.
 *
 * Security: All external commands use execFile (no shell) to prevent injection.
 */

import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  type GenerateProvider,
  type GenerateRequest,
  type GenerateResponse,
  type ProviderName,
} from '@gstack/types';
import { logger } from '../../config/logger.js';

const execFileAsync = promisify(execFile);

const REALESRGAN_BIN = process.env.REALESRGAN_BIN || 'realesrgan-ncnn-vulkan';
const ESRGAN_IMAGE_MODEL = process.env.ESRGAN_IMAGE_MODEL || 'realesrgan-x4plus';
const ESRGAN_VIDEO_MODEL = process.env.ESRGAN_VIDEO_MODEL || 'realesrgan-x4plus-anime';

export class RealEsrganProvider implements GenerateProvider {
  readonly name: ProviderName = 'realesrgan';

  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync(REALESRGAN_BIN, ['-h']);
      return true;
    } catch {
      try {
        await execFileAsync('python3', ['-c', 'import realesrgan']);
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

      const isVideo = ['.mp4', '.webm', '.mov', '.avi'].includes(ext.toLowerCase());

      if (isVideo) {
        await this.upscaleVideo(inputPath, outputPath, factor);
      } else {
        await this.upscaleImage(inputPath, outputPath, factor);
      }

      const gpuTimeMs = Date.now() - startTime;
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
    logger.debug('Running Real-ESRGAN image upscale', { input, factor });

    await execFileAsync(
      REALESRGAN_BIN,
      ['-i', input, '-o', output, '-s', String(factor), '-n', ESRGAN_IMAGE_MODEL],
      { timeout: 600_000 },
    );

    if (!existsSync(output)) {
      throw new Error(`Upscale output not found: ${output}`);
    }
  }

  private async upscaleVideo(input: string, output: string, factor: number): Promise<void> {
    const tmpDir = `/tmp/upscale_${randomUUID()}`;

    try {
      await mkdir(`${tmpDir}/frames`, { recursive: true });
      await mkdir(`${tmpDir}/upscaled`, { recursive: true });

      // 1. Extract frames (execFile — no shell)
      await execFileAsync(
        'ffmpeg',
        ['-i', input, '-qscale:v', '2', `${tmpDir}/frames/frame_%06d.png`],
        { timeout: 120_000 },
      );

      // 2. Upscale all frames
      await execFileAsync(
        REALESRGAN_BIN,
        ['-i', `${tmpDir}/frames`, '-o', `${tmpDir}/upscaled`, '-s', String(factor), '-n', ESRGAN_VIDEO_MODEL, '-f', 'png'],
        { timeout: 600_000 },
      );

      // 3. Get original framerate
      const { stdout: probeOut } = await execFileAsync(
        'ffprobe',
        ['-v', 'quiet', '-select_streams', 'v:0', '-show_entries', 'stream=r_frame_rate', '-of', 'csv=p=0', input],
      );
      const fps = probeOut.trim() || '24/1';

      // 4. Check for audio
      const hasAudio = await this.hasAudioStream(input);

      // 5. Reassemble — build ffmpeg args
      const ffmpegArgs = [
        '-framerate', fps,
        '-i', `${tmpDir}/upscaled/frame_%06d.png`,
      ];

      if (hasAudio) {
        ffmpegArgs.push('-i', input, '-map', '0:v', '-map', '1:a', '-c:a', 'copy');
      }

      ffmpegArgs.push(
        '-c:v', 'libx264',
        '-pix_fmt', 'yuv420p',
        '-crf', '18',
        '-preset', 'fast',
        output,
      );

      await execFileAsync('ffmpeg', ffmpegArgs, { timeout: 300_000 });

      if (!existsSync(output)) {
        throw new Error(`Video upscale output not found: ${output}`);
      }
    } finally {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private async hasAudioStream(videoPath: string): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync(
        'ffprobe',
        ['-v', 'quiet', '-select_streams', 'a', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', videoPath],
      );
      return stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  private async getMediaDimensions(filePath: string): Promise<{ width: number; height: number }> {
    try {
      const { stdout } = await execFileAsync(
        'ffprobe',
        ['-v', 'quiet', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', filePath],
      );
      const [w, h] = stdout.trim().split(',').map(Number);
      return { width: w || 0, height: h || 0 };
    } catch {
      return { width: 0, height: 0 };
    }
  }
}
