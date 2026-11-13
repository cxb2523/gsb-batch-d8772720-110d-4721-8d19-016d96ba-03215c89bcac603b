import os
import sys
import argparse
import json
import urllib.request
import cv2
import insightface
from insightface.app import FaceAnalysis

# Define standard URLs for downloading models if they are missing
INSWAPPER_URLS = [
    "https://huggingface.co/ezioruan/inswapper_128.onnx/resolve/main/inswapper_128.onnx",
    "https://huggingface.co/ModelsLab/inswapper/resolve/main/inswapper/inswapper_128.onnx",
    "https://huggingface.co/greyisabest/inswapper_128.onnx/resolve/main/inswapper_128.onnx"
]

def progress_bar(block_num, block_size, total_size):
    """Callback for urllib.request.urlretrieve to print download progress"""
    read_so_far = block_num * block_size
    if total_size > 0:
        percent = min(100, (read_so_far * 100) // total_size)
        sys.stdout.write(f"\rDownloading model: {percent}% ({read_so_far // (1024*1024)}MB / {total_size // (1024*1024)}MB)")
        sys.stdout.flush()
    else:
        sys.stdout.write(f"\rDownloading model: {read_so_far // (1024*1024)}MB")
        sys.stdout.flush()

def main():
    parser = argparse.ArgumentParser(description="LIYA Face Swap Engine (CPU Mode)")
    parser.add_argument("--source", required=False, help="Path to source face image")
    parser.add_argument("--target", required=True, help="Path to target image")
    parser.add_argument("--output", required=True, help="Path to save swapped output image")
    parser.add_argument("--mappings", required=False, help="JSON string or file path containing face mappings: target_index -> source_image_path")
    args = parser.parse_args()

    if not args.source and not args.mappings:
        print("[ERROR] Either --source or --mappings argument is required.", file=sys.stderr, flush=True)
        sys.exit(1)

    print("[INFO] Initializing LIYA Face Swap Processor...", flush=True)

    # Establish model paths
    script_dir = os.path.dirname(os.path.abspath(__file__))
    models_dir = os.path.join(script_dir, "models")
    os.makedirs(models_dir, exist_ok=True)
    inswapper_path = os.path.join(models_dir, "inswapper_128.onnx")

    # Download Inswapper model if missing
    if not os.path.exists(inswapper_path):
        success = False
        for url in INSWAPPER_URLS:
            print(f"[INFO] Inswapper model not found locally. Trying download from {url}...", flush=True)
            try:
                urllib.request.urlretrieve(url, inswapper_path, progress_bar)
                print("\n[INFO] Model downloaded successfully!", flush=True)
                success = True
                break
            except Exception as e:
                print(f"\n[WARNING] Failed to download from {url}: {e}", file=sys.stderr, flush=True)
        
        if not success:
            print("[ERROR] Failed to download model from all sources.", file=sys.stderr, flush=True)
            sys.exit(1)

    # Load target image
    print("[INFO] Loading target image...", flush=True)
    if not os.path.exists(args.target):
        print(f"[ERROR] Target image not found: {args.target}", file=sys.stderr, flush=True)
        sys.exit(1)
    target_img = cv2.imread(args.target)
    if target_img is None:
        print("[ERROR] Failed to read target image. Make sure it is a valid image.", file=sys.stderr, flush=True)
        sys.exit(1)

    # Initialize Face Analysis (Detection & Embeddings)
    print("[INFO] Loading Face Detection and Recognition models (buffalo_l)...", flush=True)
    try:
        app = FaceAnalysis(name='buffalo_l', providers=['CPUExecutionProvider'])
        app.prepare(ctx_id=0, det_size=(320, 320))
    except Exception as e:
        print(f"[ERROR] Failed to initialize FaceAnalysis: {e}", file=sys.stderr, flush=True)
        sys.exit(1)

    # Load Swapper model
    print("[INFO] Loading Inswapper model...", flush=True)
    try:
        swapper = insightface.model_zoo.get_model(inswapper_path, providers=['CPUExecutionProvider'])
    except Exception as e:
        print(f"[ERROR] Failed to load inswapper model: {e}", file=sys.stderr, flush=True)
        sys.exit(1)

    # Detect target faces
    print("[INFO] Detecting faces in target image...", flush=True)
    target_faces = app.get(target_img)
    if not target_faces:
        print("[ERROR] No face detected in the TARGET image.", file=sys.stderr, flush=True)
        sys.exit(1)

    # Sort target faces from left to right (X coordinate of bounding box)
    target_faces = sorted(target_faces, key=lambda x: x.bbox[0])
    print(f"[INFO] Found {len(target_faces)} face(s) in target image.", flush=True)

    result_img = target_img.copy()

    # Case 1: Custom mappings provided (multiple selective swaps)
    if args.mappings:
        mappings = None
        if os.path.exists(args.mappings):
            try:
                with open(args.mappings, 'r') as f:
                    mappings = json.load(f)
            except Exception as e:
                print(f"[ERROR] Failed to load mappings file: {e}", file=sys.stderr, flush=True)
                sys.exit(1)
        else:
            try:
                mappings = json.loads(args.mappings)
            except Exception as e:
                print(f"[ERROR] Failed to parse mappings JSON: {e}", file=sys.stderr, flush=True)
                sys.exit(1)

        print(f"[INFO] Processing multi-face swaps with mappings: {mappings}", flush=True)
        for target_idx_str, source_path in mappings.items():
            try:
                target_idx = int(target_idx_str)
            except ValueError:
                print(f"[WARNING] Invalid target index string: '{target_idx_str}'. Skipping.", file=sys.stderr, flush=True)
                continue

            if target_idx < 0 or target_idx >= len(target_faces):
                print(f"[WARNING] Target index {target_idx} is out of bounds (0 to {len(target_faces)-1}). Skipping.", file=sys.stderr, flush=True)
                continue

            if not os.path.exists(source_path):
                print(f"[WARNING] Source face file not found: {source_path}. Skipping.", file=sys.stderr, flush=True)
                continue

            source_img = cv2.imread(source_path)
            if source_img is None:
                print(f"[WARNING] Failed to read source image: {source_path}. Skipping.", file=sys.stderr, flush=True)
                continue

            source_faces = app.get(source_img)
            if not source_faces:
                print(f"[WARNING] No face detected in source image: {source_path}. Skipping.", file=sys.stderr, flush=True)
                continue

            # Sort source faces by size, pick the largest (main subject)
            source_face = max(source_faces, key=lambda x: (x.bbox[2]-x.bbox[0]) * (x.bbox[3]-x.bbox[1]))
            target_face = target_faces[target_idx]

            print(f"[INFO] Swapping target face {target_idx} with source {source_path}...", flush=True)
            result_img = swapper.get(result_img, target_face, source_face, paste_back=True)

    # Case 2: Standard single-swap fallback
    else:
        if not os.path.exists(args.source):
            print(f"[ERROR] Source face image not found: {args.source}", file=sys.stderr, flush=True)
            sys.exit(1)

        source_img = cv2.imread(args.source)
        if source_img is None:
            print("[ERROR] Failed to read source image.", file=sys.stderr, flush=True)
            sys.exit(1)

        source_faces = app.get(source_img)
        if not source_faces:
            print("[ERROR] No face detected in the SOURCE image.", file=sys.stderr, flush=True)
            sys.exit(1)

        # Swap only the single largest (main) face in the target image
        largest_target_face = max(target_faces, key=lambda x: (x.bbox[2]-x.bbox[0]) * (x.bbox[3]-x.bbox[1]))
        source_face = max(source_faces, key=lambda x: (x.bbox[2]-x.bbox[0]) * (x.bbox[3]-x.bbox[1]))

        print("[INFO] Swapping largest face in target (single swap mode)...", flush=True)
        result_img = swapper.get(result_img, largest_target_face, source_face, paste_back=True)

    # Save output image
    print(f"[INFO] Saving output to {args.output}...", flush=True)
    output_dir = os.path.dirname(args.output)
    if output_dir:
        os.makedirs(output_dir, exist_ok=True)

    success = cv2.imwrite(args.output, result_img)
    if success:
        print("[SUCCESS] Face swap completed successfully!", flush=True)
    else:
        print("[ERROR] Failed to write output image.", file=sys.stderr, flush=True)
        sys.exit(1)

if __name__ == "__main__":
    main()
