# VisualCore — Local Vision Engine

Seedream/Seedance/Ideogram API 비용을 95% 절감하는 셀프호스팅 AI 이미지/영상 생성 엔진.
Flux Klein 4B (T2I) + HunyuanVideo 1.5 (I2V) + Real-ESRGAN (Upscale) 기반.

## Quick Start

```bash
# 의존성 설치
npm install

# 개발 서버 (port 3100)
npm run dev:server

# 프로덕션 빌드 + 실행
npm run build
npm start

# 테스트
npm test
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | Liveness check |
| GET | `/health` | Provider 가용성 (Flux, Hunyuan, Seedance, ESRGAN) |
| GET | `/status` | GPU VRAM 상태 + Queue 대기열 |
| POST | `/create/v1/generate` | 이미지/영상 생성 요청 |
| GET | `/create/v1/generate/:id` | 생성 작업 상태 조회 |
| POST | `/create/v1/generate/batch` | 배치 생성 (GPU swap 최적화) |

### Generate Request

```bash
curl -X POST http://localhost:3100/create/v1/generate \
  -H 'Content-Type: application/json' \
  -d '{
    "type": "text-to-image",
    "prompt": "a nebula in deep space, cinematic lighting",
    "style": "t1_space",
    "aspect_ratio": "16:9",
    "resolution": "hd"
  }'
```

**type**: `text-to-image` | `image-to-video` | `upscale`
**visual_priority**: `normal` (로컬 GPU) | `high` (Seedance API fallback)

## Architecture

```
Client (N8N / cURL)
  |
  POST /create/v1/generate
  |
  ProviderRouter ── type + priority 기반 라우팅
  |    |    |    |
  Flux  Hunyuan  Seedance  ESRGAN
  Klein  Local   Remote    (upscale)
  |
  QC Pipeline ── CLIP + Aesthetic + NSFW 자동 검증
  |              실패 시 seed 변경 후 재시도 (max 3회)
  |              전부 실패 → API fallback
  |
  BullMQ Queue ── concurrency: 1 (단일 GPU)
                  배치 최적화: 같은 모델 그룹핑 → swap 최소화
```

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Image Gen | Flux Klein 4B (Apache 2.0, ~8GB VRAM) |
| Video Gen | HunyuanVideo 1.5 step-distill (~14GB VRAM) |
| Upscale | Real-ESRGAN ncnn-vulkan |
| HTTP | Fastify v5 |
| Queue | BullMQ + Redis |
| QC | CLIP score + Aesthetic + NSFW detection |
| GPU | RTX 4090 (24GB), auto model swap |
| ComfyUI | WebSocket persistent connection + auto-reconnect |

## GPU Memory Management

단일 RTX 4090 (24GB)에서 모델 자동 스왑:

| Model | VRAM | 비고 |
|-------|------|------|
| Flux Klein 4B | ~8GB | T2I |
| HunyuanVideo 1.5 | ~14GB | I2V (CPU offloading) |
| Fish Speech S2 | ~2GB | Always resident (VoiceCore) |
| Real-ESRGAN | ~1GB | Upscale |

호환: `[Flux + Fish] = 10GB`, `[Hunyuan + Fish] = 16GB`
비호환: `[Flux + Hunyuan] = 22GB` → 자동 swap

## Configuration

`.env.template` 참조. 주요 설정:

```env
PORT=3100                          # 서버 포트
REDIS_URL=redis://redis:6379       # BullMQ (없으면 direct 모드)
COMFYUI_HOST=localhost             # ComfyUI 주소
HUNYUAN_HOST=localhost             # HunyuanVideo 주소
SEEDANCE_API_KEY=                  # Seedance fallback (선택)
QC_CLIP_THRESHOLD=0.25             # QC 임계값
GPU_VRAM_TOTAL_GB=24               # GPU VRAM
LORA_T1_SPACE=space_v1.safetensors # 티어별 LoRA
```

## Project Structure

```
src/
  index.ts                  # Entry point
  server.ts                 # Fastify server factory
  config/
    index.ts                # .env → VisualCoreConfig parser
    logger.ts               # Structured logger
  api/
    generate.ts             # POST/GET /create/v1/generate
    health.ts               # GET /, /health, /status
  create/
    providers/
      flux-klein.ts         # ComfyUI WebSocket provider
      hunyuan-local.ts      # HunyuanVideo REST provider
      seedance-remote.ts    # Seedance API fallback
      realesrgan.ts         # ESRGAN upscale (execFile, no shell)
      router.ts             # Request → Provider routing
      types.ts              # Core interfaces
    gpu/
      memory-manager.ts     # VRAM swap + nvidia-smi monitoring
    queue/
      create-jobs.ts        # BullMQ queue + batch optimization
    qc/
      pipeline.ts           # QC scoring + auto-retry
scripts/
  qc_evaluate.py            # Python QC script (CLIP/Aesthetic/NSFW)
  download-models.sh        # Model download
  train-all-loras.sh        # LoRA training
tests/
  visualcore.test.ts        # Unit tests (dimensions, GPU manager)
  router.test.ts            # Provider routing tests
  qc-pipeline.test.ts       # QC retry/fallback tests
  api.test.ts               # HTTP API integration tests
  config.test.ts            # Config parsing tests
docker/
  docker-compose.gpu.yml    # GPU stack (ComfyUI, Hunyuan, Redis)
```

## Cost Comparison (Scale2, 270ch/month)

| Item | API Cost | VisualCore | Savings |
|------|----------|------------|---------|
| Seedream (images) | $841 | $0 (Flux local) | $841 |
| Seedance (video) | $137 | $27 (20% API) | $110 |
| Ideogram (thumbnails) | $94 | $0 (Flux + LoRA) | $94 |
| GPU RunPod | - | $23 | - |
| **Total** | **$1,072** | **$50** | **$1,022 (95%)** |

## Tests

```bash
npm test          # 58 tests across 5 files
npm run test:watch  # Watch mode
```

## Roadmap

- [x] Fastify HTTP server + Config bootstrap
- [x] Provider Router (Flux/Hunyuan/Seedance/ESRGAN)
- [x] GPU Memory Manager + VRAM monitoring
- [x] BullMQ queue + batch optimization
- [x] QC Pipeline (CLIP + retry + API fallback)
- [x] WebSocket persistent connection + auto-reconnect
- [x] Security: execFile (no shell injection)
- [x] 58 tests (router, QC, API, config)
- [ ] LoRA style fine-tuning (9 tiers + thumbnail)
- [ ] Prometheus metrics endpoint
- [ ] RunPod production deployment
- [ ] 270-channel migration

## License

MIT
