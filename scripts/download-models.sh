#!/bin/bash
# ═══════════════════════════════════════════════
#  VisualCore — 모델 일괄 다운로드
# ═══════════════════════════════════════════════
#  Usage: ./scripts/download-models.sh [--all|--flux|--hunyuan|--esrgan|--qc]
#  Prerequisites: pip install huggingface-hub
# ═══════════════════════════════════════════════

set -euo pipefail

MODEL_DIR="${MODEL_DIR:-./models}"
COMPONENT="${1:---all}"

echo "═══════════════════════════════════════════════"
echo "  VisualCore Model Downloader"
echo "  Target: $MODEL_DIR"
echo "  Component: $COMPONENT"
echo "═══════════════════════════════════════════════"

# ─── Flux Klein 4B (~10GB) ───
download_flux() {
  echo ""
  echo "▸ Downloading Flux.2 Klein 4B (Apache 2.0)..."
  echo "  Size: ~10GB (checkpoint + VAE + CLIP)"
  
  local flux_dir="$MODEL_DIR/flux-klein"
  mkdir -p "$flux_dir"
  
  huggingface-cli download black-forest-labs/FLUX.2-klein \
    --local-dir "$flux_dir" \
    --include "*.safetensors" "*.json" "*.txt"
  
  echo "✅ Flux Klein 4B → $flux_dir"
  echo "  License: Apache 2.0 (상업적 사용 자유)"
  echo ""
  
  # Symlink for ComfyUI
  local comfy_ckpt="./docker/volumes/comfyui-models"
  if [ -d "$comfy_ckpt" ]; then
    ln -sf "$flux_dir/flux2-klein-4b.safetensors" "$comfy_ckpt/"
    echo "  Symlinked to ComfyUI checkpoints"
  fi
}

# ─── HunyuanVideo 1.5 (~20GB) ───
download_hunyuan() {
  echo ""
  echo "▸ Downloading HunyuanVideo 1.5 (Tencent open-source)..."
  echo "  Size: ~20GB (transformer + VAE + text encoder)"
  
  local hunyuan_dir="$MODEL_DIR/hunyuan"
  mkdir -p "$hunyuan_dir"
  
  huggingface-cli download tencent/HunyuanVideo-1.5 \
    --local-dir "$hunyuan_dir"
  
  echo "✅ HunyuanVideo 1.5 → $hunyuan_dir"
  echo "  License: Tencent 오픈소스 (상업적 사용 가능)"
  echo "  SynthID: 없음"
  echo ""
  echo "  체크포인트 구조:"
  echo "  ├── transformer/"
  echo "  │   ├── 480p_i2v/              ← Image-to-Video (메인)"
  echo "  │   ├── 480p_t2v_distilled/    ← Step-distilled (빠른 추론)"
  echo "  │   └── 720p_sr_distilled/     ← Super-resolution"
  echo "  ├── vae/"
  echo "  └── text_encoder/"
}

# ─── Real-ESRGAN ───
download_esrgan() {
  echo ""
  echo "▸ Installing Real-ESRGAN..."
  
  local esrgan_dir="$MODEL_DIR/realesrgan"
  mkdir -p "$esrgan_dir"
  
  # ncnn-vulkan binary (faster, no Python deps)
  local platform=$(uname -s | tr '[:upper:]' '[:lower:]')
  local url=""
  
  if [ "$platform" = "linux" ]; then
    url="https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-ubuntu.zip"
  elif [ "$platform" = "darwin" ]; then
    url="https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-macos.zip"
  fi
  
  if [ -n "$url" ]; then
    echo "  Downloading ncnn-vulkan binary..."
    curl -L "$url" -o "$esrgan_dir/realesrgan.zip"
    unzip -o "$esrgan_dir/realesrgan.zip" -d "$esrgan_dir/"
    rm "$esrgan_dir/realesrgan.zip"
    chmod +x "$esrgan_dir/realesrgan-ncnn-vulkan"
    echo "✅ Real-ESRGAN → $esrgan_dir/realesrgan-ncnn-vulkan"
  else
    echo "  Unknown platform. Install manually:"
    echo "  pip install realesrgan --break-system-packages"
  fi
}

# ─── QC Models (CLIP + Aesthetic) ───
download_qc() {
  echo ""
  echo "▸ Pre-caching QC models (CLIP + Aesthetic)..."
  
  python3 -c "
from transformers import CLIPProcessor, CLIPModel
print('  Downloading CLIP ViT-B/32...')
CLIPModel.from_pretrained('openai/clip-vit-base-patch32')
CLIPProcessor.from_pretrained('openai/clip-vit-base-patch32')
print('  ✅ CLIP model cached')
" 2>/dev/null || echo "  ⚠️ CLIP download failed (install transformers first)"
  
  python3 -c "
from transformers import pipeline
print('  Downloading Aesthetic predictor...')
pipeline('image-classification', model='cafeai/cafe_aesthetic')
print('  ✅ Aesthetic model cached')
" 2>/dev/null || echo "  ⚠️ Aesthetic download failed (install transformers first)"
}

# ─── Main ───
case "$COMPONENT" in
  --all)
    download_flux
    download_hunyuan
    download_esrgan
    download_qc
    ;;
  --flux)
    download_flux
    ;;
  --hunyuan)
    download_hunyuan
    ;;
  --esrgan)
    download_esrgan
    ;;
  --qc)
    download_qc
    ;;
  *)
    echo "Usage: $0 [--all|--flux|--hunyuan|--esrgan|--qc]"
    exit 1
    ;;
esac

echo ""
echo "═══════════════════════════════════════════════"
echo "  다운로드 완료"
echo ""
du -sh "$MODEL_DIR"/* 2>/dev/null || true
echo "═══════════════════════════════════════════════"
