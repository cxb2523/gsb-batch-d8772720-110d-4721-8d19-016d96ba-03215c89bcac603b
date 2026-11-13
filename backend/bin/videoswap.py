import os
import sys
import argparse
import json
import subprocess
import cv2
import numpy as np
import insightface
from insightface.app import FaceAnalysis
from concurrent.futures import ThreadPoolExecutor

def compute_similarity(emb1, emb2):
    """Compute cosine similarity between two normalized embeddings"""
    return np.dot(emb1, emb2)

def process_single_frame(frame, app, swapper, active_mappings):
    """Process a single frame for face swapping"""
    try:
        faces = app.get(frame)
        if faces:
            for detected_face in faces:
                best_match = None
                highest_sim = -1.0

                for mapping in active_mappings:
                    sim = compute_similarity(detected_face.normed_embedding, mapping["ref_embedding"])
                    if sim > highest_sim:
                        highest_sim = sim
                        best_match = mapping

                if highest_sim > 0.6 and best_match is not None:
                    frame = swapper.get(frame, detected_face, best_match["source_face"], paste_back=True)
    except Exception as e:
        print(f"[WARNING] Error processing frame: {e}", file=sys.stderr, flush=True)
    return frame

def main():
    parser = argparse.ArgumentParser(description="LIYA High-Speed Video Multi-Face Swap Processor")
    parser.add_argument("--target", required=True, help="Path to input target video")
    parser.add_argument("--output", required=True, help="Path to save swapped output video")
    parser.add_argument("--mappings", required=True, help="JSON string or file path containing face mappings: target_index -> source_image_path")
    args = parser.parse_args()

    if not os.path.exists(args.target):
        print(f"[ERROR] Target video not found: {args.target}", file=sys.stderr, flush=True)
        sys.exit(1)

    # Establish model paths
    script_dir = os.path.dirname(os.path.abspath(__file__))
    models_dir = os.path.join(script_dir, "models")
    inswapper_path = os.path.join(models_dir, "inswapper_128.onnx")

    if not os.path.exists(inswapper_path):
        print("[ERROR] inswapper_128.onnx model is missing. Please download it or run image swap first.", file=sys.stderr, flush=True)
        sys.exit(1)

    print("[INFO] Initializing High-Speed Face Analysis models...", flush=True)
    try:
        app = FaceAnalysis(name='buffalo_l', providers=['CPUExecutionProvider'])
        app.prepare(ctx_id=0, det_size=(320, 320))
    except Exception as e:
        print(f"[ERROR] Failed to initialize FaceAnalysis: {e}", file=sys.stderr, flush=True)
        sys.exit(1)

    print("[INFO] Loading Inswapper model...", flush=True)
    try:
        swapper = insightface.model_zoo.get_model(inswapper_path, providers=['CPUExecutionProvider'])
    except Exception as e:
        print(f"[ERROR] Failed to load inswapper model: {e}", file=sys.stderr, flush=True)
        sys.exit(1)

    converted_temp_target = None
    temp_silent_path = None
    try:
        if args.target.lower().endswith('.webp'):
            print("[INFO] Target is WebP animation. Converting to GIF with PIL for processing...", flush=True)
            try:
                from PIL import Image
                converted_temp_target = args.target + ".conv.gif"
                im = Image.open(args.target)
                im.save(converted_temp_target, save_all=True, loop=0)
                args.target = converted_temp_target
            except Exception as e:
                print(f"[WARNING] PIL conversion for WebP failed: {e}", file=sys.stderr, flush=True)

        # Open video to read properties and first frame
        cap = cv2.VideoCapture(args.target)
        if not cap.isOpened():
            print("[ERROR] Failed to open target video.", file=sys.stderr, flush=True)
            sys.exit(1)

        fps = cap.get(cv2.CAP_PROP_FPS)
        if fps <= 0 or np.isnan(fps):
            fps = 25.0
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

        print(f"\n=======================================================", flush=True)
        print(f"   TARGET VIDEO LOADED SUCCESSFULLY! ", flush=True)
        print(f"   TOTAL FRAMES IN THIS VIDEO: {total_frames}", flush=True)
        print(f"=======================================================\n", flush=True)
        print(f"[INFO] Video Properties: {width}x{height} @ {fps:.2f} FPS. Total frames: {total_frames}", flush=True)

        # Read frames to extract reference target faces
        first_frame = None
        first_frame_faces = None
        max_scan_frames = 60
        scanned_frames = 0
        
        print("[INFO] Scanning initial frames for reference faces...", flush=True)
        while scanned_frames < max_scan_frames:
            ret, frame = cap.read()
            if not ret:
                break
                
            scanned_frames += 1
            faces = app.get(frame)
            if faces:
                first_frame_faces = faces
                first_frame = frame
                break

        if not first_frame_faces:
            print(f"[ERROR] No faces detected in the first {max_scan_frames} frames of the video.", file=sys.stderr, flush=True)
            cap.release()
            sys.exit(1)

        # Sort reference faces left-to-right (by x1 bounding box coordinate)
        first_frame_faces = sorted(first_frame_faces, key=lambda x: x.bbox[0])
        print(f"[INFO] Found {len(first_frame_faces)} reference face(s) in frame {scanned_frames}.", flush=True)

        # Parse mappings JSON
        mappings = None
        if os.path.exists(args.mappings):
            try:
                with open(args.mappings, 'r') as f:
                    mappings = json.load(f)
            except Exception as e:
                print(f"[ERROR] Failed to load mappings file: {e}", file=sys.stderr, flush=True)
                cap.release()
                sys.exit(1)
        else:
            try:
                mappings = json.loads(args.mappings)
            except Exception as e:
                print(f"[ERROR] Failed to parse mappings JSON: {e}", file=sys.stderr, flush=True)
                cap.release()
                sys.exit(1)

        # Load source face embeddings for mapped target indices
        active_mappings = []
        for target_idx_str, source_path in mappings.items():
            try:
                target_idx = int(target_idx_str)
            except ValueError:
                print(f"[WARNING] Invalid target index string: '{target_idx_str}'. Skipping.", file=sys.stderr, flush=True)
                continue

            if target_idx < 0 or target_idx >= len(first_frame_faces):
                print(f"[WARNING] Target index {target_idx} is out of bounds. Skipping.", file=sys.stderr, flush=True)
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

            # Use largest face from source image
            source_face = max(source_faces, key=lambda x: (x.bbox[2]-x.bbox[0]) * (x.bbox[3]-x.bbox[1]))
            target_ref_face = first_frame_faces[target_idx]

            active_mappings.append({
                "target_idx": target_idx,
                "ref_embedding": target_ref_face.normed_embedding,
                "source_face": source_face
            })
            print(f"[INFO] Configured mapping: Target Person {target_idx+1} -> {source_path}", flush=True)

        if not active_mappings:
            print("[ERROR] No active face mappings configured.", file=sys.stderr, flush=True)
            cap.release()
            sys.exit(1)

        # Reset video capture to frame 0 for full process
        cap.set(cv2.CAP_PROP_POS_FRAMES, 0)

        # Create temporary path for silent output video
        output_dir = os.path.dirname(args.output)
        if output_dir:
            os.makedirs(output_dir, exist_ok=True)
        temp_silent_path = os.path.join(output_dir, f"temp_silent_{int(os.path.basename(args.output).split('_')[-1].split('.')[0]) if '_' in args.output else 'silent'}.mp4")

        # Initialize VideoWriter (mp4v codec)
        fourcc = cv2.VideoWriter_fourcc(*'mp4v')
        out = cv2.VideoWriter(temp_silent_path, fourcc, fps, (width, height))

        print("[INFO] Processing video frames with parallel multi-threading...", flush=True)

        num_workers = min(4, os.cpu_count() or 4)
        batch_size = num_workers * 2
        processed_frames_count = 0

        while True:
            batch_frames = []
            for _ in range(batch_size):
                ret, frame = cap.read()
                if not ret:
                    break
                batch_frames.append(frame)

            if not batch_frames:
                break

            # Process current batch in parallel across CPU cores
            with ThreadPoolExecutor(max_workers=num_workers) as executor:
                processed_batch = list(executor.map(
                    lambda f: process_single_frame(f, app, swapper, active_mappings),
                    batch_frames
                ))

            # Write processed frames sequentially to video output
            for proc_frame in processed_batch:
                out.write(proc_frame)

            processed_frames_count += len(batch_frames)
            percent = min(100, (processed_frames_count * 100) // (total_frames if total_frames > 0 else 1))
            print(f"\r[PROGRESS] Processing... Frame {processed_frames_count}/{total_frames} ({percent}%) completed", end="", flush=True)

        print() # Move to new line after loop finishes
        # Release resources
        cap.release()
        out.release()

        is_gif_output = args.output.lower().endswith('.gif')
        if is_gif_output:
            print("[INFO] Target is GIF. Converting silent video frames to high-quality GIF...", flush=True)
            cmd = [
                "ffmpeg", "-y",
                "-i", temp_silent_path,
                "-vf", "split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse",
                args.output
            ]
        else:
            print("[INFO] Merging audio track and encoding H.264 video with FFmpeg...", flush=True)
            cmd = [
                "ffmpeg", "-y",
                "-i", temp_silent_path,
                "-i", args.target,
                "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
                "-c:a", "aac", "-b:a", "128k",
                "-map", "0:v:0",
                "-map", "1:a:0?",
                "-shortest",
                args.output
            ]

        try:
            subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            print("[SUCCESS] High-speed video face swap completed successfully!", flush=True)
        except subprocess.CalledProcessError as err:
            print(f"[ERROR] FFmpeg audio muxing failed: {err.stderr.decode()}", file=sys.stderr, flush=True)
            try:
                if os.path.exists(temp_silent_path):
                    os.replace(temp_silent_path, args.output)
                    print("[WARNING] Saved output without audio merging due to FFmpeg error.", flush=True)
            except Exception:
                pass
            sys.exit(1)
    finally:
        # Clean up temporary silent video and converted target
        if temp_silent_path and os.path.exists(temp_silent_path):
            try:
                os.remove(temp_silent_path)
            except Exception:
                pass
        if converted_temp_target and os.path.exists(converted_temp_target):
            try:
                os.remove(converted_temp_target)
            except Exception:
                pass

if __name__ == "__main__":
    main()
