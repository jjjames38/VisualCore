#!/bin/bash
# ═══════════════════════════════════════════════
#  VisualCore — PoC A/B 테스트
# ═══════════════════════════════════════════════
#  Beyond Orbit 1편 분량으로 API vs 로컬 품질 비교
#
#  테스트 항목:
#    - 이미지 3장 (Seedream vs Flux Klein)
#    - 영상 2클립 (Seedance vs HunyuanVideo)
#    - 썸네일 1장 (Ideogram vs Flux + LoRA)
#
#  합격 기준:
#    - 이미지 CLIP Score ≥ 0.25
#    - 이미지 육안 평가: Ken Burns 3~6초에서 체감 차이 없음
#    - 영상: 보조 씬에서 허용 가능한 모션
#    - 썸네일: 텍스트 가독성 확보
#    - OOM: 0회
# ═══════════════════════════════════════════════

set -euo pipefail

RF_HOST="${RF_HOST:-http://localhost:3000}"
RF_API_KEY="${RF_API_KEY:-rf_test_key}"
OUTPUT_DIR="${OUTPUT_DIR:-./poc_results}"

mkdir -p "$OUTPUT_DIR"/{api,local,comparison}

echo "═══════════════════════════════════════════════"
echo "  VisualCore PoC A/B Test"
echo "  RenderForge: $RF_HOST"
echo "  Output: $OUTPUT_DIR"
echo "═══════════════════════════════════════════════"

# ─── Helper: Generate & download ───
generate() {
  local label="$1"
  local body="$2"
  local output_path="$3"
  
  echo "  ▸ Generating: $label"
  
  # Submit job
  local response
  response=$(curl -s -X POST "$RF_HOST/create/v1/generate" \
    -H "Content-Type: application/json" \
    -H "x-api-key: $RF_API_KEY" \
    -d "$body")
  
  local job_id
  job_id=$(echo "$response" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))")
  
  if [ -z "$job_id" ]; then
    echo "    ❌ Failed to submit: $response"
    return 1
  fi
  
  echo "    Job: $job_id"
  
  # Poll status
  local max_wait=300
  local waited=0
  while [ $waited -lt $max_wait ]; do
    local status_resp
    status_resp=$(curl -s "$RF_HOST/create/v1/generate/$job_id" \
      -H "x-api-key: $RF_API_KEY")
    
    local status
    status=$(echo "$status_resp" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))")
    
    if [ "$status" = "done" ]; then
      local url
      url=$(echo "$status_resp" | python3 -c "import sys,json; print(json.load(sys.stdin).get('output',{}).get('url',''))")
      local gpu_ms
      gpu_ms=$(echo "$status_resp" | python3 -c "import sys,json; print(json.load(sys.stdin).get('gpu_time_ms',0))")
      local cost
      cost=$(echo "$status_resp" | python3 -c "import sys,json; print(json.load(sys.stdin).get('cost',0))")
      local provider
      provider=$(echo "$status_resp" | python3 -c "import sys,json; print(json.load(sys.stdin).get('provider',''))")
      
      echo "    ✅ Done (${gpu_ms}ms, \$${cost}, ${provider})"
      
      # Download if URL is remote
      if [[ "$url" == http* ]]; then
        curl -s -o "$output_path" "$url"
      else
        cp "$url" "$output_path" 2>/dev/null || echo "    ⚠️ Could not copy output"
      fi
      
      # Save metadata
      echo "$status_resp" | python3 -m json.tool > "${output_path}.meta.json"
      return 0
    elif [ "$status" = "failed" ]; then
      local error
      error=$(echo "$status_resp" | python3 -c "import sys,json; print(json.load(sys.stdin).get('error','unknown'))")
      echo "    ❌ Failed: $error"
      return 1
    fi
    
    sleep 5
    waited=$((waited + 5))
  done
  
  echo "    ❌ Timeout after ${max_wait}s"
  return 1
}

# ═══════════════════════════════════════════════
#  TEST 1: 이미지 생성 (3장)
# ═══════════════════════════════════════════════

echo ""
echo "━━━ TEST 1: 이미지 생성 (Flux Klein 로컬) ━━━"

PROMPTS=(
  "Hubble deep field photograph, thousands of distant galaxies in vibrant colors against the black void of space, ultra detailed 8k astrophotography"
  "Close-up of a neutron star surface with intense magnetic field lines visible, blue-white glow emanating from the poles, scientific visualization"
  "International Space Station orbiting Earth at golden hour, solar panels reflecting warm sunlight, thin blue atmosphere line visible on the horizon"
)

for i in "${!PROMPTS[@]}"; do
  generate "Image $((i+1))" \
    "{
      \"type\": \"text-to-image\",
      \"prompt\": \"${PROMPTS[$i]}\",
      \"style\": \"t1_space\",
      \"aspect_ratio\": \"16:9\",
      \"resolution\": \"hd\"
    }" \
    "$OUTPUT_DIR/local/img_$(printf '%02d' $((i+1))).png"
done

# ═══════════════════════════════════════════════
#  TEST 2: 영상 생성 (2클립)
# ═══════════════════════════════════════════════

echo ""
echo "━━━ TEST 2-A: 영상 — 일반 (HunyuanVideo 로컬) ━━━"

generate "Video normal" \
  "{
    \"type\": \"image-to-video\",
    \"prompt\": \"Slow cinematic zoom into a spiral galaxy, millions of stars twinkling gently, nebula clouds drifting\",
    \"source_image_url\": \"$OUTPUT_DIR/local/img_01.png\",
    \"visual_priority\": \"normal\",
    \"duration\": 5
  }" \
  "$OUTPUT_DIR/local/vid_01_normal.mp4"

echo ""
echo "━━━ TEST 2-B: 영상 — 핵심씬 (Seedance API) ━━━"

generate "Video high-priority" \
  "{
    \"type\": \"image-to-video\",
    \"prompt\": \"Dramatic camera orbit around a massive black hole with glowing accretion disk, gravitational lensing visible, particles swirling\",
    \"source_image_url\": \"$OUTPUT_DIR/local/img_02.png\",
    \"visual_priority\": \"high\",
    \"duration\": 5
  }" \
  "$OUTPUT_DIR/local/vid_02_high.mp4"

# ═══════════════════════════════════════════════
#  TEST 3: 썸네일 (텍스트 렌더링)
# ═══════════════════════════════════════════════

echo ""
echo "━━━ TEST 3: 썸네일 (Flux + 텍스트 LoRA) ━━━"

generate "Thumbnail" \
  "{
    \"type\": \"text-to-image\",
    \"prompt\": \"YouTube thumbnail, bold white text THE DEATH OF STARS over dramatic exploding supernova, deep space background, cinematic lighting, vibrant orange and blue contrast\",
    \"is_thumbnail\": true,
    \"style\": \"t1_space\",
    \"aspect_ratio\": \"16:9\",
    \"resolution\": \"1080\"
  }" \
  "$OUTPUT_DIR/local/thumb_01.png"

# ═══════════════════════════════════════════════
#  결과 요약
# ═══════════════════════════════════════════════

echo ""
echo "═══════════════════════════════════════════════"
echo "  PoC 테스트 완료"
echo "═══════════════════════════════════════════════"
echo ""
echo "  생성된 파일:"
ls -lh "$OUTPUT_DIR/local/" 2>/dev/null
echo ""
echo "  메타데이터 (.meta.json):"
ls "$OUTPUT_DIR/local/"*.meta.json 2>/dev/null | wc -l
echo "개"
echo ""
echo "  다음 단계:"
echo "  1. $OUTPUT_DIR/local/ 의 결과물을 육안 평가"
echo "  2. Seedream/Seedance API 결과물(있으면)과 나란히 비교"
echo "  3. CLIP Score 비교:"
echo "     python3 scripts/compare-quality.py \\"
echo "       --local $OUTPUT_DIR/local/ \\"
echo "       --api $OUTPUT_DIR/api/"
echo ""
echo "  합격 기준:"
echo "  ✓ 이미지 CLIP Score ≥ 0.25"
echo "  ✓ Ken Burns 3~6초에서 체감 차이 없음"
echo "  ✓ 영상 모션 자연스러움 (보조씬 기준)"
echo "  ✓ 썸네일 텍스트 가독성"
echo "  ✓ OOM 발생 0회"
echo "═══════════════════════════════════════════════"
