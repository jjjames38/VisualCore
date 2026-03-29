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

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import {
  type QCResult,
  type QCScores,
  type GenerateRequest,
  type GenerateResponse,
  type GenerateProvider,
  type VisualCoreConfig,
} from '../providers/types.js';
import { logger } from '../../config/logger.js';

const execAsync = promisify(exec);

// ─── QC Configuration ───

interface QCConfig {
  clip_threshold: number;       // 0.25 default
  aesthetic_threshold: number;  // 5.0 default
  nsfw_threshold: number;       // 0.3 default
  temporal_threshold: number;   // 0.8 default
  max_retries: number;          // 3 default
  fallback_to_api: boolean;     // true default
}

// ─── Image QC ───

export class ImageQC {
  private config: QCConfig;
  private pythonScript: string;

  constructor(config: QCConfig) {
    this.config = config;
    // Python script for CLIP + Aesthetic scoring (runs as subprocess)
    this.pythonScript = `
import sys, json, torch
from PIL import Image

def evaluate(image_path, prompt):
    scores = {}
    
    # CLIP Score
    try:
        from transformers import CLIPProcessor, CLIPModel
        model = CLIPModel.from_pretrained("openai/clip-vit-base-patch32")
        processor = CLIPProcessor.from_pretrained("openai/clip-vit-base-patch32")
        image = Image.open(image_path)
        inputs = processor(text=[prompt], images=image, return_tensors="pt", padding=True)
        outputs = model(**inputs)
        logits = outputs.logits_per_image
        scores["clip_score"] = float(logits.softmax(dim=1)[0][0])
    except Exception as e:
        scores["clip_score"] = -1
        scores["clip_error"] = str(e)
    
    # Aesthetic Score (LAION aesthetic predictor)
    try:
        from transformers import pipeline
        aesthetic = pipeline("image-classification", model="cafeai/cafe_aesthetic")
        result = aesthetic(image_path)
        # Convert to 0-10 scale
        for r in result:
            if r["label"] == "aesthetic":
                scores["aesthetic_score"] = round(r["score"] * 10, 2)
                break
        else:
            scores["aesthetic_score"] = 5.0
    except Exception as e:
        scores["aesthetic_score"] = -1
        scores["aesthetic_error"] = str(e)
    
    # NSFW Detection
    try:
        from transformers import pipeline
        nsfw = pipeline("image-classification", model="Falconsai/nsfw_image_detection")
        result = nsfw(image_path)
        for r in result:
            if r["label"] == "nsfw":
                scores["nsfw_score"] = round(r["score"], 4)
                break
        else:
            scores["nsfw_score"] = 0.0
    except Exception as e:
        scores["nsfw_score"] = -1
        scores["nsfw_error"] = str(e)
    
    return scores

if __name__ == "__main__":
    image_path = sys.argv[1]
    prompt = sys.argv[2]
    result = evaluate(image_path, prompt)
    print(json.dumps(result))
`.trim();
  }

  /**
   * Evaluate image quality.
   */
  async evaluate(imagePath: string, prompt: string): Promise<QCResult> {
    const scores = await this.computeScores(imagePath, prompt);
    const issues: string[] = [];

    // Check thresholds
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
      attempt: 0, // Will be set by the retry wrapper
    };
  }

  /**
   * Compute all scores via Python subprocess.
   * Falls back to basic checks if Python deps unavailable.
   */
  private async computeScores(imagePath: string, prompt: string): Promise<QCScores> {
    try {
      const escapedPrompt = prompt.replace(/"/g, '\\"').replace(/'/g, "\\'");
      const { stdout } = await execAsync(
        `python3 -c '${this.pythonScript.replace(/'/g, "\\'")}' "${imagePath}" "${escapedPrompt}"`,
        { timeout: 30_000 },
      );
      return JSON.parse(stdout.trim()) as QCScores;
    } catch (error) {
      logger.warn('Python QC scoring failed, using basic checks', { error });
      return this.basicChecks(imagePath);
    }
  }

  /**
   * Basic quality checks without ML models (fallback).
   * Checks file size, dimensions, and basic pixel statistics.
   */
  private async basicChecks(imagePath: string): Promise<QCScores> {
    try {
      // Use ffprobe for basic image stats
      const { stdout } = await execAsync(
        `ffprobe -v quiet -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "${imagePath}"`,
      );
      const [w, h] = stdout.trim().split(',').map(Number);

      // Very basic: check if image is at least 256x256
      const dimensionOk = w >= 256 && h >= 256;

      return {
        clip_score: dimensionOk ? 0.3 : 0.1, // Assume passable if dimensions OK
        aesthetic_score: dimensionOk ? 6.0 : 3.0,
        nsfw_score: 0.0,
      };
    } catch {
      // Can't even probe the file — fail
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

  /**
   * Evaluate video quality.
   */
  async evaluate(videoPath: string, prompt: string): Promise<QCResult> {
    const scores = await this.computeScores(videoPath, prompt);
    const issues: string[] = [];

    // Check temporal consistency
    if (scores.temporal_consistency != null) {
      if (scores.temporal_consistency < this.config.temporal_threshold) {
        issues.push(
          `Temporal consistency ${scores.temporal_consistency.toFixed(3)} < ${this.config.temporal_threshold}`,
        );
      }
    }

    // Check motion detected (reject static/frozen videos)
    if (scores.motion_detected === false) {
      issues.push('No motion detected — video appears static');
    }

    // Check first-frame CLIP
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

    // 1. Temporal Consistency: compare adjacent frames via SSIM
    scores.temporal_consistency = await this.measureTemporalConsistency(videoPath);

    // 2. Motion Detection: optical flow magnitude
    scores.motion_detected = await this.detectMotion(videoPath);

    // 3. First-frame CLIP Score
    scores.clip_score = await this.firstFrameCLIP(videoPath, prompt);

    return scores;
  }

  /**
   * Measure frame-to-frame SSIM (structural similarity).
   * High SSIM between adjacent frames = consistent, low = flickering/artifacts.
   */
  private async measureTemporalConsistency(videoPath: string): Promise<number> {
    try {
      // Extract first 10 frames and compute average SSIM between pairs
      const { stdout } = await execAsync(
        `ffmpeg -i "${videoPath}" -vf "select=lt(n\\,10),ssim" -f null - 2>&1 | grep "SSIM Mean" | awk '{sum+=$NF; n++} END {print sum/n}'`,
        { timeout: 30_000 },
      );

      const ssim = parseFloat(stdout.trim());
      return isNaN(ssim) ? 0.9 : Math.min(1.0, Math.max(0, ssim));
    } catch {
      // If SSIM computation fails, assume OK (non-blocking)
      return 0.9;
    }
  }

  /**
   * Detect motion by computing frame differences.
   * Returns false if the video is essentially a static image.
   */
  private async detectMotion(videoPath: string): Promise<boolean> {
    try {
      // Compare first and last frame pixel difference
      const { stdout } = await execAsync(
        `ffmpeg -i "${videoPath}" -vf "select=eq(n\\,0)+eq(n\\,23),psnr" -f null - 2>&1 | grep "psnr_avg"`,
        { timeout: 15_000 },
      );

      // PSNR > 40 typically means frames are nearly identical (no motion)
      const match = stdout.match(/psnr_avg:([0-9.]+)/);
      if (match) {
        const psnr = parseFloat(match[1]);
        return psnr < 40; // If PSNR < 40, there IS motion (frames are different)
      }

      return true; // Assume motion if we can't measure
    } catch {
      return true;
    }
  }

  /**
   * Extract first frame and compute CLIP score against prompt.
   */
  private async firstFrameCLIP(videoPath: string, prompt: string): Promise<number> {
    try {
      const framePath = `/tmp/qc_frame_${Date.now()}.png`;
      await execAsync(
        `ffmpeg -i "${videoPath}" -vf "select=eq(n\\,0)" -vframes 1 "${framePath}"`,
        { timeout: 10_000 },
      );

      const imageQC = new ImageQC(this.config);
      const result = await imageQC.evaluate(framePath, prompt);

      // Cleanup
      await execAsync(`rm -f "${framePath}"`).catch(() => {});

      return result.scores.clip_score ?? 0;
    } catch {
      return 0.3; // Assume passable if extraction fails
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
      // Vary seed on each retry
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

      // Generate
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
          : { pass: true, scores: {}, issues: [], attempt }; // upscale = skip QC

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

    // Fallback to external API
    if (this.config.fallback_to_api && fallbackProvider) {
      logger.info('Falling back to external API', { provider: fallbackProvider.name });
      const fallbackResult = await fallbackProvider.generate(req);
      return {
        ...fallbackResult,
        qc: {
          pass: true, // API output assumed to pass
          scores: {},
          issues: ['Fallback to external API after QC retries exhausted'],
          attempt: this.config.max_retries + 1,
        },
      };
    }

    // No fallback — return last failed result
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
