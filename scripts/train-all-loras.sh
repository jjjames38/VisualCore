#!/bin/bash
# ═══════════════════════════════════════════════
#  VisualCore — 9티어 + 썸네일 LoRA 일괄 학습
# ═══════════════════════════════════════════════
#  Usage: ./scripts/train-all-loras.sh
#  Prerequisites:
#    - kohya-ss/sd-scripts 설치
#    - 학습 데이터: ./lora_data/{tier_id}/ (이미지 + .txt 캡션)
#    - Flux Klein 4B 체크포인트
#  예상 시간: RTX 4090에서 ~5시간 (10개 LoRA)
# ═══════════════════════════════════════════════

set -euo pipefail

BASE_MODEL="${BASE_MODEL:-./models/flux-klein/flux2-klein-4b.safetensors}"
DATA_DIR="${DATA_DIR:-./lora_data}"
OUTPUT_DIR="${OUTPUT_DIR:-./loras}"
KOHYA_DIR="${KOHYA_DIR:-./sd-scripts}"

mkdir -p "$OUTPUT_DIR"

# ─── 티어 정의 ───
TIERS=(
  "t1_space"
  "t2_history"
  "t3_science"
  "t4_finance"
  "t5_health"
  "t6_nature"
  "t7_crime"
  "t8_education"
  "t9_entertainment"
  "thumbnail"
)

NAMES=(
  "space_astronomy_v1"
  "history_classical_v1"
  "science_tech_v1"
  "finance_business_v1"
  "health_wellness_v1"
  "nature_wildlife_v1"
  "true_crime_dark_v1"
  "education_bright_v1"
  "pop_culture_v1"
  "text_rendering_v1"
)

echo "═══════════════════════════════════════════════"
echo "  VisualCore LoRA Batch Training"
echo "  Base model: $BASE_MODEL"
echo "  Data dir:   $DATA_DIR"
echo "  Output dir: $OUTPUT_DIR"
echo "  Tiers:      ${#TIERS[@]}"
echo "═══════════════════════════════════════════════"

# ─── 자동 캡셔닝 (캡션 파일이 없는 경우) ───
caption_tier() {
  local tier_path="$1"
  local has_captions=false
  
  for f in "$tier_path"/*.txt; do
    if [ -f "$f" ]; then
      has_captions=true
      break
    fi
  done
  
  if [ "$has_captions" = false ]; then
    echo "  📝 캡션 파일 없음 — Florence-2 자동 캡셔닝 실행..."
    python3 << 'PYEOF'
import os, sys
from transformers import AutoProcessor, AutoModelForCausalLM
from PIL import Image

tier_path = sys.argv[1]
model = AutoModelForCausalLM.from_pretrained("microsoft/Florence-2-large", trust_remote_code=True)
processor = AutoProcessor.from_pretrained("microsoft/Florence-2-large", trust_remote_code=True)

for img_file in sorted(os.listdir(tier_path)):
    if not img_file.lower().endswith(('.png', '.jpg', '.jpeg', '.webp')):
        continue
    img_path = os.path.join(tier_path, img_file)
    txt_path = os.path.splitext(img_path)[0] + '.txt'
    if os.path.exists(txt_path):
        continue
    
    image = Image.open(img_path).convert("RGB")
    inputs = processor(text="<DETAILED_CAPTION>", images=image, return_tensors="pt")
    generated = model.generate(**inputs, max_new_tokens=200)
    caption = processor.batch_decode(generated, skip_special_tokens=True)[0]
    
    with open(txt_path, 'w') as f:
        f.write(caption)
    print(f"    {img_file} → {caption[:60]}...")
PYEOF
    echo "  ✅ 캡셔닝 완료"
  fi
}

# ─── 학습 루프 ───
total_start=$(date +%s)

for i in "${!TIERS[@]}"; do
  tier="${TIERS[$i]}"
  name="${NAMES[$i]}"
  tier_path="$DATA_DIR/$tier"
  
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  [$((i+1))/${#TIERS[@]}] Training: $name ($tier)"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  
  # 데이터 존재 확인
  if [ ! -d "$tier_path" ]; then
    echo "  ⚠️ SKIP — 데이터 없음: $tier_path"
    continue
  fi
  
  img_count=$(find "$tier_path" -type f \( -name "*.png" -o -name "*.jpg" -o -name "*.jpeg" -o -name "*.webp" \) | wc -l)
  echo "  이미지: ${img_count}장"
  
  if [ "$img_count" -lt 10 ]; then
    echo "  ⚠️ SKIP — 이미지 10장 미만"
    continue
  fi
  
  # 캡셔닝
  caption_tier "$tier_path"
  
  # 학습 실행
  start=$(date +%s)
  
  cd "$KOHYA_DIR"
  accelerate launch train_network.py \
    --pretrained_model_name_or_path="$BASE_MODEL" \
    --train_data_dir="$tier_path" \
    --output_dir="$OUTPUT_DIR" \
    --output_name="$name" \
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
    --cache_latents \
    --enable_bucket
  cd -
  
  end=$(date +%s)
  elapsed=$((end - start))
  
  echo "  ✅ $name 완료 (${elapsed}초)"
  ls -lh "$OUTPUT_DIR/${name}.safetensors" 2>/dev/null || echo "  ⚠️ 출력 파일 확인 필요"
done

total_end=$(date +%s)
total_elapsed=$((total_end - total_start))

echo ""
echo "═══════════════════════════════════════════════"
echo "  전체 학습 완료: ${total_elapsed}초 ($((total_elapsed/60))분)"
echo ""
echo "  출력 파일:"
ls -lh "$OUTPUT_DIR"/*.safetensors 2>/dev/null
echo ""
echo "  ComfyUI에 복사:"
echo "  cp $OUTPUT_DIR/*.safetensors /root/ComfyUI/models/loras/"
echo "═══════════════════════════════════════════════"
