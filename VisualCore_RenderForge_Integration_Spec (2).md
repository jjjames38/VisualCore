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

---

## 14. 모델 다운로드 및 초기 설정

### 14.1 Flux Klein 4B (이미지 생성)

```bash
# HuggingFace에서 모델 다운로드 (~8GB)
# 대상 경로: comfyui-models 볼륨 → /root/ComfyUI/models/checkpoints/
huggingface-cli download black-forest-labs/FLUX.2-klein \
  --include "flux2-klein-4b.safetensors" \
  --local-dir ./models/checkpoints/

# VAE (공용)
huggingface-cli download black-forest-labs/FLUX.2-klein \
  --include "ae.safetensors" \
  --local-dir ./models/vae/

# CLIP Text Encoder
huggingface-cli download black-forest-labs/FLUX.2-klein \
  --include "text_encoder*" \
  --local-dir ./models/clip/
```

**파일 크기 합계**: ~10GB (체크포인트 8GB + VAE 1GB + CLIP 1GB)

**라이선스 확인**:
- Klein 4B = **Apache 2.0** → 상업적 사용 완전 자유 ✅
- Klein 9B = FLUX.2-dev Non-Commercial → 별도 라이선스 필요 ⚠️
- **270ch 시스템은 상업적 사용이므로 반드시 4B(Apache 2.0)를 사용**

### 14.2 HunyuanVideo 1.5 (영상 생성)

```bash
# 전체 모델 다운로드 (~20GB)
# 대상 경로: hunyuan-models 볼륨 → /app/ckpts/
huggingface-cli download tencent/HunyuanVideo-1.5 \
  --local-dir ./ckpts/

# 필수 체크포인트 구조:
# ckpts/
# ├── transformer/
# │   ├── 480p_i2v/              ← Image-to-Video (메인 사용)
# │   ├── 480p_t2v/              ← Text-to-Video
# │   ├── 480p_t2v_distilled/    ← Step-distilled (빠른 추론)
# │   ├── 720p_i2v_distilled/    ← 720p step-distilled
# │   └── 720p_sr_distilled/     ← Super-resolution
# ├── vae/
# └── text_encoder/
```

**파일 크기 합계**: ~20GB  
**라이선스**: Tencent 오픈소스 (상업적 사용 가능) ✅  
**SynthID**: 없음 ✅

### 14.3 Real-ESRGAN (업스케일)

```bash
# ncnn-vulkan 바이너리 (GPU 가속, 별도 Python 불필요)
wget https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-ubuntu.zip
unzip realesrgan-ncnn-vulkan-*.zip -d /usr/local/bin/

# 또는 Python 패키지
pip install realesrgan --break-system-packages
```

### 14.4 ComfyUI 초기 설정

```bash
# ComfyUI 컨테이너 기동 후:
docker exec -it comfyui bash

# 커스텀 노드 설치 (LoRA, 고급 샘플러)
cd /root/ComfyUI/custom_nodes/
git clone https://github.com/ltdrdata/ComfyUI-Manager.git

# 모델 경로 확인
ls /root/ComfyUI/models/checkpoints/  # flux2-klein-4b.safetensors
ls /root/ComfyUI/models/loras/         # 티어별 LoRA 파일
ls /root/ComfyUI/models/vae/           # ae.safetensors

# API 모드 확인 (--listen 플래그 필요)
# docker-compose.gpu.yml에서 CLI_ARGS=--listen 0.0.0.0 --port 8188 으로 설정됨

# 테스트: API 정상 응답 확인
curl http://localhost:8188/system_stats
# → {"system": {"os": "posix", ...}, "devices": [{"name": "cuda:0", ...}]}
```

### 14.5 QC Python 의존성

```bash
# RenderForge 컨테이너 또는 별도 QC 컨테이너에서:
pip install --break-system-packages \
  torch torchvision \
  transformers \
  Pillow \
  open-clip-torch

# CLIP 모델 사전 다운로드 (첫 실행 시 자동 다운로드되지만, 오프라인 환경 대비)
python3 -c "
from transformers import CLIPProcessor, CLIPModel
CLIPModel.from_pretrained('openai/clip-vit-base-patch32')
CLIPProcessor.from_pretrained('openai/clip-vit-base-patch32')
print('CLIP model cached')
"

# Aesthetic predictor (선택)
python3 -c "
from transformers import pipeline
pipeline('image-classification', model='cafeai/cafe_aesthetic')
print('Aesthetic model cached')
"
```

---

## 15. RunPod 인스턴스 설정

### 15.1 스펙 선택

| 항목 | 권장 | 비고 |
|------|------|------|
| GPU | **RTX 4090 (24GB)** | 최적 가성비, $0.34/hr |
| vCPU | 8+ | CPU offloading 시 중요 |
| RAM | 32GB+ | HunyuanVideo offloading 대응 |
| 디스크 | 100GB+ | 모델 체크포인트 + 생성물 |
| OS | Ubuntu 22.04 | CUDA 12.1+ |

### 15.2 RunPod 설정 절차

```bash
# 1. RunPod 대시보드에서 Pod 생성
#    Template: RunPod PyTorch 2.1 (CUDA 12.1)
#    GPU: RTX 4090
#    Volume: 100GB Persistent

# 2. SSH 접속 후 Docker 설치
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER

# 3. NVIDIA Container Toolkit 설치
distribution=$(. /etc/os-release;echo $ID$VERSION_ID) \
  && curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg \
  && curl -s -L https://nvidia.github.io/libnvidia-container/$distribution/libnvidia-container.list | \
    sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | \
    sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
sudo apt-get update && sudo apt-get install -y nvidia-container-toolkit
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker

# 4. Docker Compose 설치
sudo curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
sudo chmod +x /usr/local/bin/docker-compose

# 5. RenderForge 클론 + VisualCore 머지
git clone https://github.com/jjjames38/renderforge.git
cd renderforge
# (VisualCore 파일들 머지 — Section 16 참조)

# 6. 모델 다운로드 (Section 14 참조)
# 7. .env 설정 (Section 10 참조)

# 8. 기동
docker compose -f docker/docker-compose.gpu.yml up -d

# 9. 헬스체크
curl http://localhost:3000/health       # RenderForge
curl http://localhost:8188/system_stats  # ComfyUI
curl http://localhost:8190/health        # HunyuanVideo
curl http://localhost:8080/health        # VoiceCore
```

### 15.3 RunPod vs 자체 서버 전환 판단 기준 (12개월 시점)

| 지표 | RunPod 유지 | 자체 서버 전환 |
|------|-----------|-------------|
| 월 GPU 시간 | <200hr | >200hr |
| 월 비용 | <$70 | >$70 → 자체가 유리 |
| 필요 가동률 | <30% | >30% → 자체가 유리 |
| 네트워크 지연 민감도 | 낮음 | 높음 → 자체가 유리 |

**자체 서버 전환 시 비용**:
- RTX 4090 구매: ~$1,600 (중고 ~$1,200)
- 호스트 PC: ~$800 (중고 워크스테이션)
- 월 전기/인터넷: ~$75
- BEP: 약 8~12개월

---

## 16. RenderForge 머지 상세 절차

### 16.1 파일 복사

```bash
cd /path/to/renderforge

# Provider 시스템
mkdir -p src/create/providers src/create/gpu src/create/qc src/create/queue
cp visualcore/src/create/providers/*.ts src/create/providers/
cp visualcore/src/create/gpu/*.ts src/create/gpu/
cp visualcore/src/create/qc/*.ts src/create/qc/
cp visualcore/src/create/queue/*.ts src/create/queue/

# Docker 파일
cp visualcore/docker/docker-compose.gpu.yml docker/
cp -r visualcore/docker/hunyuan/ docker/hunyuan/

# 테스트
cp visualcore/tests/visualcore.test.ts tests/

# 환경변수 머지
cat visualcore/.env.template >> .env
```

### 16.2 import 경로 수정

각 TypeScript 파일에서 logger import를 RenderForge 실제 경로로 변경:

```typescript
// 변경 전 (visualcore 독립)
import { logger } from '../../config/logger.js';

// 변경 후 (RenderForge 내부)
import { logger } from '../../config/logger.js';  // RenderForge의 실제 logger
// 또는
import { logger } from '../../../config/logger.js';  // depth에 따라 조정
```

### 16.3 package.json 의존성 추가

```bash
pnpm add ws                  # ComfyUI WebSocket 통신
# bullmq, ioredis는 이미 RenderForge에 있음
```

### 16.4 기존 Create API 연결

RenderForge의 `src/api/create/` 라우트에서 ProviderRouter를 초기화하고 연결:

```typescript
// src/api/create/routes.ts (기존 파일에 추가)

import { ProviderRouter } from '../../create/providers/router.js';
import { GPUMemoryManager } from '../../create/gpu/memory-manager.js';
import { QCPipeline } from '../../create/qc/pipeline.js';
import { getConfig } from '../../config/index.js';

// 초기화 (서버 부트스트랩 시 1회)
const config = getConfig();  // .env에서 VisualCore 설정 로드
const gpu = new GPUMemoryManager({ fishSpeechResident: config.gpu.fish_speech_resident });
const router = new ProviderRouter(config, gpu);
const qc = new QCPipeline(config.qc);

// 기존 POST /create/v1/generate 핸들러에서:
// 기존: seedreamApi.generate(req)
// 변경: 아래로 교체

const provider = await router.route(req);
const result = await qc.generateWithQC(req, provider, router.getProvider('seedance-remote'));
```

### 16.5 Git 커밋

```bash
git add -A
git commit -m "feat: VisualCore GPU 추론 통합

- Flux Klein 4B 로컬 이미지 생성 (ComfyUI WebSocket)
- HunyuanVideo 1.5 로컬 영상 생성 (REST API)
- Seedance API fallback (핵심 씬 20%)
- Real-ESRGAN 업스케일
- GPU Memory Manager (VRAM 스왑)
- QC 파이프라인 (CLIP + Aesthetic + 자동 재생성)
- BullMQ create 큐 + 배치 최적화
- Docker Compose GPU 전체 스택

월 비용: $1,072 → $50 (95% 절감)"
git push origin main
```

---

## 17. LoRA 학습 절차

### 17.1 학습 데이터 수집

| 티어 | 데이터 소스 | 수집 방법 | 목표 장수 |
|------|-----------|----------|---------|
| T1 Space | NASA APOD, ESA Gallery, JWST MAST | NASA Images API + 수동 큐레이션 | 300장 |
| T2 History | WikiArt, Met Museum Open Access | API 다운로드 + 시대별 필터 | 300장 |
| T3 Science | Wikimedia Commons (Science) | 키워드 검색 + 수동 필터 | 250장 |
| T4 Finance | Pexels (Business), Unsplash | API 검색 "office, chart, finance" | 200장 |
| T5 Health | Pexels (Health), Unsplash | API 검색 "wellness, medical" | 200장 |
| T6 Nature | Pexels (Nature), iNaturalist | API 검색 "wildlife, landscape" | 300장 |
| T7 Crime | Unsplash (Dark), Pexels (City Night) | 다크톤 필터 + 시네마틱 | 200장 |
| T8 Education | Pexels (School), OpenClipart | 밝은 톤 교육 일러스트 | 200장 |
| T9 Entertainment | Pexels, Unsplash (Pop Culture) | 비비드 컬러 필터 | 200장 |
| **Thumbnail** | 유튜브 썸네일 레퍼런스 (텍스트 포함) | 수동 수집 + 스크린샷 | 200장 |

**총 ~2,350장, 수집 예상 시간: 8~12시간 (API 자동 + 수동 큐레이션)**

### 17.2 자동 캡셔닝

```bash
# Florence-2 기반 자동 캡셔닝 (GPU에서)
pip install transformers Pillow --break-system-packages

python3 << 'EOF'
import os, json
from transformers import AutoProcessor, AutoModelForCausalLM
from PIL import Image

model = AutoModelForCausalLM.from_pretrained("microsoft/Florence-2-large", trust_remote_code=True)
processor = AutoProcessor.from_pretrained("microsoft/Florence-2-large", trust_remote_code=True)

def caption_image(path):
    image = Image.open(path).convert("RGB")
    inputs = processor(text="<DETAILED_CAPTION>", images=image, return_tensors="pt")
    generated = model.generate(**inputs, max_new_tokens=200)
    return processor.batch_decode(generated, skip_special_tokens=True)[0]

# 각 티어 폴더 처리
for tier_dir in sorted(os.listdir("./lora_data")):
    tier_path = f"./lora_data/{tier_dir}"
    if not os.path.isdir(tier_path):
        continue
    for img_file in os.listdir(tier_path):
        if not img_file.lower().endswith(('.png', '.jpg', '.jpeg', '.webp')):
            continue
        img_path = f"{tier_path}/{img_file}"
        caption = caption_image(img_path)
        txt_path = img_path.rsplit('.', 1)[0] + '.txt'
        with open(txt_path, 'w') as f:
            f.write(caption)
        print(f"  {img_file} → {caption[:80]}...")
EOF
```

### 17.3 Kohya LoRA 학습 실행

```bash
# kohya_ss 설치 (RTX 4090에서)
git clone https://github.com/kohya-ss/sd-scripts.git
cd sd-scripts
pip install -r requirements.txt --break-system-packages

# 학습 스크립트 (1 티어당 ~30분)
accelerate launch train_network.py \
  --pretrained_model_name_or_path="./models/flux2-klein-4b.safetensors" \
  --train_data_dir="./lora_data/t1_space/" \
  --output_dir="./loras/" \
  --output_name="space_astronomy_v1" \
  --network_module="networks.lora" \
  --network_dim=16 \
  --network_alpha=8 \
  --resolution=1024 \
  --train_batch_size=1 \
  --max_train_epochs=10 \
  --learning_rate=1e-4 \
  --optimizer_type="AdamW8bit" \
  --mixed_precision="fp16" \
  --save_precision="fp16" \
  --caption_extension=".txt" \
  --cache_latents

# 9티어 + 썸네일 = 10개 LoRA
# 예상 총 학습 시간: ~5시간 (RTX 4090)
# 예상 총 파일 크기: ~500MB (50MB × 10)
```

### 17.4 LoRA 배치 학습 자동화

```bash
#!/bin/bash
# train_all_loras.sh

TIERS=("t1_space" "t2_history" "t3_science" "t4_finance" "t5_health" \
       "t6_nature" "t7_crime" "t8_education" "t9_entertainment" "thumbnail")
NAMES=("space_astronomy_v1" "history_classical_v1" "science_tech_v1" \
       "finance_business_v1" "health_wellness_v1" "nature_wildlife_v1" \
       "true_crime_dark_v1" "education_bright_v1" "pop_culture_v1" \
       "text_rendering_v1")

for i in "${!TIERS[@]}"; do
  echo "=== Training LoRA: ${NAMES[$i]} (${TIERS[$i]}) ==="
  accelerate launch train_network.py \
    --pretrained_model_name_or_path="./models/flux2-klein-4b.safetensors" \
    --train_data_dir="./lora_data/${TIERS[$i]}/" \
    --output_dir="./loras/" \
    --output_name="${NAMES[$i]}" \
    --network_module="networks.lora" \
    --network_dim=16 --network_alpha=8 \
    --resolution=1024 --train_batch_size=1 \
    --max_train_epochs=10 --learning_rate=1e-4 \
    --optimizer_type="AdamW8bit" --mixed_precision="fp16" \
    --save_precision="fp16" --caption_extension=".txt" \
    --cache_latents
  echo "=== Done: ${NAMES[$i]} ==="
done

echo "All LoRAs trained. Copy to ComfyUI:"
echo "  cp ./loras/*.safetensors /root/ComfyUI/models/loras/"
```

---

## 18. PoC 테스트 계획

### 18.1 테스트 대상

Beyond Orbit (T2-Ch#001, Space/Astronomy) 1편 분량:
- 롱폼 1편 (~10분, 43장 이미지 + 5 영상 클립 + 1 썸네일)

### 18.2 A/B 비교 매트릭스

| 항목 | A (Seedream/Seedance API) | B (Flux Klein/HunyuanVideo 로컬) | 비교 기준 |
|------|-------------------------|-------------------------------|----------|
| 이미지 1~43 | Seedream 4.0, $0.035/장 | Flux Klein 4B, $0/장 | 육안 + CLIP Score |
| 영상 1~5 | Seedance Fast, $0.022/초 | HunyuanVideo 1.5, $0 | 육안 + VBench 지표 |
| 썸네일 | Ideogram, $0.04/장 | Flux Klein + 텍스트 LoRA, $0 | 텍스트 가독성 + 미적 |
| 총 비용 | ~$2.50 | ~$0 (GPU 시간 무시 수준) | — |
| 총 시간 | ~2분 (API 대기) | ~50초 (이미지) + ~2분 (영상) | — |

### 18.3 합격 기준

| 지표 | 합격 기준 | 불합격 시 대응 |
|------|----------|-------------|
| 이미지 CLIP Score 평균 | ≥ 0.25 (Seedream 대비 90%+) | LoRA 추가 학습 또는 Qwen Image 전환 |
| 이미지 육안 평가 | 3~6초 Ken Burns에서 체감 차이 없음 | 해상도 업그레이드 또는 모델 변경 |
| 영상 모션 자연스러움 | 보조 씬에서 허용 가능 | HunyuanVideo → Wan 2.2 전환 검토 |
| 썸네일 텍스트 가독성 | 72pt+ 텍스트 정확히 렌더링 | Ideogram API 유지 (월 $94) |
| GPU 시간 실측 | 마스터 플랜 추정치의 ±20% 이내 | 비용 모델 재산정 |
| OOM 발생 | 0회 | Memory Manager 설정 조정 |

### 18.4 PoC 실행 명령

```bash
# 1. Beyond Orbit 테스트 프롬프트 준비
cat > /tmp/poc_prompts.json << 'EOF'
{
  "images": [
    {"prompt": "Hubble deep field photograph, thousands of distant galaxies in vibrant colors against the black void of space, ultra detailed 8k", "style": "t1_space"},
    {"prompt": "Close-up of a neutron star surface, intense magnetic field lines visible, blue-white glow, scientific visualization", "style": "t1_space"},
    {"prompt": "International Space Station orbiting Earth at golden hour, solar panels reflecting sunlight, Earth's atmosphere glowing blue", "style": "t1_space"}
  ],
  "videos": [
    {"prompt": "Slow zoom into a spiral galaxy, stars twinkling, nebula clouds drifting", "source_image": "img_001.png", "priority": "normal"},
    {"prompt": "Dramatic camera orbit around a black hole with accretion disk", "source_image": "img_015.png", "priority": "high"}
  ],
  "thumbnail": {
    "prompt": "YouTube thumbnail, bold text 'THE DEATH OF STARS' over exploding supernova, dramatic lighting, cinematic composition", "is_thumbnail": true
  }
}
EOF

# 2. A 세트 생성 (API)
# → 기존 N8N 워크플로우로 생성

# 3. B 세트 생성 (로컬)
curl -X POST http://localhost:3000/create/v1/generate \
  -H "Content-Type: application/json" \
  -H "x-api-key: $RENDERFORGE_API_KEY" \
  -d '{
    "type": "text-to-image",
    "prompt": "Hubble deep field photograph, thousands of distant galaxies...",
    "style": "t1_space",
    "aspect_ratio": "16:9",
    "resolution": "hd"
  }'

# 4. CLIP Score 비교
python3 compare_quality.py --dir_a ./poc/api/ --dir_b ./poc/local/ --prompt_file /tmp/poc_prompts.json
```

---

## 19. N8N 워크플로우 마이그레이션

### 19.1 현재 워크플로우 구조

```
WF-IMAGE (Seedream API)
├── HTTP Request → Seedream /v1/images/generate
├── Wait for callback
├── Download image
└── Save to Supabase media_assets

WF-VIDEO (Seedance API)
├── HTTP Request → Seedance /v1/video/generate
├── Wait for callback
├── Download video
└── Save to Supabase media_assets

WF-THUMB (Ideogram API)
├── HTTP Request → Ideogram /v1/generate
├── Download image
└── Save to Supabase media_assets
```

### 19.2 마이그레이션 후: WF-VISUAL (통합)

```
WF-VISUAL (RenderForge Create API)
├── Split by visual_type (Switch 노드)
│   ├── image → HTTP Request → RenderForge /create/v1/generate (type: text-to-image)
│   ├── video → HTTP Request → RenderForge /create/v1/generate (type: image-to-video)
│   ├── thumbnail → HTTP Request → RenderForge /create/v1/generate (type: text-to-image, is_thumbnail: true)
│   └── upscale → HTTP Request → RenderForge /create/v1/generate (type: upscale)
├── Poll status (GET /create/v1/generate/:id) — 5초 간격
├── QC 결과 확인 (response.qc.pass === true)
│   ├── true → Save to Supabase
│   └── false → Alert (Slack/Discord)
└── Merge → 다음 WF-RENDER로 전달
```

### 19.3 N8N 변경 최소화 전략

기존 WF-IMAGE, WF-VIDEO, WF-THUMB의 HTTP Request 노드에서 **URL만 변경**하면 됩니다:

```
변경 전: https://api.seedream.com/v1/images/generate
변경 후: http://renderforge:3000/create/v1/generate

변경 전: https://api.seedance.com/v1/video/generate
변경 후: http://renderforge:3000/create/v1/generate

변경 전: https://api.ideogram.com/v1/generate
변경 후: http://renderforge:3000/create/v1/generate
```

Request body만 RenderForge 스키마에 맞게 조정:

```json
// 변경 전 (Seedream)
{ "prompt": "...", "model": "seedream-4.0", "size": "1024x576" }

// 변경 후 (RenderForge)
{ "type": "text-to-image", "prompt": "...", "aspect_ratio": "16:9", "resolution": "hd", "style": "t1_space" }
```

### 19.4 WF-2 스크립트에 visual_priority 태그 추가

스크립트 Pass2에서 각 씬에 visual_priority를 자동 부여하는 로직:

```
[Pass2 검수 시 추가 규칙]
- 감정 피크 씬 (emotion: [awe, dread, revelation]) → visual_priority: "high"
- 인물 클로즈업 씬 → visual_priority: "high"
- 복잡한 카메라 워크 (orbit, dolly zoom) → visual_priority: "high"
- 기타 모든 씬 → visual_priority: "normal"
- 스틸 이미지 (Ken Burns) → visual_priority: 불필요 (이미지는 항상 로컬)
```

---

## 20. 모니터링 및 비용 추적

### 20.1 Prometheus 메트릭 (RenderForge /metrics 확장)

```
# 기존 RenderForge 메트릭에 추가할 항목:

# 생성 수 (provider별)
visualcore_generations_total{provider="flux-klein", type="text-to-image", status="done"} 1234
visualcore_generations_total{provider="hunyuan-local", type="image-to-video", status="done"} 56
visualcore_generations_total{provider="seedance-remote", type="image-to-video", status="done"} 12

# GPU 시간 (밀리초 히스토그램)
visualcore_gpu_time_ms{provider="flux-klein"} 850
visualcore_gpu_time_ms{provider="hunyuan-local"} 19200

# QC 통과율
visualcore_qc_pass_rate{type="text-to-image"} 0.94
visualcore_qc_retries_total{type="text-to-image"} 45

# API fallback 횟수
visualcore_api_fallback_total{provider="seedance-remote"} 12
visualcore_api_fallback_total{provider="seedream-remote"} 3

# 비용 추적 (USD)
visualcore_cost_usd_total{provider="seedance-remote"} 27.50
visualcore_cost_usd_total{provider="flux-klein"} 0
visualcore_cost_usd_total{provider="hunyuan-local"} 0

# GPU VRAM 상태
visualcore_gpu_vram_used_gb 8.0
visualcore_gpu_swap_total 156
visualcore_gpu_swap_queue_depth 0

# 모델 스왑 시간
visualcore_gpu_swap_duration_ms{from="flux-klein", to="hunyuan"} 11000
```

### 20.2 월간 비용 리포트

N8N 스케줄 (매월 1일) → RenderForge /metrics 조회 → 비용 집계 → Slack 알림:

```
📊 VisualCore 월간 비용 리포트 (2026-04)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
이미지 생성: 26,364장 (Flux 로컬)     $0.00
영상 생성:   1,000클립 (Hunyuan 로컬)  $0.00
영상 생성:     248클립 (Seedance API)  $27.28
썸네일:      2,340장 (Flux 로컬)       $0.00
업스케일:    1,000클립 (ESRGAN 로컬)    $0.00
GPU RunPod:  67시간 × $0.34           $22.78
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
합계:                                 $50.06
API 대비 절감:                        $1,021.94 (95.3%)

QC 통과율:  이미지 94% | 영상 89%
API fallback: 이미지 3회 | 영상 0회
GPU 스왑:    156회 (평균 11초)
```

---

## 21. 마스터 플랜 재무제표 반영사항

### 21.1 수정 대상 파일

- `US_YouTube_270ch_Master_Plan_v2.0.docx` — 비주얼 비용 섹션 업데이트
- `US_YouTube_270ch_3Year_Financial_v2.0.xlsx` — API 비용 행 수정
- `US_YouTube_270ch_CONTINUATION_v2.0.json` — visualcore 키 추가

### 21.2 재무제표 변경 요약

| 항목 | 현재 v2.0 | VisualCore 반영 후 | 차이 |
|------|----------|-------------------|------|
| **Seedream+Seedance+Ideogram (Y1)** | ~$600 | ~$50 (20% API만) | -$550 |
| **Shotstack (Y1)** | ~$1,556 | **$0** (RenderForge) | -$1,556 |
| **GPU RunPod (Y1 신규)** | $0 | ~$100 | +$100 |
| **Y1 총 비용** | ~$26,600 | ~$24,594 | **-$2,006** |
| **초기 필요자금** | ~$18,000-22,000 | **~$16,000-20,000** | -$2,000 |
| **Y3 월 비용 (Scale2)** | ~$4,700 | ~$3,400 | **-$1,300** |
| **Y3 월 영업이익** | ~$40,000 | **~$41,300** | +$1,300 |

### 21.3 CONTINUATION JSON 추가 키

```json
{
  "visualcore": {
    "status": "spec_complete_code_ready",
    "github": "github.com/jjjames38/renderforge (내장 모듈)",
    "models": {
      "image": "Flux.2 Klein 4B (Apache 2.0)",
      "video": "HunyuanVideo 1.5 step-distilled (Tencent 오픈소스)",
      "upscale": "Real-ESRGAN",
      "fallback_video": "Seedance API (20% 핵심씬만)"
    },
    "monthly_cost_scale2": "$50 (API $1,072 대비 95% 절감)",
    "gpu": "RunPod RTX 4090 $0.34/hr, 67hr/월",
    "integration": "RenderForge Create API 내장, ProviderRouter 라우팅",
    "qc": "CLIP Score + Aesthetic + 자동 재생성 3회 + API fallback",
    "lora": "9티어 + 썸네일 = 10개 LoRA, Kohya 학습",
    "n8n": "WF-IMAGE+WF-VIDEO+WF-THUMB → WF-VISUAL 통합",
    "next": [
      "PoC: Beyond Orbit 1편 A/B 테스트",
      "Flux Klein vs Qwen Image 라이선스 최종 결정",
      "9티어 LoRA 학습 데이터 수집",
      "N8N WF-VISUAL 워크플로우 생성",
      "마스터 플랜 재무제표 v2.1 반영"
    ]
  }
}
```

### 21.4 GitHub 리포 전략

| 옵션 | 설명 | 권장 |
|------|------|------|
| A. RenderForge에 직접 머지 | `src/create/` 하위에 통합 | **✅ 권장** |
| B. 별도 VisualCore 리포 | github.com/jjjames38/VisualCore | ❌ 불필요 (별도 서비스 아님) |

RenderForge가 이미 Create API를 가지고 있고, VisualCore는 그 백엔드만 교체하는 것이므로 **별도 리포 없이 RenderForge에 머지**하는 것이 맞습니다.
