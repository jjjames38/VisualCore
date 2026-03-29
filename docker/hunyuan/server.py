"""
HunyuanVideo 1.5 — REST API Server

Thin FastAPI wrapper around HunyuanVideo inference.
Exposes /generate, /health, /warmup, /unload endpoints
for RenderForge Create API integration.
"""

import os
import sys
import time
import uuid
import torch
import logging
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import uvicorn

# ─── Config ───

HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "8190"))
CKPT_DIR = os.environ.get("CKPT_DIR", "/app/ckpts")
ENABLE_STEP_DISTILL = os.environ.get("ENABLE_STEP_DISTILL", "true").lower() == "true"
ENABLE_CPU_OFFLOAD = os.environ.get("ENABLE_CPU_OFFLOAD", "true").lower() == "true"
DEFAULT_STEPS = int(os.environ.get("DEFAULT_STEPS", "8"))
OUTPUT_DIR = os.environ.get("OUTPUT_DIR", "/shared/videos")

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("hunyuan-server")

app = FastAPI(title="HunyuanVideo 1.5 API", version="1.0.0")

# ─── State ───

pipeline = None
model_loaded = False


# ─── Models ───

class GenerateRequest(BaseModel):
    prompt: str
    image_path: Optional[str] = None
    width: int = 848
    height: int = 480
    num_frames: int = 120  # 5 seconds at 24fps
    num_inference_steps: int = DEFAULT_STEPS
    enable_step_distill: bool = ENABLE_STEP_DISTILL
    seed: int = -1
    cfg_scale: float = 7.0
    enable_cpu_offload: bool = ENABLE_CPU_OFFLOAD


class GenerateResponse(BaseModel):
    video_path: str
    elapsed_ms: int
    width: int
    height: int
    num_frames: int
    fps: int = 24


class HealthResponse(BaseModel):
    status: str
    model_loaded: bool
    gpu_available: bool
    vram_used_gb: float
    vram_total_gb: float


# ─── Endpoints ───

@app.get("/health", response_model=HealthResponse)
def health():
    gpu_available = torch.cuda.is_available()
    vram_used = 0.0
    vram_total = 0.0

    if gpu_available:
        vram_used = torch.cuda.memory_allocated() / (1024 ** 3)
        vram_total = torch.cuda.get_device_properties(0).total_mem / (1024 ** 3)

    return HealthResponse(
        status="ok" if model_loaded else "model_not_loaded",
        model_loaded=model_loaded,
        gpu_available=gpu_available,
        vram_used_gb=round(vram_used, 2),
        vram_total_gb=round(vram_total, 2),
    )


@app.post("/warmup")
def warmup():
    """Pre-load model weights into GPU memory."""
    global pipeline, model_loaded

    if model_loaded:
        return {"status": "already_loaded"}

    log.info("Loading HunyuanVideo 1.5 model...")
    start = time.time()

    try:
        # Import HunyuanVideo pipeline
        sys.path.insert(0, "/app/hunyuan")

        # Use diffusers integration if available
        from diffusers import HunyuanVideoPipeline

        pipeline = HunyuanVideoPipeline.from_pretrained(
            CKPT_DIR,
            torch_dtype=torch.float16,
        )

        if ENABLE_CPU_OFFLOAD:
            pipeline.enable_model_cpu_offload()
        else:
            pipeline = pipeline.to("cuda")

        model_loaded = True
        elapsed = round(time.time() - start, 1)
        log.info(f"Model loaded in {elapsed}s")

        return {"status": "loaded", "elapsed_seconds": elapsed}

    except Exception as e:
        log.error(f"Model loading failed: {e}")
        raise HTTPException(status_code=500, detail=f"Model load failed: {str(e)}")


@app.post("/unload")
def unload():
    """Unload model from GPU memory."""
    global pipeline, model_loaded

    if not model_loaded:
        return {"status": "already_unloaded"}

    log.info("Unloading HunyuanVideo model...")

    pipeline = None
    model_loaded = False
    torch.cuda.empty_cache()

    import gc
    gc.collect()

    vram_used = torch.cuda.memory_allocated() / (1024 ** 3)
    log.info(f"Model unloaded. VRAM used: {vram_used:.2f}GB")

    return {"status": "unloaded", "vram_used_gb": round(vram_used, 2)}


@app.post("/generate", response_model=GenerateResponse)
def generate(req: GenerateRequest):
    """Generate a video clip."""
    global pipeline, model_loaded

    # Auto-warmup if not loaded
    if not model_loaded:
        warmup()

    if pipeline is None:
        raise HTTPException(status_code=503, detail="Pipeline not initialized")

    # Create output directory
    Path(OUTPUT_DIR).mkdir(parents=True, exist_ok=True)
    output_filename = f"hunyuan_{uuid.uuid4().hex[:12]}.mp4"
    output_path = str(Path(OUTPUT_DIR) / output_filename)

    log.info(f"Generating video: {req.width}x{req.height}, {req.num_frames} frames, "
             f"{req.num_inference_steps} steps")

    start = time.time()

    try:
        # Set seed
        generator = None
        if req.seed >= 0:
            generator = torch.Generator("cuda").manual_seed(req.seed)

        # Generate
        result = pipeline(
            prompt=req.prompt,
            height=req.height,
            width=req.width,
            num_frames=req.num_frames,
            num_inference_steps=req.num_inference_steps,
            guidance_scale=req.cfg_scale,
            generator=generator,
        )

        # Export video
        from diffusers.utils import export_to_video
        export_to_video(result.frames[0], output_path, fps=24)

        elapsed_ms = int((time.time() - start) * 1000)

        log.info(f"Video generated in {elapsed_ms}ms → {output_path}")

        return GenerateResponse(
            video_path=output_path,
            elapsed_ms=elapsed_ms,
            width=req.width,
            height=req.height,
            num_frames=req.num_frames,
        )

    except Exception as e:
        log.error(f"Generation failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ─── Main ───

if __name__ == "__main__":
    log.info(f"Starting HunyuanVideo API on {HOST}:{PORT}")
    log.info(f"  CKPT_DIR: {CKPT_DIR}")
    log.info(f"  STEP_DISTILL: {ENABLE_STEP_DISTILL}")
    log.info(f"  CPU_OFFLOAD: {ENABLE_CPU_OFFLOAD}")
    log.info(f"  DEFAULT_STEPS: {DEFAULT_STEPS}")

    uvicorn.run(app, host=HOST, port=PORT, log_level="info")
