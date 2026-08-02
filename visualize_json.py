import os
import sys
import json
import cv2
import numpy as np

def detect_coordinate_type(coords, img_w, img_h):
    """
    Detects if coordinates are normalized (0-1), GPT-4o style (0-1000), or absolute pixel coordinates.
    Returns: (scale_x, scale_y) to convert coordinates to pixel values.
    """
    max_val = max(coords)
    # If all values are <= 1.0, they are likely normalized 0-1
    if max_val <= 1.01:
        return img_w, img_h
    # If values are up to 1000, they are likely normalized 0-1000 (ChatGPT vision format)
    elif max_val <= 1005:
        return img_w / 1000.0, img_h / 1000.0
    # Otherwise, assume absolute pixel coordinates
    return 1.0, 1.0

def main():
    json_path = "outputcgpt.txt"
    image_path = "test.jpg"
    output_path = "visualized_output.jpg"

    print("=" * 60)
    print("ChatGPT JSON Annotation Visualizer & Integrity Tester")
    print("=" * 60)

    # 1. Check if files exist
    if not os.path.exists(json_path):
        print(f"[-] Error: JSON file '{json_path}' not found.")
        return

    # Check file size
    if os.path.getsize(json_path) == 0:
        print(f"[-] Error: File '{json_path}' is empty (0 bytes).")
        print("    Please make sure you have saved the file in your editor (Ctrl+S / Cmd+S).")
        return

    # 2. Try to parse JSON and check for corruption
    try:
        with open(json_path, 'r', encoding='utf-8') as f:
            content = f.read().strip()
            # Handle possible markdown code block wrappers in raw txt
            if content.startswith("```json"):
                content = content.replace("```json", "", 1)
            if content.endswith("```"):
                content = content[:-3]
            content = content.strip()
            
            data = json.loads(content)
        print("[+] JSON parsing: SUCCESS (Not corrupt).")
    except json.JSONDecodeError as e:
        print(f"[-] JSON parsing: FAILED (CORRUPTED or MALFORMED JSON).")
        print(f"    Error details: {e}")
        return
    except Exception as e:
        print(f"[-] Unexpected error reading JSON file: {e}")
        return

    # 3. Check if image exists
    if not os.path.exists(image_path):
        print(f"[-] Error: Image '{image_path}' not found in the current directory.")
        return

    img = cv2.imread(image_path)
    if img is None:
        print(f"[-] Error: Failed to load image '{image_path}'. Image file might be corrupt.")
        return

    img_h, img_w, _ = img.shape
    print(f"[+] Loaded image '{image_path}' with dimensions: {img_w}x{img_h}")

    # 4. Search and parse annotations from the JSON data
    # Standardize structure into a list of items
    items = []
    if isinstance(data, list):
        items = data
    elif isinstance(data, dict):
        # Look for typical list fields in dict
        for key in ["annotations", "objects", "predictions", "detections", "boxes", "items"]:
            if key in data and isinstance(data[key], list):
                items = data[key]
                print(f"[i] Found annotation list under key: '{key}'")
                break
        if not items:
            # If it's a dict but no list key matches, wrap it or look inside
            items = [data]

    print(f"[+] Found {len(items)} potential annotation entries.")

    # We will collect unique classes
    detected_classes = set()
    valid_annotations = 0

    # Draw boxes
    for idx, item in enumerate(items):
        if not isinstance(item, dict):
            continue

        # Try to find class/label name
        label = None
        for label_key in ["label", "class", "category", "name", "class_name", "type"]:
            if label_key in item:
                label = str(item[label_key])
                detected_classes.add(label)
                break
        
        if label is None:
            label = f"object_{idx}"

        # Try to find bounding box or polygon
        box = None
        box_format = None # ymin_xmin_ymax_xmax, xmin_ymin_xmax_ymax, xmin_ymin_w_h
        
        # Format 1: box_2d or bbox
        for box_key in ["box_2d", "bbox", "box", "bounding_box"]:
            if box_key in item and isinstance(item[box_key], list):
                box = item[box_key]
                box_format = box_key
                break
        
        # Draw logic
        if box and len(box) == 4:
            # Detect box coordinate scale type (normalized vs absolute)
            scale_x, scale_y = detect_coordinate_type(box, img_w, img_h)
            
            # Identify coordinate order:
            # ChatGPT box_2d is typically [ymin, xmin, ymax, xmax] (normalized 0-1000)
            # Other tools use [xmin, ymin, xmax, ymax] or [xmin, ymin, width, height]
            if box_format == "box_2d" or (len(box) == 4 and box[0] > box[1] and box[2] > box[3] and max(box) <= 1000):
                # Standard box_2d [ymin, xmin, ymax, xmax]
                ymin, xmin, ymax, xmax = box
                x1, y1 = int(xmin * scale_x), int(ymin * scale_y)
                x2, y2 = int(xmax * scale_x), int(ymax * scale_y)
            else:
                # Assume xmin, ymin, xmax, ymax or check if it's width/height
                v1, v2, v3, v4 = box
                x1, y1 = int(v1 * scale_x), int(v2 * scale_y)
                x2, y2 = int(v3 * scale_x), int(v4 * scale_y)
                
                # Check if it looks like [x, y, w, h] (i.e. x2 < x1 or y2 < y1)
                if x2 < x1 or y2 < y1:
                    x2 = x1 + x2
                    y2 = y1 + y2
            
            # Ensure coordinates are within image boundaries
            x1, x2 = max(0, min(x1, img_w)), max(0, min(x2, img_w))
            y1, y2 = max(0, min(y1, img_h)), max(0, min(y2, img_h))

            # Draw rectangle
            color = (0, 255, 0) # Green for annotations
            cv2.rectangle(img, (x1, y1), (x2, y2), color, 3)
            
            # Put label
            font = cv2.FONT_HERSHEY_SIMPLEX
            font_scale = 0.8
            thickness = 2
            text_size = cv2.getTextSize(label, font, font_scale, thickness)[0]
            
            # Draw label background
            cv2.rectangle(img, (x1, y1 - text_size[1] - 10), (x1 + text_size[0], y1), color, -1)
            cv2.putText(img, label, (x1, y1 - 5), font, font_scale, (0, 0, 0), thickness, cv2.LINE_AA)
            
            valid_annotations += 1
            print(f"  - Annotated: '{label}' at [{x1}, {y1}, {x2}, {y2}]")
            
        # Format 2: Polygons / points
        elif "points" in item and isinstance(item["points"], list):
            pts = item["points"]
            scale_x, scale_y = detect_coordinate_type([coord for pt in pts for coord in pt], img_w, img_h)
            pixel_pts = []
            for pt in pts:
                if isinstance(pt, list) and len(pt) == 2:
                    pixel_pts.append([int(pt[0] * scale_x), int(pt[1] * scale_y)])
            
            if len(pixel_pts) >= 3:
                pts_arr = np.array(pixel_pts, dtype=np.int32)
                pts_arr = pts_arr.reshape((-1, 1, 2))
                cv2.polylines(img, [pts_arr], True, (255, 0, 0), 3) # Blue for polygons
                
                # Draw label near first point
                x1, y1 = pixel_pts[0]
                cv2.putText(img, label, (x1, y1 - 5), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 0, 0), 2, cv2.LINE_AA)
                valid_annotations += 1
                print(f"  - Polygon Annotated: '{label}' with {len(pixel_pts)} points starting at [{x1}, {y1}]")

    print(f"\n[+] Detected Classes: {sorted(list(detected_classes))}")
    print(f"[+] Total successfully visualized annotations: {valid_annotations}")

    # 5. Save the output image
    cv2.imwrite(output_path, img)
    print(f"[+] Saved visualization image to: '{output_path}'")

    # 6. Try to display if window system is available
    try:
        # Resize for display convenience
        display_h, display_w = img.shape[:2]
        max_disp_w, max_disp_h = 1280, 720
        scale = min(max_disp_w / display_w, max_disp_h / display_h)
        if scale < 1.0:
            display_img = cv2.resize(img, (int(display_w * scale), int(display_h * scale)))
        else:
            display_img = img

        cv2.imshow("ChatGPT Annotation Visualization", display_img)
        print("[i] OpenCV window opened. Press any key in the window to close...")
        cv2.waitKey(0)
        cv2.destroyAllWindows()
    except Exception as e:
        print("[i] Note: Could not open OpenCV display window (likely running in a headless or non-interactive environment). Saved output file can still be viewed.")

if __name__ == "__main__":
    main()
