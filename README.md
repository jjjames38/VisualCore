# VisualCore

Self-hosted AI image & video generation engine for [RenderForge](https://github.com/jjjames38/renderforge). Replaces Seedream / Seedance / Ideogram API costs with local GPU inference.

Built for the [270-channel US YouTube content manufacturing system](https://github.com/jjjames38/us-youtube-270ch-master-plan).

## Why VisualCore?

| | Seedream/Seedance API | VisualCore |
|---|---|---|
| **이미지 생성** | $0.035/장 | $0 (Flux Klein 로컬) |
| **영상 생성** | $0.022/초 | $0 (HunyuanVideo 로컬) |
| **썸네일** | $0.04/장 | $0 (Flux + 텍스트 LoRA) |
| **월 비용 (270ch)** | **$1,072** | **$50** (GPU + 핵심씬 API) |
| **절감률** | — | **95%** |
| **SynthID 리스크** | 모델에 따라 다름 | ❌ 없음 (Apache 2.0 / 오픈소스) |

## Architecture

```
N8N (오케스트레이션)
  ↓
RenderForge POST /create/v1/generate
  ↓
ProviderRouter
  ├── text-to-image → FluxKleinProvider (ComfyUI, port 8188)
  ├── image-to-video
  │   ├── priority: high → SeedanceRemoteProvider (API fallback, 20%)
  │   └── priority: normal → HunyuanLocalProvider (port 8190, 80%)
  └── upscale → RealEsrganProvider (CLI)
  ↓
QC Pipeline (CLIP Score + Aesthetic + 자동 재생성)
  ↓
BullMQ Job Queue (배치 최적화, 모델 스왑 최소화)
  ↓
GPU Memory Manager (RTX 4090 24GB VRAM 스왑)
```

## Models

| 용도 | 모델 | Elo/VBench | VRAM | 속도 (RTX 4090) | 라이선스 |
|------|------|-----------|------|----------------|---------|
| **이미지** | Flux.2 Klein 4B | Elo ~1100 | 8GB | <1초/장 | Apache 2.0 |
| **영상** | HunyuanVideo 1.5 step-distill | VBench ~11.3 | 14GB | ~19초/5초클립 | Tencent 오픈소스 |
| **업스케일** | Real-ESRGAN | — | 1GB | ~0.5초/프레임 | BSD |
| **핵심씬 fallback** | Seedance API (Fast) | VBench 12.88 | — | API | 유료 ($0.022/초) |

**품질 기준선**: Seedream 4.0 (Elo 1185) / Seedance 1.0 Pro (VBench 12.88)  
**이미지 격차**: Elo 21점 (3~6초 Ken Burns에서 체감 불가)  
**영상 격차**: VBench ~12% (핵심 씬 20%만 Seedance API로 보완)

## GPU Memory Budget (RTX 4090, 24GB)

```
Fish Speech S2  [████                    ]  2GB  ← 항상 상주 (VoiceCore)
Flux Klein 4B   [████████████            ]  8GB  ← 이미지 생성 시
HunyuanVideo    [████████████████████████████] 14GB ← 영상 생성 시 (Flux와 교체)
                ─────────────────────────────
                0    4    8   12   16   20  24GB
```

동시 로딩: `Flux(8GB) + Fish(2GB) = 10GB ✅`  
스왑 필요: `Flux ↔ HunyuanVideo` (자동, ~11초)

## Quick Start

### 1. 모델 다운로드

```bash
# Flux Klein 4B (~10GB)
huggingface-cli download black-forest-labs/FLUX.2-klein \
  --include "flux2-klein-4b.safetensors" "ae.safetensors" \
  --local-dir ./models/flux-klein/

# HunyuanVideo 1.5 (~20GB)
huggingface-cli download tencent/HunyuanVideo-1.5 \
  --local-dir ./models/hunyuan/
```

### 2. 환경 설정

```bash
cp .env.template .env
# .env 편집: API 키, GPU 설정 등
```

### 3. Docker Compose 기동

```bash
docker compose -f docker/docker-compose.gpu.yml up -d
```

### 4. 헬스 체크

```bash
curl http://localhost:3000/health       # RenderForge
curl http://localhost:8188/system_stats  # ComfyUI (Flux)
curl http://localhost:8190/health        # HunyuanVideo
curl http://localhost:8080/health        # VoiceCore (TTS)
```

### 5. 이미지 생성 테스트

```bash
curl -X POST http://localhost:3000/create/v1/generate \
  -H "Content-Type: application/json" \
  -H "x-api-key: $RENDERFORGE_API_KEY" \
  -d '{
    "type": "text-to-image",
    "prompt": "Hubble deep field, thousands of galaxies, vibrant nebula colors, 8k",
    "style": "t1_space",
    "aspect_ratio": "16:9",
    "resolution": "hd"
  }'
```

### 6. 영상 생성 테스트

```bash
curl -X POST http://localhost:3000/create/v1/generate \
  -H "Content-Type: application/json" \
  -H "x-api-key: $RENDERFORGE_API_KEY" \
  -d '{
    "type": "image-to-video",
    "prompt": "Slow zoom into spiral galaxy, stars twinkling",
    "source_image_url": "/shared/images/galaxy_001.png",
    "visual_priority": "normal",
    "duration": 5
  }'
```

## File Structure

```
VisualCore/
├── README.md
├── .env.template
├── .gitignore
├── src/
│   ├── create/
│   │   ├── providers/
│   │   │   ├── types.ts            # 인터페이스, 타입, 해상도 헬퍼
│   │   │   ├── router.ts           # ProviderRouter (핵심 라우팅)
│   │   │   ├── flux-klein.ts       # ComfyUI WebSocket (이미지)
│   │   │   ├── hunyuan-local.ts    # HunyuanVideo REST (영상)
│   │   │   ├── seedance-remote.ts  # Seedance API (핵심씬 fallback)
│   │   │   ├── realesrgan.ts       # Real-ESRGAN (업스케일)
│   │   │   └── index.ts            # barrel export
│   │   ├── gpu/
│   │   │   └── memory-manager.ts   # VRAM 모델 스왑 관리
│   │   ├── qc/
│   │   │   └── pipeline.ts         # CLIP + Aesthetic + 자동 재생성
│   │   └── queue/
│   │       └── create-jobs.ts      # BullMQ 큐 + 배치 최적화
│   └── config/
│       └── logger.ts               # logger stub (RF 실제 logger로 교체)
├── docker/
│   ├── docker-compose.gpu.yml      # 전체 GPU 스택
│   └── hunyuan/
│       ├── Dockerfile              # HunyuanVideo 컨테이너
│       └── server.py               # FastAPI REST 래퍼
├── scripts/
│   ├── download-models.sh          # 모델 일괄 다운로드
│   ├── train-all-loras.sh          # 9티어 + 썸네일 LoRA 일괄 학습
│   └── poc-test.sh                 # PoC A/B 테스트 실행
├── tests/
│   └── visualcore.test.ts          # Vitest 단위 테스트
└── docs/
    ├── VisualCore_Cost_Reduction_Strategy.md        # 비용 절감 전략 + 3년 TCO + 인프라 공유
    ├── VisualCore_Quality_Comparison.md             # 퀄리티 벤치마크 비교 + 의사결정 근거
    └── VisualCore_RenderForge_Integration_Spec.md   # 기술 스펙 21섹션 (코드, Docker, 로드맵)
```

## RenderForge 머지

```bash
cd /path/to/renderforge

# 코드 복사
cp -r VisualCore/src/create/providers/ src/create/providers/
cp -r VisualCore/src/create/gpu/ src/create/gpu/
cp -r VisualCore/src/create/qc/ src/create/qc/
cp -r VisualCore/src/create/queue/ src/create/queue/

# Docker
cp VisualCore/docker/docker-compose.gpu.yml docker/
cp -r VisualCore/docker/hunyuan/ docker/hunyuan/

# 환경변수
cat VisualCore/.env.template >> .env

# 의존성
pnpm add ws

# logger import 경로를 RenderForge 실제 logger로 수정
# 테스트
cp VisualCore/tests/visualcore.test.ts tests/
pnpm test
```

## 270ch 인프라 전체 절감 현황

| 프로젝트 | 대체 대상 | 월 절감 (Scale2) | 상태 |
|---------|----------|-----------------|------|
| [RenderForge](https://github.com/jjjames38/renderforge) | Shotstack | $1,249 | ✅ 완료 |
| [VoiceCore](https://github.com/jjjames38/VoiceCore) | ElevenLabs | ~$2,000 | ✅ 설계 완료 |
| [ProfileCore](https://github.com/jjjames38/ProfileCore) | Multilogin+SmartProxy | ~$1,250 | ✅ 설계 완료 |
| **VisualCore** | Seedream+Seedance+Ideogram | **$1,045** | 📋 코드 완료 |
| Claude Max 하이브리드 | Claude API | $1,420 | ✅ 전략 확정 |
| **합계** | | **$6,964/월** | **$83,568/년** |

## Documentation

`docs/` 폴더에 3개 전략·기술 문서:

| 문서 | 페이지 | 내용 |
|------|--------|------|
| [Cost Reduction Strategy](docs/VisualCore_Cost_Reduction_Strategy.md) | ~9p | 비용 절감 전략, VoiceCore/RenderForge 인프라 공유, 3년 TCO ($67K→$4.4K), Phase별 GPU 시간, 운영 아키텍처 |
| [Quality Comparison](docs/VisualCore_Quality_Comparison.md) | ~12p | Elo/VBench 벤치마크 비교, 270ch 유스케이스 분석, 하이브리드 전략 결론, 비용 vs 품질 트레이드오프, 오픈소스 발전 전망 |
| [Integration Spec](docs/VisualCore_RenderForge_Integration_Spec.md) | ~50p | 21개 섹션 전체 기술 스펙: Provider 코드, GPU 관리, QC, Docker, LoRA 학습, PoC 계획, N8N 마이그레이션, 모니터링, 재무제표 반영 |

## Tech Stack

TypeScript, Fastify, BullMQ + Redis, ComfyUI (WebSocket), HunyuanVideo (FastAPI), FFmpeg, Real-ESRGAN, Puppeteer + Chromium

## License

MIT

## Roadmap & TODO

- [ ] 🚀 초기 환경 설정 완료
- [ ] 🛠️ 핵심 로직 고도화 진행 중
- [x] 🛡️ Gstack Ecosystem 통합 완료
