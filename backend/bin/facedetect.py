import os
import sys
import argparse
import json
import cv2
import insightface
from insightface.app import FaceAnalysis

def main():
    parser = argparse.ArgumentParser(description="LIYA Face Detector & Cropper")
    parser.add_argument("--image", required=True, help="Path to input image")
    parser.add_argument("--output-dir", required=True, help="Directory to save cropped face previews")
    args = parser.parse_args()

    if not os.path.exists(args.image):
        print(json.dumps({"error": f"Input image not found: {args.image}"}))
        sys.exit(1)

    # Read image
    img = cv2.imread(args.image)
    if img is None:
        print(json.dumps({"error": "Failed to read input image"}))
        sys.exit(1)

    # Ensure output dir exists
    os.makedirs(args.output_dir, exist_ok=True)

    # Initialize Face Analysis (buffalo_l)
    try:
        app = FaceAnalysis(name='buffalo_l', providers=['CPUExecutionProvider'])
        app.prepare(ctx_id=0, det_size=(640, 640))
    except Exception as e:
        print(json.dumps({"error": f"Failed to initialize FaceAnalysis: {str(e)}"}))
        sys.exit(1)

    # Detect faces
    faces = app.get(img)
    if not faces:
        print(f"__DETECTION_JSON__:{json.dumps([])}")
        sys.exit(0)

    # Sort faces from left to right based on bbox x1 coordinate
    faces = sorted(faces, key=lambda x: x.bbox[0])

    img_h, img_w = img.shape[:2]
    results = []

    for idx, face in enumerate(faces):
        bbox = face.bbox.astype(int)
        x1, y1, x2, y2 = bbox
        
        # Bounding box width and height
        w = x2 - x1
        h = y2 - y1
        
        # Add padding around the face for a better visual preview card
        pad_x = int(w * 0.25)
        pad_y = int(h * 0.25)
        
        crop_x1 = max(0, x1 - pad_x)
        crop_y1 = max(0, y1 - pad_y)
        crop_x2 = min(img_w, x2 + pad_x)
        crop_y2 = min(img_h, y2 + pad_y)
        
        crop_img = img[crop_y1:crop_y2, crop_x1:crop_x2]
        
        # Save crop
        crop_filename = f"crop_{idx}_{int(os.path.getmtime(args.image))}.jpg"
        crop_path = os.path.join(args.output_dir, crop_filename)
        cv2.imwrite(crop_path, crop_img)
        
        # Compute relative URL path (assuming served statically from public/)
        relative_path = f"/swapped/crops/{crop_filename}"
        
        results.append({
            "index": idx,
            "cropPath": relative_path,
            "bbox": [int(x1), int(y1), int(x2), int(y2)]
        })

    # Print JSON result to stdout for Express server to capture
    print(f"__DETECTION_JSON__:{json.dumps(results)}")

if __name__ == "__main__":
    main()
