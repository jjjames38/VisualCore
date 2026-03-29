# ═══════════════════════════════════════════
#  HunyuanVideo 1.5 — REST API Server
# ═══════════════════════════════════════════
#  Wraps HunyuanVideo inference in a simple
#  REST API for RenderForge Create API integration.
# ═══════════════════════════════════════════

FROM nvidia/cuda:12.1.1-devel-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONUNBUFFERED=1

# System dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv \
    git curl ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Python dependencies
RUN pip3 install --no-cache-dir \
    torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu121

RUN pip3 install --no-cache-dir \
    diffusers transformers accelerate \
    safetensors sentencepiece protobuf \
    fastapi uvicorn pydantic \
    huggingface-hub

# Clone HunyuanVideo
RUN git clone https://github.com/Tencent-Hunyuan/HunyuanVideo-1.5.git /app/hunyuan

# REST API wrapper
COPY server.py /app/server.py

# Model weights directory (mount as volume)
VOLUME /app/ckpts

EXPOSE 8190

CMD ["python3", "/app/server.py"]
