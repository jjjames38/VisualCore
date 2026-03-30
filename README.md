# 🎨 VisualCore — Local Vision Engine

Seedream/Seedance 비용 0원화. Flux(T2I) + HunyuanVideo(I2V) 기반 로컬 GPU 이미지·영상 생성 엔진.

## Tech Stack
- Flux Klein 4B (Text-to-Image)
- HunyuanVideo 1.5 (Image-to-Video)
- ESRGAN (Upscaling)
- BullMQ + Redis (Job Queue)
- RunPod RTX 4090

## Roadmap & TODO

### Immediate (Next)
- [ ] BullMQ 직렬화 큐(Sequential Queue) 도입 — VoiceCore와 동시 실행 시 OOM 방지
- [ ] Flux 이미지 품질 A/B 테스트 — 채널 Tier별 최적 프롬프트 탬플릿 확정
- [ ] RenderForge Create API `/create/v1/generate` 연동 검증

### Near-term
- [ ] ESRGAN 업스케일링 파이프라인 자동화 (4K 출력 지원)
- [ ] VoiceCore 순차 처리 — VRAM 충돌 없는 실행 순서 확립
- [ ] Shorts 전용 9:16 비율 이미지 자동 생성

### Medium-term
- [ ] LoRA 스타일 파인튜닝 — 채널 Tier별 고유 시각 아이덴티티 학습
- [ ] 대용량 배치 렌더링 최적화 (1시간 내 270개 에피소드)

### Long-term
- [ ] WebGL 기반 GPU 가속 렌더 파이프라인 연구
- [ ] 오픈소스 릴리즈 — B2B SaaS 모델 전환
