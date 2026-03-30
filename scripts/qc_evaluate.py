#!/usr/bin/env python3
"""
VisualCore — QC Image Evaluation Script

Evaluates image quality via CLIP score, aesthetic score, and NSFW detection.
Called from Node.js via execFile (no shell) for security.

Usage:
  python3 scripts/qc_evaluate.py <image_path> <prompt>

Output:
  JSON object with scores: { clip_score, aesthetic_score, nsfw_score }
  Scores are -1 when the model fails to load (non-fatal).
"""

import sys
import json


def evaluate(image_path: str, prompt: str) -> dict:
    scores = {}

    # CLIP Score
    try:
        from transformers import CLIPProcessor, CLIPModel
        from PIL import Image

        model = CLIPModel.from_pretrained("openai/clip-vit-base-patch32")
        processor = CLIPProcessor.from_pretrained("openai/clip-vit-base-patch32")
        image = Image.open(image_path)
        inputs = processor(text=[prompt], images=image, return_tensors="pt", padding=True)
        outputs = model(**inputs)
        logits = outputs.logits_per_image
        scores["clip_score"] = float(logits.softmax(dim=1)[0][0])
    except Exception as e:
        scores["clip_score"] = -1
        scores["clip_error"] = str(e)

    # Aesthetic Score (LAION aesthetic predictor)
    try:
        from transformers import pipeline

        aesthetic = pipeline("image-classification", model="cafeai/cafe_aesthetic")
        result = aesthetic(image_path)
        for r in result:
            if r["label"] == "aesthetic":
                scores["aesthetic_score"] = round(r["score"] * 10, 2)
                break
        else:
            scores["aesthetic_score"] = 5.0
    except Exception as e:
        scores["aesthetic_score"] = -1
        scores["aesthetic_error"] = str(e)

    # NSFW Detection
    try:
        from transformers import pipeline as nsfw_pipeline

        nsfw = nsfw_pipeline("image-classification", model="Falconsai/nsfw_image_detection")
        result = nsfw(image_path)
        for r in result:
            if r["label"] == "nsfw":
                scores["nsfw_score"] = round(r["score"], 4)
                break
        else:
            scores["nsfw_score"] = 0.0
    except Exception as e:
        scores["nsfw_score"] = -1
        scores["nsfw_error"] = str(e)

    return scores


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(json.dumps({"error": "Usage: qc_evaluate.py <image_path> <prompt>"}))
        sys.exit(1)

    image_path = sys.argv[1]
    prompt = sys.argv[2]
    result = evaluate(image_path, prompt)
    print(json.dumps(result))
