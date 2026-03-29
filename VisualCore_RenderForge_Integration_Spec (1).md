# VisualCore — RenderForge Create API 로컬 GPU 통합 기술 스펙

**프로젝트**: VisualCore (RenderForge 내장 모듈)  
**목적**: RenderForge Create API의 AI 에셋 생성 백엔드를 외부 API(Seedream/Seedance/Ideogram) → 로컬 GPU 추론(Flux/HunyuanVideo)으로 교체  
**전제**: 외부 서비스 없음, 내부 270ch 파이프라인 전용  
**날짜**: 2026-03-29  
**연관 리포**: github.com/jjjames38/renderforge (private)  

---

## 1. 현재 상태 분석

### 1.1 RenderForge Create API 현재 구조

```
POST /create/v1/generate
  → request body: { type: "text-to-image" | "image-to-video", prompt, options }
  → BullMQ job 생성
  → Worker: 외부 API 호출 (Seedream / Seedance)
  → 결과 저장 → Serve API 에셋으로 등록
  → Webhook callback

GET /create/v1/generate/:id
  → job 상태 조회 (queued → processing → done/failed)
```

### 1.2 270ch 월간 소비량 (Scale2 풀스케일 기준)

| 항목 | 월 수량 | 현재 단가 | 현재 월 비용 |
|------|--------|----------|-------------|
| Seedream 이미지 (롱폼) | 13,728장 | $0.035 | $481 |
| Seedream 이미지 (Shorts) | 10,296장 | $0.035 | $360 |
| Seedance 영상 (롱폼) | 6,240초 (1,248클립 × 5초) | $0.022/초 | $137 |
| Ideogram 썸네일 (롱폼) | 2,340장 | $0.04 | $94 |
| **합계** | 이미지 26,364장 + 영상 1,248클립 | | **$1,072/월** |

### 1.3 Phase별 수량

| Phase | 채널 | 이미지/월 | 영상클립/월 | 썸네일/월 | API 비용 |
|-------|------|----------|-----------|---------|---------|
| Seed (5ch) | 5 | 488 | 23 | 43 | $20 |
| Pilot (20ch) | 20 | 1,953 | 92 | 173 | $79 |
| Scale1 (90ch) | 90 | 8,788 | 416 | 780 | $357 |
| Scale2 (270ch) | 270 | 26,364 | 1,248 | 2,340 | $1,072 |

---

## 2. 대체 모델 선정 및 품질 분석

### 2.1 이미지: Flux.1 계열

| 모델 | Elo (AA) | 파라미터 | VRAM | 속도 (RTX 4090) | 라이선스 | SynthID |
|------|---------|---------|------|----------------|---------|---------|
| FLUX.2 Dev Turbo | 1164 | 32B(양자화) | ~20GB | ~4초/장 | Non-Commercial | ❌ |
| FLUX.2 Dev | 1149 | 32B(양자화) | ~20GB | ~7초/장 | Non-Commercial | ❌ |
| **FLUX.2 Klein 4B** | ~1100 | **4B** | **~8GB** | **<1초/장** | **Apache 2.0** | ❌ |
| FLUX.1 Dev | 1090추정 | 12B | ~20GB | ~8초/장 | Non-Commercial | ❌ |
| FLUX.1 Schnell | 1060추정 | 12B | ~12GB | ~4초/장 | Apache 2.0 | ❌ |
| Qwen Image | 1151 | — | ~16GB | ~6초/장 | 오픈소스 | ❌ |

**기준선**: Seedream 4.0 = Elo 1185

**의사결정 매트릭스**:

270ch 유스케이스에서 이미지는 3~6초간 Ken Burns로 표시됨. 이 조건에서:

- Elo 1185(Seedream) vs 1164(FLUX.2 Dev Turbo) = **21점 차이, 체감 불가**
- Elo 1185 vs ~1100(Klein 4B) = **85점 차이, 약간 열화 가능**

**선정안 (2-tier)**:

| 용도 | 모델 | 이유 |
|------|------|------|
| **롱폼 본문 이미지** | FLUX.2 Klein 4B | Apache 2.0, 8GB VRAM, <1초/장, 대량 생산에 최적 |
| **썸네일 (텍스트 포함)** | FLUX.2 Klein 4B + 텍스트 LoRA | Ideogram 대체, 텍스트 렌더링 LoRA 적용 |
| **Shorts 이미지** | FLUX.2 Klein 4B | Shorts는 더 낮은 품질도 허용 |
| **품질 크리티컬 씬** (선택) | FLUX.2 Dev Turbo | 편당 1~2장, 높은 품질 필요 시 |

> **라이선스 주의**: FLUX.2 Dev/Dev Turbo는 Non-Commercial. 270ch 시스템은 상업적 사용이므로 **Klein 4B(Apache 2.0)를 기본으로 하고**, 상업 라이선스 구매 시 Dev Turbo로 업그레이드.
> 대안: Qwen Image(오픈소스, Elo 1151)도 상업적 사용 가능. PoC에서 Klein vs Qwen 비교 필요.

### 2.2 영상: HunyuanVideo 1.5

| 모델 | VBench 종합 | 파라미터 | VRAM | 속도 (RTX 4090) | 라이선스 |
|------|-----------|---------|------|----------------|---------|
| Seedance 1.0 Pro | **12.88 (1위)** | 비공개 | — | API only | 유료 |
| **HunyuanVideo 1.5 (step-distill)** | ~11.3 | **8.3B** | **14GB** | **~19초/5초클립** | Tencent 오픈소스 |
| HunyuanVideo 1.5 (표준) | ~11.3 | 8.3B | 14GB | ~75초/5초클립 | Tencent 오픈소스 |
| Wan 2.2 (14B active) | ~11.5 | 27B | 24GB+ | ~38초/5초클립 | Alibaba 오픈소스 |

**기준선**: Seedance 1.0 Pro = VBench 12.88

**영상은 이미지보다 격차가 크다.** Seedance 12.88 vs HunyuanVideo ~11.3 = 약 12% 차이.  
다만 270ch에서 영상은 전체 비주얼의 20%이고, Ken Burns 보조 역할임.

**선정안 (하이브리드)**:

| 용도 | 모델 | 비중 | 이유 |
|------|------|------|------|
| **일반 영상 클립** (80%) | HunyuanVideo 1.5 step-distill | 1,000클립/월 | 14GB VRAM, 19초/클립, 충분한 품질 |
| **핵심 씬** (20%) | Seedance API fallback | 248클립/월 | 감정 피크, 인물 클로즈업 등 품질 크리티컬 |

> 핵심 씬 판별: 스크립트 Pass2에서 `visual_priority: "high"` 태그가 붙은 씬만 Seedance API 사용.  
> Seedance 비중 20% = 월 $27 (기존 $137의 20%)

### 2.3 품질 비교 요약

| 항목 | 현재 (API) | 셀프 (로컬) | 품질 유지율 | 비고 |
|------|----------|-----------|-----------|------|
| 롱폼 이미지 | Seedream 4.0 (Elo 1185) | Flux Klein 4B (~1100) | **~93%** | Ken Burns 3~6초, 체감 미미 |
| Shorts 이미지 | Seedream 4.0 | Flux Klein 4B | **~93%** | 1초 이하 노출, 영향 없음 |
| 썸네일 | Ideogram (Elo ~1150) | Flux Klein + 텍스트 LoRA | **~90%** | LoRA 튜닝 품질에 의존 |
| 영상 (일반) | Seedance (VBench 12.88) | HunyuanVideo 1.5 (~11.3) | **~88%** | 5초 클립, 보조적 역할 |
| 영상 (핵심) | Seedance | Seedance API 유지 | **100%** | 월 248클립만 API |
| **가중 평균** | | | **~92%** | |

---

## 3. GPU 인프라 설계

### 3.1 VRAM 예산 (RTX 4090, 24GB)

동시 로딩이 불가능하므로 **모델 스왑(Model Swapping)** 전략 사용.

| 모델 | VRAM | 로딩 시간 | 비고 |
|------|------|----------|------|
| Flux Klein 4B | ~8GB | ~3초 | 가장 가볍고 빠름 |
| HunyuanVideo 1.5 (step-distill, FP8) | ~14GB | ~8초 | offloading 활용 |
| Fish Speech S2 (VoiceCore) | ~2GB | ~2초 | 매우 가벼움 |
| **동시 최대** | Flux(8) + Fish(2) = **10GB** | | 여유 14GB |

**스왑 전략**:

```
[배치 스케줄]

00:00~06:00  Fish Speech (TTS) 전용 — 야간 TTS 배치
06:00~18:00  Flux Klein (이미지) 메인 + Fish Speech 상주
             → 이미지 작업 없을 때 HunyuanVideo 로딩 → 영상 생성
18:00~24:00  HunyuanVideo (영상) 전용 — 야간 영상 배치

[온디맨드 스왑]
이미지 요청 → Flux 로딩되어 있으면 즉시 처리
              → HunyuanVideo 로딩 상태면 → 언로드(3초) → Flux 로딩(3초) → 처리
영상 요청   → HunyuanVideo 로딩되어 있으면 즉시 처리
              → Flux 로딩 상태면 → 언로드(3초) → HunyuanVideo 로딩(8초) → 처리
```

### 3.2 GPU 시간 필요량 (Scale2 기준)

| 작업 | 물량 | 처리 속도 | GPU 시간 |
|------|------|----------|---------|
| 이미지 (Flux Klein) | 26,364장 | **~3,600장/hr** (<1초/장) | **7.3hr** |
| 영상 (HunyuanVideo, 80%) | 1,000클립 | ~190클립/hr | **5.3hr** |
| 영상 업스케일 (Real-ESRGAN) | 1,000클립 | ~600클립/hr | **1.7hr** |
| 재생성 (실패 10%) | — | — | **~1.4hr** |
| TTS (VoiceCore) | ~26,900분 | ~600분/hr | **~45hr** |
| 모델 스왑 오버헤드 (10%) | — | — | **~6hr** |
| **월 총 GPU 시간** | | | **~67hr** |

> **월 720hr 중 67hr = 9.3% 점유율.** RTX 4090 1대로 매우 여유 있음.
> Flux Klein이 <1초/장이라 이미지 GPU 시간이 기존 추정(249hr)에서 7.3hr로 급감.

### 3.3 Phase별 GPU 비용 (RunPod RTX 4090, $0.34/hr)

| Phase | 이미지 hr | 영상 hr | TTS hr | 기타 | 총 hr | RunPod 비용 |
|-------|----------|--------|--------|------|-------|-----------|
| Seed (5ch) | 0.1 | 0.1 | 0.8 | 0.2 | **1.2** | **$0.4** |
| Pilot (20ch) | 0.5 | 0.5 | 3.2 | 0.8 | **5.0** | **$1.7** |
| Scale1 (90ch) | 2.4 | 2.2 | 15 | 3.0 | **22.6** | **$7.7** |
| Scale2 (270ch) | 7.3 | 6.9 | 45 | 7.5 | **66.7** | **$22.7** |

---

## 4. RenderForge Create API 변경 설계

### 4.1 아키텍처 변경

```
현재:
  POST /create/v1/generate
    → CreateWorker → SeedreamProvider / SeedanceProvider (HTTP 외부 API)
    → 결과 저장

변경 후:
  POST /create/v1/generate
    → CreateWorker → ProviderRouter
                       ├── FluxLocalProvider (ComfyUI WebSocket)
                       ├── HunyuanLocalProvider (REST API)
                       ├── SeedanceRemoteProvider (HTTP 외부 API, fallback)
                       └── RealEsrganProvider (로컬 업스케일)
    → 결과 저장
```

### 4.2 새로운 인터페이스 설계

```typescript
// src/create/providers/types.ts

interface GenerateRequest {
  type: 'text-to-image' | 'image-to-video' | 'upscale';
  prompt: string;
  negative_prompt?: string;
  style?: string;           // 니치별 LoRA 프리셋
  aspect_ratio?: string;    // '16:9' | '9:16' | '1:1' | '4:3'
  resolution?: string;      // 'sd' | 'hd' | '1080' | '4k'
  duration?: number;        // 영상 길이 (초), default 5
  visual_priority?: 'normal' | 'high';  // high → Seedance fallback
  seed?: number;
  upscale_factor?: number;  // 2 | 4
}

interface GenerateResponse {
  id: string;
  status: 'queued' | 'processing' | 'done' | 'failed';
  provider: string;         // 'flux-klein' | 'hunyuan' | 'seedance' | 'realesrgan'
  output?: {
    url: string;
    width: number;
    height: number;
    duration?: number;
    format: string;
  };
  cost: number;             // 실제 비용 ($0 for local, API 단가 for remote)
  gpu_time_ms?: number;     // 로컬 처리 시간
  error?: string;
}
```

### 4.3 Provider Router 로직

```typescript
// src/create/providers/router.ts

class ProviderRouter {
  async route(req: GenerateRequest): Promise<string> {
    
    // 1. 영상 생성
    if (req.type === 'image-to-video') {
      if (req.visual_priority === 'high') {
        return 'seedance-remote';   // 핵심 씬 → Seedance API
      }
      return 'hunyuan-local';       // 일반 씬 → 로컬 HunyuanVideo
    }
    
    // 2. 업스케일
    if (req.type === 'upscale') {
      return 'realesrgan-local';
    }
    
    // 3. 이미지 생성 (기본)
    return 'flux-klein-local';
  }
}
```

### 4.4 Flux Klein Provider (ComfyUI 연동)

```typescript
// src/create/providers/flux-klein.ts

import WebSocket from 'ws';

interface ComfyUIConfig {
  host: string;           // default: localhost
  port: number;           // default: 8188
  loraPresets: Record<string, string>;  // 니치별 LoRA 매핑
}

class FluxKleinProvider implements GenerateProvider {
  private ws: WebSocket;
  private config: ComfyUIConfig;

  async generate(req: GenerateRequest): Promise<GenerateResponse> {
    // 1. ComfyUI 워크플로우 JSON 구성
    const workflow = this.buildWorkflow(req);
    
    // 2. WebSocket으로 ComfyUI에 전송
    const promptId = await this.queuePrompt(workflow);
    
    // 3. 완료 대기 (WebSocket 이벤트)
    const result = await this.waitForCompletion(promptId);
    
    // 4. 생성된 이미지를 RenderForge 에셋으로 저장
    const asset = await this.saveToServeAPI(result.images[0]);
    
    return {
      id: asset.id,
      status: 'done',
      provider: 'flux-klein',
      output: {
        url: asset.url,
        width: result.width,
        height: result.height,
        format: 'png'
      },
      cost: 0,
      gpu_time_ms: result.execution_time_ms
    };
  }

  private buildWorkflow(req: GenerateRequest): object {
    // 해상도 매핑
    const dims = this.resolveDimensions(req.aspect_ratio, req.resolution);
    
    // 니치별 LoRA 선택
    const lora = req.style ? this.config.loraPresets[req.style] : null;

    return {
      // ComfyUI API 형식 워크플로우
      "prompt": {
        "1": {  // KSampler
          "class_type": "KSampler",
          "inputs": {
            "model": ["2", 0],  // Flux Klein 4B 체크포인트
            "positive": ["3", 0],
            "negative": ["4", 0],
            "seed": req.seed ?? Math.floor(Math.random() * 2**32),
            "steps": 8,           // Klein은 4~8 스텝으로 충분
            "cfg": 3.5,
            "sampler_name": "euler",
            "scheduler": "normal",
            "denoise": 1.0,
            "latent_image": ["5", 0]
          }
        },
        "2": {  // CheckpointLoader
          "class_type": "CheckpointLoaderSimple",
          "inputs": {
            "ckpt_name": "flux2-klein-4b.safetensors"
          }
        },
        "3": {  // CLIP Text Encode (positive)
          "class_type": "CLIPTextEncode",
          "inputs": {
            "text": req.prompt,
            "clip": ["2", 1]
          }
        },
        "4": {  // CLIP Text Encode (negative)
          "class_type": "CLIPTextEncode",
          "inputs": {
            "text": req.negative_prompt || "",
            "clip": ["2", 1]
          }
        },
        "5": {  // Empty Latent Image
          "class_type": "EmptyLatentImage",
          "inputs": {
            "width": dims.width,
            "height": dims.height,
            "batch_size": 1
          }
        },
        // LoRA 로더 (조건부)
        ...(lora ? {
          "6": {
            "class_type": "LoraLoader",
            "inputs": {
              "model": ["2", 0],
              "clip": ["2", 1],
              "lora_name": lora,
              "strength_model": 0.8,
              "strength_clip": 0.8
            }
          }
        } : {}),
        "7": {  // VAE Decode
          "class_type": "VAEDecode",
          "inputs": {
            "samples": ["1", 0],
            "vae": ["2", 2]
          }
        },
        "8": {  // Save Image
          "class_type": "SaveImage",
          "inputs": {
            "images": ["7", 0],
            "filename_prefix": "rf_create"
          }
        }
      }
    };
  }

  private resolveDimensions(
    ratio: string = '16:9', 
    resolution: string = 'hd'
  ): { width: number; height: number } {
    const resMap: Record<string, number> = {
      'sd': 512, 'hd': 768, '1080': 1024, '4k': 2048
    };
    const base = resMap[resolution] || 1024;
    
    const ratioMap: Record<string, [number, number]> = {
      '16:9': [base, Math.round(base * 9/16)],
      '9:16': [Math.round(base * 9/16), base],
      '1:1': [base, base],
      '4:3': [base, Math.round(base * 3/4)],
      '4:5': [Math.round(base * 4/5), base],
    };
    
    const [w, h] = ratioMap[ratio] || ratioMap['16:9'];
    return { width: w, height: h };
  }
}
```

### 4.5 HunyuanVideo Provider

```typescript
// src/create/providers/hunyuan-local.ts

interface HunyuanConfig {
  host: string;           // default: localhost
  port: number;           // default: 8190
  enableStepDistill: boolean;  // default: true
  steps: number;          // default: 8 (step-distilled)
}

class HunyuanLocalProvider implements GenerateProvider {
  private config: HunyuanConfig;

  async generate(req: GenerateRequest): Promise<GenerateResponse> {
    // 1. 참조 이미지 경로 확인 (image-to-video는 소스 이미지 필요)
    const sourceImage = req.source_image_url;
    if (!sourceImage) {
      throw new Error('image-to-video requires source_image_url');
    }

    // 2. HunyuanVideo REST API 호출
    const response = await fetch(`http://${this.config.host}:${this.config.port}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: req.prompt,
        image_path: sourceImage,
        width: 848,             // 480p 기본 (업스케일 전)
        height: 480,
        num_frames: req.duration ? req.duration * 24 : 120,  // 5초 × 24fps
        num_inference_steps: this.config.steps,
        enable_step_distill: this.config.enableStepDistill,
        seed: req.seed ?? -1,
        cfg_scale: 7.0,
        enable_cpu_offload: true,
      })
    });

    const result = await response.json();

    // 3. 480p → 720p/1080p 업스케일 (선택)
    let finalOutput = result.video_path;
    if (req.resolution === '1080' || req.resolution === 'hd') {
      finalOutput = await this.upscale(result.video_path, 2);
    }

    // 4. 에셋 등록
    const asset = await this.saveToServeAPI(finalOutput);

    return {
      id: asset.id,
      status: 'done',
      provider: 'hunyuan-local',
      output: {
        url: asset.url,
        width: req.resolution === '1080' ? 1696 : 848,
        height: req.resolution === '1080' ? 960 : 480,
        duration: req.duration || 5,
        format: 'mp4'
      },
      cost: 0,
      gpu_time_ms: result.elapsed_ms
    };
  }

  private async upscale(videoPath: string, factor: number): Promise<string> {
    // Real-ESRGAN CLI 호출
    const outputPath = videoPath.replace('.mp4', `_${factor}x.mp4`);
    await execAsync(
      `realesrgan-ncnn-vulkan -i ${videoPath} -o ${outputPath} -s ${factor} -n realesrgan-x4plus-anime`
    );
    return outputPath;
  }
}
```

### 4.6 Seedance Remote Provider (Fallback)

```typescript
// src/create/providers/seedance-remote.ts

class SeedanceRemoteProvider implements GenerateProvider {
  private apiKey: string;
  private apiUrl: string;

  async generate(req: GenerateRequest): Promise<GenerateResponse> {
    // 기존 Seedance API 호출 로직 유지
    // visual_priority === 'high'인 씬만 이 provider로 라우팅됨
    
    const response = await fetch(this.apiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        prompt: req.prompt,
        image_url: req.source_image_url,
        duration: req.duration || 5,
        resolution: '1080p',
        style: 'fast',         // Fast tier ($0.022/초)
      })
    });

    const result = await response.json();
    const cost = (req.duration || 5) * 0.022;

    return {
      id: result.id,
      status: 'done',
      provider: 'seedance-remote',
      output: {
        url: result.video_url,
        width: 1920,
        height: 1080,
        duration: req.duration || 5,
        format: 'mp4'
      },
      cost: cost,
      gpu_time_ms: 0
    };
  }
}
```

### 4.7 GPU 메모리 매니저

```typescript
// src/create/gpu/memory-manager.ts

type ModelSlot = 'flux-klein' | 'hunyuan' | 'fish-speech' | null;

class GPUMemoryManager {
  private currentModel: ModelSlot = null;
  private isSwapping: boolean = false;
  private swapQueue: Array<{ model: ModelSlot; resolve: Function }> = [];

  // 모델별 VRAM 사용량 (GB)
  private readonly vramUsage: Record<string, number> = {
    'flux-klein': 8,
    'hunyuan': 14,
    'fish-speech': 2,
  };

  // 동시 로딩 가능한 조합
  private readonly compatiblePairs: ModelSlot[][] = [
    ['flux-klein', 'fish-speech'],    // 8 + 2 = 10GB ✅
    // ['hunyuan', 'fish-speech'],     // 14 + 2 = 16GB ⚠️ 가능하지만 빡빡
  ];

  async ensureLoaded(model: ModelSlot): Promise<void> {
    if (this.currentModel === model) return;
    
    if (this.isSwapping) {
      // 큐에 대기
      await new Promise(resolve => {
        this.swapQueue.push({ model, resolve });
      });
      return;
    }

    this.isSwapping = true;
    
    try {
      // 현재 모델 언로드 (Fish Speech는 항상 상주)
      if (this.currentModel && this.currentModel !== 'fish-speech') {
        await this.unloadModel(this.currentModel);
      }
      
      // 새 모델 로드
      await this.loadModel(model);
      this.currentModel = model;
    } finally {
      this.isSwapping = false;
      this.processSwapQueue();
    }
  }

  private async loadModel(model: ModelSlot): Promise<void> {
    switch (model) {
      case 'flux-klein':
        // ComfyUI에 모델 로드 명령
        await fetch('http://localhost:8188/api/load_model', {
          method: 'POST',
          body: JSON.stringify({ model: 'flux2-klein-4b.safetensors' })
        });
        break;
      case 'hunyuan':
        // HunyuanVideo 서버에 워밍업 요청
        await fetch('http://localhost:8190/warmup', { method: 'POST' });
        break;
    }
  }

  private async unloadModel(model: ModelSlot): Promise<void> {
    switch (model) {
      case 'flux-klein':
        await fetch('http://localhost:8188/api/free_memory', { method: 'POST' });
        break;
      case 'hunyuan':
        await fetch('http://localhost:8190/unload', { method: 'POST' });
        break;
    }
    // GC 대기
    await new Promise(r => setTimeout(r, 2000));
  }

  getStatus(): { model: ModelSlot; vram_used_gb: number; queue_depth: number } {
    return {
      model: this.currentModel,
      vram_used_gb: this.currentModel ? this.vramUsage[this.currentModel] || 0 : 0,
      queue_depth: this.swapQueue.length,
    };
  }
}
```

---

## 5. BullMQ 큐 설계

### 5.1 큐 구조

```typescript
// src/queue/create-jobs.ts

// 기존 render 큐와 별도로 create 큐 운영
const createQueue = new Queue('create', { connection: redis });

// 우선순위 레벨
enum CreatePriority {
  THUMBNAIL = 1,        // 썸네일 (업로드 직전 필요)
  VIDEO_HIGH = 2,       // 핵심 씬 영상 (Seedance API)
  IMAGE_LONGFORM = 3,   // 롱폼 이미지
  VIDEO_NORMAL = 4,     // 일반 영상 (HunyuanVideo)
  IMAGE_SHORTS = 5,     // Shorts 이미지
  UPSCALE = 6,          // 업스케일 (후순위)
}

// Worker concurrency (GPU 1개이므로 동시 처리 제한)
const createWorker = new Worker('create', processCreateJob, {
  connection: redis,
  concurrency: 1,        // GPU 작업은 반드시 1
  limiter: {
    max: 1,
    duration: 1000,       // 초당 1건 제한
  }
});
```

### 5.2 배치 처리 전략

N8N에서 주간 스크립트 생성 후, 이미지/영상을 한꺼번에 큐에 넣는 패턴:

```typescript
// POST /x/v1/render/batch 확장 — create 배치도 지원

interface CreateBatchRequest {
  items: GenerateRequest[];
  priority?: CreatePriority;
  callback_url?: string;      // 전체 완료 시 webhook
}

// 배치 최적화: 같은 모델 사용 작업을 묶어서 스왑 최소화
function optimizeBatch(items: GenerateRequest[]): GenerateRequest[] {
  const images = items.filter(i => i.type === 'text-to-image');
  const videos = items.filter(i => i.type === 'image-to-video');
  const upscales = items.filter(i => i.type === 'upscale');
  
  // 이미지 먼저 전부 처리 → 영상 전부 처리 → 업스케일
  // 이렇게 하면 모델 스왑이 최대 2번만 발생
  return [...images, ...videos, ...upscales];
}
```

---

## 6. 니치별 LoRA 전략

### 6.1 9티어 LoRA 프리셋

| 티어 | 니치 | LoRA 방향 | 학습 데이터 소스 |
|------|------|----------|----------------|
| T1 | Space/Astronomy | 우주, 성운, 행성 | NASA/ESA/JWST 이미지 |
| T2 | History | 역사적 장면, 고전 미술풍 | WikiArt, 역사 일러스트 |
| T3 | Science/Tech | 다이어그램, 인포그래픽 | 교육용 일러스트 |
| T4 | Finance/Business | 차트, 오피스, 도시 | 스톡 이미지 |
| T5 | Health/Wellness | 의료, 자연, 건강 | Pexels Health 카테고리 |
| T6 | Nature/Wildlife | 동물, 풍경, 자연 | Pexels/Unsplash Nature |
| T7 | True Crime/Mystery | 다크톤, 시네마틱 | 영화 스틸 스타일 |
| T8 | Education/Learning | 밝고 명확한 교육풍 | 교육 일러스트 |
| T9 | Entertainment/Pop | 팝컬처, 비비드 | 다양한 스타일 |

### 6.2 LoRA 학습 사양

```yaml
# kohya_ss 학습 설정
base_model: flux2-klein-4b.safetensors
training:
  resolution: 1024
  batch_size: 1
  epochs: 10
  learning_rate: 1e-4
  network_dim: 16          # rank (Klein은 작은 rank로 충분)
  network_alpha: 8
  optimizer: AdamW8bit
  mixed_precision: fp16
  
dataset:
  images_per_tier: 200~500장
  caption_method: florence2   # 자동 캡셔닝
  
estimated_per_lora:
  training_time: ~30분 (RTX 4090)
  file_size: ~50MB
  total_9_tiers: ~4.5시간, ~450MB
```

---

## 7. N8N 워크플로우 변경

### 7.1 현재 파이프라인 (Seedream/Seedance API)

```
WF-2 스크립트 → [Claude] → script.json
  ↓
WF-IMAGE → [Seedream API] → 이미지 24,024장
WF-VIDEO → [Seedance API] → 영상 1,248클립
WF-THUMB → [Ideogram API] → 썸네일 2,340장
  ↓
WF-RENDER → [RenderForge /edit/v1/render] → 최종 영상
  ↓
WF-UPLOAD → [YouTube API]
```

### 7.2 변경 후 파이프라인 (RenderForge 통합)

```
WF-2 스크립트 → [Claude] → script.json (visual_priority 태그 포함)
  ↓
WF-VISUAL → [RenderForge /create/v1/generate] ← 하나의 엔드포인트로 통합
  ├── type: "text-to-image" → Flux Klein (로컬)
  ├── type: "text-to-image" + style: "thumbnail" → Flux Klein + 텍스트 LoRA (로컬)
  ├── type: "image-to-video" + priority: "normal" → HunyuanVideo (로컬)
  └── type: "image-to-video" + priority: "high" → Seedance API (원격)
  ↓
WF-RENDER → [RenderForge /edit/v1/render] → 최종 영상 (변경 없음)
  ↓
WF-UPLOAD → [YouTube API] (변경 없음)
```

**핵심 변경점**: WF-IMAGE, WF-VIDEO, WF-THUMB **3개가 WF-VISUAL 1개로 통합**. RenderForge가 내부에서 Provider를 라우팅하므로 N8N은 단일 HTTP Request 노드만 사용.

### 7.3 N8N HTTP Request 노드 설정

```json
{
  "name": "RenderForge Create",
  "type": "n8n-nodes-base.httpRequest",
  "parameters": {
    "url": "http://renderforge:3000/create/v1/generate",
    "method": "POST",
    "headers": {
      "x-api-key": "{{ $env.RENDERFORGE_API_KEY }}"
    },
    "body": {
      "type": "={{ $json.visual_type }}",
      "prompt": "={{ $json.image_prompt_en }}",
      "negative_prompt": "ugly, blurry, low quality, text watermark",
      "style": "={{ $json.tier_id }}",
      "aspect_ratio": "={{ $json.aspect_ratio || '16:9' }}",
      "resolution": "hd",
      "visual_priority": "={{ $json.visual_priority || 'normal' }}",
      "duration": 5,
      "source_image_url": "={{ $json.source_image_url }}"
    }
  }
}
```

---

## 8. 품질 자동 검수 (QC)

### 8.1 이미지 QC

```typescript
// src/create/qc/image-qc.ts

interface ImageQCResult {
  pass: boolean;
  clip_score: number;       // 프롬프트-이미지 정합도 (0~1)
  aesthetic_score: number;   // 미적 품질 (0~10)
  nsfw_score: number;        // NSFW 감지 (0~1, >0.3 = reject)
  resolution_ok: boolean;
  issues: string[];
}

class ImageQC {
  // CLIP Score: 프롬프트와 이미지의 의미적 유사도
  // 임계값: 0.25 이상 통과 (Seedream 평균 ~0.30, Flux Klein ~0.27)
  private clipThreshold = 0.25;
  
  // Aesthetic Score: LAION aesthetic predictor
  // 임계값: 5.0 이상 통과
  private aestheticThreshold = 5.0;

  async evaluate(imagePath: string, prompt: string): Promise<ImageQCResult> {
    const [clip, aesthetic, nsfw] = await Promise.all([
      this.computeCLIPScore(imagePath, prompt),
      this.computeAestheticScore(imagePath),
      this.computeNSFWScore(imagePath),
    ]);

    const issues: string[] = [];
    if (clip < this.clipThreshold) issues.push(`CLIP score low: ${clip.toFixed(3)}`);
    if (aesthetic < this.aestheticThreshold) issues.push(`Aesthetic low: ${aesthetic.toFixed(1)}`);
    if (nsfw > 0.3) issues.push(`NSFW detected: ${nsfw.toFixed(2)}`);

    return {
      pass: issues.length === 0,
      clip_score: clip,
      aesthetic_score: aesthetic,
      nsfw_score: nsfw,
      resolution_ok: true,
      issues,
    };
  }
}

// 자동 재생성 로직
async function generateWithQC(
  req: GenerateRequest, 
  maxRetries: number = 3
): Promise<GenerateResponse> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const result = await provider.generate({
      ...req,
      seed: req.seed ? req.seed + attempt : undefined  // 시드 변경
    });
    
    const qc = await imageQC.evaluate(result.output.url, req.prompt);
    
    if (qc.pass) {
      return { ...result, qc };
    }
    
    logger.warn(`QC failed (attempt ${attempt + 1}/${maxRetries})`, { qc });
  }
  
  // 3회 실패 → Seedream API fallback (비상)
  logger.error('QC failed after max retries, falling back to Seedream API');
  return seedreamRemoteProvider.generate(req);
}
```

### 8.2 영상 QC

```typescript
// src/create/qc/video-qc.ts

class VideoQC {
  async evaluate(videoPath: string, prompt: string): Promise<VideoQCResult> {
    return {
      // 프레임 연속성 검사 (프레임 간 SSIM)
      temporal_consistency: await this.checkTemporalConsistency(videoPath),
      // 첫/끝 프레임 흑화면 검사
      black_frame_check: await this.checkBlackFrames(videoPath),
      // 모션 검출 (정지 영상 감지)
      motion_detected: await this.checkMotion(videoPath),
      // 프롬프트 정합도 (첫 프레임 CLIP Score)
      clip_score: await this.computeFirstFrameCLIP(videoPath, prompt),
    };
  }
}
```

---

## 9. Docker Compose 설정

```yaml
# docker/docker-compose.gpu.yml
# RenderForge + GPU 추론 통합 환경

version: '3.8'

services:
  # === RenderForge (메인) ===
  renderforge:
    build: .
    ports:
      - "3000:3000"
    environment:
      - PORT=3000
      - REDIS_URL=redis://redis:6379
      - CHROMIUM_WS=ws://chromium:3000
      - STORAGE_DRIVER=local
      - STORAGE_PATH=/data
      - DB_DRIVER=sqlite
      - AUTH_ENABLED=true
      - API_KEYS=${RENDERFORGE_API_KEYS}
      # GPU Provider 설정
      - COMFYUI_HOST=comfyui
      - COMFYUI_PORT=8188
      - HUNYUAN_HOST=hunyuan
      - HUNYUAN_PORT=8190
      - SEEDANCE_API_KEY=${SEEDANCE_API_KEY}
      - SEEDANCE_API_URL=${SEEDANCE_API_URL}
      # 품질 검수
      - QC_CLIP_THRESHOLD=0.25
      - QC_AESTHETIC_THRESHOLD=5.0
      - QC_MAX_RETRIES=3
    volumes:
      - renderforge-data:/data
    depends_on:
      - redis
      - chromium
      - comfyui
    restart: unless-stopped

  # === Chromium (렌더링용) ===
  chromium:
    image: browserless/chrome:latest
    environment:
      - CONNECTION_TIMEOUT=60000
      - MAX_CONCURRENT_SESSIONS=4
    restart: unless-stopped

  # === Redis (큐) ===
  redis:
    image: redis:7-alpine
    volumes:
      - redis-data:/data
    restart: unless-stopped

  # === ComfyUI (Flux 이미지 생성) ===
  comfyui:
    image: comfyui/comfyui:latest-cuda
    ports:
      - "8188:8188"
    environment:
      - NVIDIA_VISIBLE_DEVICES=0
    volumes:
      - comfyui-models:/root/ComfyUI/models
      - comfyui-output:/root/ComfyUI/output
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: 1
              capabilities: [gpu]
    restart: unless-stopped

  # === HunyuanVideo (영상 생성) ===
  hunyuan:
    build:
      context: ./hunyuan
      dockerfile: Dockerfile
    ports:
      - "8190:8190"
    environment:
      - NVIDIA_VISIBLE_DEVICES=0
      - ENABLE_STEP_DISTILL=true
      - ENABLE_CPU_OFFLOAD=true
      - DEFAULT_STEPS=8
    volumes:
      - hunyuan-models:/app/ckpts
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: 1
              capabilities: [gpu]
    restart: unless-stopped

  # === VoiceCore (TTS, 동일 GPU 공유) ===
  voicecore:
    image: fishaudio/fish-speech:latest-server-cuda
    ports:
      - "8080:8080"
    environment:
      - NVIDIA_VISIBLE_DEVICES=0
    volumes:
      - voicecore-models:/app/models
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: 1
              capabilities: [gpu]
    restart: unless-stopped

volumes:
  renderforge-data:
  redis-data:
  comfyui-models:
  comfyui-output:
  hunyuan-models:
  voicecore-models:
```

---

## 10. 환경변수 설정

```env
# .env.production

# RenderForge Core
PORT=3000
REDIS_URL=redis://redis:6379
CHROMIUM_WS=ws://chromium:3000
STORAGE_DRIVER=local
STORAGE_PATH=/data
DB_DRIVER=sqlite
AUTH_ENABLED=true
API_KEYS=rf_your_api_key_here

# GPU Providers
COMFYUI_HOST=comfyui
COMFYUI_PORT=8188
HUNYUAN_HOST=hunyuan
HUNYUAN_PORT=8190
VOICECORE_HOST=voicecore
VOICECORE_PORT=8080

# Seedance Remote (핵심 씬 fallback)
SEEDANCE_API_KEY=your_seedance_key
SEEDANCE_API_URL=https://api.seedance.com/v1

# Quality Control
QC_CLIP_THRESHOLD=0.25
QC_AESTHETIC_THRESHOLD=5.0
QC_NSFW_THRESHOLD=0.3
QC_MAX_RETRIES=3
QC_FALLBACK_TO_API=true

# GPU Memory Manager
GPU_SWAP_STRATEGY=on-demand     # on-demand | scheduled
GPU_DEFAULT_MODEL=flux-klein    # 기본 로딩 모델
GPU_FISH_SPEECH_RESIDENT=true   # TTS 모델 상시 상주

# LoRA Presets (tier_id → lora_filename)
LORA_T1_SPACE=space_astronomy_v1.safetensors
LORA_T2_HISTORY=history_classical_v1.safetensors
LORA_T3_SCIENCE=science_tech_v1.safetensors
LORA_T4_FINANCE=finance_business_v1.safetensors
LORA_T5_HEALTH=health_wellness_v1.safetensors
LORA_T6_NATURE=nature_wildlife_v1.safetensors
LORA_T7_CRIME=true_crime_dark_v1.safetensors
LORA_T8_EDUCATION=education_bright_v1.safetensors
LORA_T9_ENTERTAINMENT=pop_culture_v1.safetensors
```

---

## 11. 구현 로드맵

### Phase 0: PoC (1~2주)

- [ ] RunPod RTX 4090에 ComfyUI + Flux Klein 4B 설치
- [ ] HunyuanVideo 1.5 step-distilled 설치
- [ ] Beyond Orbit 1편 분량 테스트 (이미지 43장 + 영상 5클립)
- [ ] Seedream/Seedance 결과물과 A/B 비교 (시각적 + CLIP Score)
- [ ] GPU 시간 실측 → 비용 모델 검증
- [ ] Flux Klein vs Qwen Image 상업 라이선스 비교

### Phase 1: RenderForge 통합 (2~3주)

- [ ] `src/create/providers/` 디렉토리 구조 생성
- [ ] ProviderRouter 구현
- [ ] FluxKleinProvider (ComfyUI WebSocket 연동)
- [ ] HunyuanLocalProvider (REST API 래퍼)
- [ ] SeedanceRemoteProvider (기존 코드 리팩터)
- [ ] GPUMemoryManager 구현
- [ ] BullMQ create 큐 + 배치 최적화
- [ ] Docker Compose GPU 설정
- [ ] 단위 테스트 (Vitest)

### Phase 2: 품질 강화 (2~3주)

- [ ] ImageQC (CLIP Score + Aesthetic + NSFW)
- [ ] VideoQC (Temporal Consistency + Motion)
- [ ] 자동 재생성 로직 (3회 실패 → API fallback)
- [ ] 9티어 LoRA 학습 (각 200~500장, ~30분/개)
- [ ] LoRA 프리셋 매핑 + 자동 로딩
- [ ] 썸네일 텍스트 LoRA (Ideogram 대체)

### Phase 3: N8N 통합 + 프로덕션 (1~2주)

- [ ] WF-IMAGE + WF-VIDEO + WF-THUMB → WF-VISUAL 통합
- [ ] N8N HTTP Request 노드 엔드포인트 변경
- [ ] visual_priority 태그 WF-2 스크립트에 추가
- [ ] Prometheus 메트릭 대시보드 (생성 수, QC 통과율, GPU 사용률)
- [ ] 5ch Seed 환경에서 1주 실운영 테스트
- [ ] 비용 모니터링 → API fallback 비율 확인

### Phase 4: 스케일 (Scale1 진입 시)

- [ ] 실사용량 기반 RunPod vs 자체 서버 비교
- [ ] Scale1(90ch)에서 GPU 1대 충분 여부 검증
- [ ] 필요 시 GPU 2대 구성 (영상 전용 분리)
- [ ] LoRA 추가 학습 (실제 채널 영상 피드백 반영)

---

## 12. 비용 최종 요약

### 12.1 월간 비용 비교 (Scale2, 270ch)

| 항목 | 현재 (API) | VisualCore 통합 후 | 절감 |
|------|----------|-------------------|------|
| Seedream 이미지 (롱폼) | $481 | $0 (Flux 로컬) | $481 |
| Seedream 이미지 (Shorts) | $360 | $0 (Flux 로컬) | $360 |
| Seedance 영상 (롱폼) | $137 | $27 (20% API fallback) | $110 |
| Ideogram 썸네일 | $94 | $0 (Flux + LoRA 로컬) | $94 |
| Shotstack 렌더링 | ~~$1,249~~ | $0 (RenderForge) | ~~$1,249~~ ✅ |
| GPU RunPod | $0 | $23 | -$23 |
| **비주얼+렌더링 합계** | **$2,321** | **$50** | **$2,271 (98%)** |

### 12.2 3년 TCO

| | API 전면 | VisualCore 통합 |
|---|---------|---------------|
| Y1 | $4,200 | $150 |
| Y2 | $15,600 | $400 |
| Y3 | $27,852 | $600 |
| **3년 합계** | **$47,652** | **$1,150** |
| **절감** | | **$46,502 (97.6%)** |

### 12.3 전체 270ch 인프라 절감 총괄

| 프로젝트 | 대체 대상 | 월 절감 (Scale2) | 연 절감 | 상태 |
|---------|----------|-----------------|--------|------|
| **RenderForge** | Shotstack | $1,249 | $14,988 | ✅ 완료 |
| **VoiceCore** | ElevenLabs | ~$2,000 | ~$24,000 | ✅ 설계 완료 |
| **ProfileCore** | ML+SmartProxy | ~$1,250 | ~$15,000 | ✅ 설계 완료 |
| **VisualCore** | Seedream+Seedance+Ideogram | $1,045 | $12,540 | 📋 본 문서 |
| Claude Max 하이브리드 | Claude API | $1,420 | $17,040 | ✅ 전략 확정 |
| **합계** | | **$6,964/월** | **$83,568/년** | |

---

## 13. 리스크 및 완화

| 리스크 | 확률 | 영향 | 완화 |
|--------|------|------|------|
| Flux Klein 품질 부족 | 중 | 시청 유지율 하락 | QC 자동 검수 + API fallback, Qwen Image 대안 |
| FLUX.2 Dev 라이선스 이슈 | 중 | 상업적 사용 불가 | Klein 4B(Apache 2.0) 사용, 또는 BFL 상업 라이선스 구매 |
| HunyuanVideo 모션 부자연스러움 | 중 | 시청자 이탈 | visual_priority=high 씬은 Seedance 유지 |
| GPU OOM (VRAM 부족) | 낮 | 렌더 실패 | Memory Manager + offloading + 스왑 큐 |
| ComfyUI 불안정 | 낮 | 이미지 생성 실패 | 자동 재시작 + health check + fallback |
| LoRA 품질 편차 | 중 | 채널간 품질 차이 | PoC에서 티어별 검증, 부족하면 LoRA 없이 운영 |
| RunPod 가용성 | 낮 | 생산 중단 | Spot → On-demand fallback, 자체 서버 전환 대비 |
| 유튜브 AI 탐지 강화 | 중 | 채널 제재 | LLM-ism 제거 동일 적용, 다양한 LoRA/시드, AI 공시 준수 |
