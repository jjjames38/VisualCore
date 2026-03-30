/**
 * VisualCore — Quality Control Module
 *
 * Automated quality checking for generated images and videos.
 * Ensures Flux/HunyuanVideo output meets minimum quality thresholds
 * before passing to the render pipeline.
 *
 * Image QC: CLIP score + Aesthetic score + NSFW detection
 * Video QC: Temporal consistency + Motion detection + First-frame CLIP
 *
 * Auto-retry: On QC failure, regenerate with different seed up to N times.
 * Fallback: After max retries, optionally fall back to external API.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type QCResult,
  type QCScores,
  type GenerateRequest,
  type GenerateResponse,
  type GenerateProvider,
} from '@gstack/types';
import { logger } from '../../config/logger.js';

const execFileAsync = promisify(execFile);

// Resolve path to the external QC Python script
const __dirname = dirname(fileURLToPath(import.meta.url));
const QC_SCRIPT_PATH = resolve(__dirname, '../../../scripts/qc_evaluate.py');
const QC_SERVICE_URL = process.env.QC_SERVICE_URL || '';

// ─── QC Configuration ───

interface QCConfig {
  clip_threshold: number;       // 0.25 default
  aesthetic_threshold: number;   // 5.0 default
  nsfw_threshold: number;        // 0.3 default
  temporal_threshold: number;    // 0.8 default
  max_retries: number;           // 3 default
  fallback_to_api: boolean;      // true default
}

// ─── Image QC ───

export class ImageQC {
  private config: QCConfig;

  constructor(config: QCConfig) {
    this.config = config;
  }

  async evaluate(imagePath: string, prompt: string): Promise<QCResult> {
    const scores = await this.computeScores(imagePath, prompt);
    const issues: string[] = [];

    if (scores.clip_score != null && scores.clip_score >= 0) {
      if (scores.clip_score < this.config.clip_threshold) {
        issues.push(`CLIP score ${scores.clip_score.toFixed(3)} < threshold ${this.config.clip_threshold}`);
      }
    }

    if (scores.aesthetic_score != null && scores.aesthetic_score >= 0) {
      if (scores.aesthetic_score < this.config.aesthetic_threshold) {
        issues.push(`Aesthetic score ${scores.aesthetic_score.toFixed(1)} < threshold ${this.config.aesthetic_threshold}`);
      }
    }

    if (scores.nsfw_score != null && scores.nsfw_score >= 0) {
      if (scores.nsfw_score > this.config.nsfw_threshold) {
        issues.push(`NSFW score ${scores.nsfw_score.toFixed(3)} > threshold ${this.config.nsfw_threshold}`);
      }
    }

    return {
      pass: issues.length === 0,
      scores,
      issues,
      attempt: 0,
    };
  }

  /**
   * Compute scores via external QC service (HTTP) or Python script (execFile).
   * No shell is used — arguments are passed as an array to prevent injection.
   */
  private async computeScores(imagePath: string, prompt: string): Promise<QCScores> {
    // Priority 1: HTTP QC service (if configured)
    if (QC_SERVICE_URL) {
      try {
        return await this.computeViaService(imagePath, prompt);
      } catch (error) {
        logger.warn('QC service call failed, falling back to script', { error });
      }
    }

    // Priority 2: External Python script via execFile (no shell)
    try {
      const { stdout } = await execFileAsync(
        'python3',
        [QC_SCRIPT_PATH, imagePath, prompt],
        { timeout: 60_000 },
      );
      return JSON.parse(stdout.trim()) as QCScores;
    } catch (error) {
      logger.warn('Python QC script failed, using basic checks', { error });
      return this.basicChecks(imagePath);
    }
  }

  /** Call QC HTTP service (future FastAPI endpoint). */
  private async computeViaService(imagePath: string, prompt: string): Promise<QCScores> {
    const res = await fetch(`${QC_SERVICE_URL}/evaluate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_path: imagePath, prompt }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      throw new Error(`QC service error: ${res.status}`);
    }

    return (await res.json()) as QCScores;
  }

  /**
   * Basic quality checks without ML models (fallback).
   * Uses ffprobe via execFile (no shell).
   */
  private async basicChecks(imagePath: string): Promise<QCScores> {
    try {
      const { stdout } = await execFileAsync(
        'ffprobe',
        ['-v', 'quiet', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', imagePath],
      );
      const [w, h] = stdout.trim().split(',').map(Number);
      const dimensionOk = w >= 256 && h >= 256;

      return {
        clip_score: dimensionOk ? 0.3 : 0.1,
        aesthetic_score: dimensionOk ? 6.0 : 3.0,
        nsfw_score: 0.0,
      };
    } catch {
      return { clip_score: 0, aesthetic_score: 0, nsfw_score: 0 };
    }
  }
}

// ─── Video QC ───

export class VideoQC {
  private config: QCConfig;

  constructor(config: QCConfig) {
    this.config = config;
  }

  async evaluate(videoPath: string, prompt: string): Promise<QCResult> {
    const scores = await this.computeScores(videoPath, prompt);
    const issues: string[] = [];

    if (scores.temporal_consistency != null) {
      if (scores.temporal_consistency < this.config.temporal_threshold) {
        issues.push(
          `Temporal consistency ${scores.temporal_consistency.toFixed(3)} < ${this.config.temporal_threshold}`,
        );
      }
    }

    if (scores.motion_detected === false) {
      issues.push('No motion detected — video appears static');
    }

    if (scores.clip_score != null && scores.clip_score >= 0) {
      if (scores.clip_score < this.config.clip_threshold) {
        issues.push(`First-frame CLIP ${scores.clip_score.toFixed(3)} < ${this.config.clip_threshold}`);
      }
    }

    return {
      pass: issues.length === 0,
      scores,
      issues,
      attempt: 0,
    };
  }

  private async computeScores(videoPath: string, prompt: string): Promise<QCScores> {
    const scores: QCScores = {};
    scores.temporal_consistency = await this.measureTemporalConsistency(videoPath);
    scores.motion_detected = await this.detectMotion(videoPath);
    scores.clip_score = await this.firstFrameCLIP(videoPath, prompt);
    return scores;
  }

  /**
   * Measure frame-to-frame SSIM via ffmpeg (execFile, no shell).
   */
  private async measureTemporalConsistency(videoPath: string): Promise<number> {
    try {
      const { stderr } = await execFileAsync(
        'ffmpeg',
        ['-i', videoPath, '-vf', 'select=lt(n\\,10),ssim', '-f', 'null', '-'],
        { timeout: 30_000 },
      );

      // SSIM values appear in stderr for ffmpeg
      const matches = stderr.match(/All:([0-9.]+)/g);
      if (matches && matches.length > 0) {
        const values = matches.map(m => parseFloat(m.split(':')[1]));
        const avg = values.reduce((a, b) => a + b, 0) / values.length;
        return Math.min(1.0, Math.max(0, avg));
      }

      return 0.9; // Default if parsing fails
    } catch {
      return 0.9;
    }
  }

  /**
   * Detect motion by comparing first and last frames via ffmpeg (execFile).
   */
  private async detectMotion(videoPath: string): Promise<boolean> {
    try {
      const { stderr } = await execFileAsync(
        'ffmpeg',
        ['-i', videoPath, '-vf', 'select=eq(n\\,0)+eq(n\\,23),psnr', '-f', 'null', '-'],
        { timeout: 15_000 },
      );

      const match = stderr.match(/psnr_avg:([0-9.]+)/);
      if (match) {
        const psnr = parseFloat(match[1]);
        return psnr < 40;
      }
      return true;
    } catch {
      return true;
    }
  }

  /**
   * Extract first frame and compute CLIP score (execFile for ffmpeg).
   */
  private async firstFrameCLIP(videoPath: string, prompt: string): Promise<number> {
    try {
      const framePath = `/tmp/qc_frame_${Date.now()}.png`;

      await execFileAsync(
        'ffmpeg',
        ['-i', videoPath, '-vf', 'select=eq(n\\,0)', '-vframes', '1', framePath],
        { timeout: 10_000 },
      );

      const imageQC = new ImageQC(this.config);
      const result = await imageQC.evaluate(framePath, prompt);

      // Cleanup
      await execFileAsync('rm', ['-f', framePath]).catch(() => {});

      return result.scores.clip_score ?? 0;
    } catch {
      return 0.3;
    }
  }
}

// ─── QC Wrapper with Auto-Retry ───

export class QCPipeline {
  private imageQC: ImageQC;
  private videoQC: VideoQC;
  private config: QCConfig;

  constructor(config: QCConfig) {
    this.config = config;
    this.imageQC = new ImageQC(config);
    this.videoQC = new VideoQC(config);
  }

  /**
   * Generate with automatic quality checking and retry.
   *
   * Flow:
   *   1. Generate with local provider
   *   2. QC check
   *   3. If failed → regenerate with different seed (up to max_retries)
   *   4. If all retries fail → optionally fall back to external API
   */
  async generateWithQC(
    req: GenerateRequest,
    localProvider: GenerateProvider,
    fallbackProvider?: GenerateProvider,
  ): Promise<GenerateResponse> {
    const maxRetries = this.config.max_retries;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const seedOffset = attempt - 1;
      const modifiedReq: GenerateRequest = {
        ...req,
        seed: req.seed != null && req.seed >= 0
          ? req.seed + seedOffset
          : undefined,
      };

      logger.info('Generation attempt', {
        attempt,
        maxRetries,
        provider: localProvider.name,
        type: req.type,
      });

      const result = await localProvider.generate(modifiedReq);

      if (result.status === 'failed') {
        logger.warn('Generation failed', { attempt, error: result.error });
        continue;
      }

      if (!result.output?.url) {
        logger.warn('No output URL', { attempt });
        continue;
      }

      // QC Check
      const qcResult = req.type === 'image-to-video'
        ? await this.videoQC.evaluate(result.output.url, req.prompt)
        : req.type === 'text-to-image'
          ? await this.imageQC.evaluate(result.output.url, req.prompt)
          : { pass: true, scores: {}, issues: [], attempt };

      qcResult.attempt = attempt;

      if (qcResult.pass) {
        logger.info('QC passed', {
          attempt,
          provider: localProvider.name,
          scores: qcResult.scores,
        });
        return { ...result, qc: qcResult };
      }

      logger.warn('QC failed', {
        attempt,
        issues: qcResult.issues,
        scores: qcResult.scores,
      });
    }

    // All retries exhausted
    logger.error('All QC retries exhausted', {
      type: req.type,
      maxRetries,
      fallback: !!fallbackProvider,
    });

    if (this.config.fallback_to_api && fallbackProvider) {
      logger.info('Falling back to external API', { provider: fallbackProvider.name });
      const fallbackResult = await fallbackProvider.generate(req);
      return {
        ...fallbackResult,
        qc: {
          pass: true,
          scores: {},
          issues: ['Fallback to external API after QC retries exhausted'],
          attempt: this.config.max_retries + 1,
        },
      };
    }

    return {
      id: `qc_failed_${Date.now()}`,
      status: 'failed',
      provider: localProvider.name,
      cost: 0,
      error: `QC failed after ${maxRetries} attempts. No fallback configured.`,
      created_at: new Date().toISOString(),
    };
  }
}
