import cv2
from ultralytics import YOLO
import numpy as np

# Load model
print("Loading model yolo26x-seg.pt...")
model = YOLO("yolo26x-seg.pt")

# Load image
img_path = "1366005_720_jpg.rf.a1b3030c4d6cbbd6e7a9a333e26d5653.jpg"
print(f"Reading image {img_path}...")
img = cv2.imread(img_path)
if img is None:
    print(f"Error: Could not read image at {img_path}")
    exit(1)
h, w = img.shape[:2]

# Run inference
print("Running inference...")
results = model(img, imgsz=640)

# Helper function to get class color in BGR (matching class colors from annotate2.js)
def get_cls_color(cls_id):
    colors = [
        (241, 102, 99),
        (68, 68, 239),
        (11, 158, 245),
        (129, 185, 16),
        (212, 182, 6),
        (247, 85, 168)
    ]
    return colors[int(cls_id) % len(colors)]

print("Drawing outlines and semi-transparent fills (without morphology)...")
if results and len(results) > 0:
    result = results[0]
    masks = result.masks
    boxes = result.boxes
    
    if boxes is not None:
        for i, box in enumerate(boxes):
            cls_id = int(box.cls[0].item())
            class_name = model.names[cls_id]
            col = get_cls_color(cls_id)
            
            # 1) If segment masks are available
            if masks is not None and len(masks.xy) > i:
                # ── METHOD A: Using masks.xy[i] (Polygon coordinates) ── DRAW IN BLUE
                pts = masks.xy[i].astype(np.int32)
                if len(pts) >= 3:
                    # Draw translucent fill in Blue (BGR: 255, 0, 0)
                    overlay = img.copy()
                    cv2.fillPoly(overlay, [pts], (255, 0, 0))
                    cv2.addWeighted(overlay, 0.20, img, 0.80, 0, img)
                    # Draw blue outline
                    cv2.polylines(img, [pts], isClosed=True, color=(255, 0, 0), thickness=2)

                # ── METHOD B: Using masks.data[i] resized to (w, h) (My previous edit) ── DRAW IN RED
                mask_raw = masks.data[i].cpu().numpy()
                mask_resized = cv2.resize(mask_raw, (w, h), interpolation=cv2.INTER_LINEAR)
                binary_mask = (mask_resized > 0.5).astype(np.uint8) * 255
                contours_raw, _ = cv2.findContours(binary_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
                
                for contour in contours_raw:
                    if len(contour) >= 3:
                        # Draw translucent fill in Red (BGR: 0, 0, 255)
                        overlay = img.copy()
                        cv2.fillPoly(overlay, [contour], (0, 0, 255))
                        cv2.addWeighted(overlay, 0.20, img, 0.80, 0, img)
                        # Draw red outline
                        cv2.polylines(img, [contour], isClosed=True, color=(0, 0, 255), thickness=2)
                
                # Get boundary for label placing (using Method A)
                min_x = int(np.min(pts[:, 0]))
                min_y = int(np.min(pts[:, 1]))
            else:
                # 2) Fallback to bbox
                x1, y1, x2, y2 = map(int, box.xyxy[0].tolist())
                # Draw translucent fill
                overlay = img.copy()
                cv2.rectangle(overlay, (x1, y1), (x2, y2), col, -1)
                cv2.addWeighted(overlay, 0.40, img, 0.60, 0, img)
                
                # Draw solid bounding box outline
                cv2.rectangle(img, (x1, y1), (x2, y2), col, 2)
                min_x, min_y = x1, y1

            # 3) Draw label (solid color tag + white text)
            (tw, th), baseline = cv2.getTextSize(class_name, cv2.FONT_HERSHEY_SIMPLEX, 0.4, 1)
            y_label = min_y - 5
            if y_label - th - 5 < 0:
                y_label = min_y + th + 5
                
            cv2.rectangle(img, (min_x, y_label - th - 5), (min_x + tw + 6, y_label + baseline), col, -1)
            cv2.putText(img, class_name, (min_x + 3, y_label - 2), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (255, 255, 255), 1, cv2.LINE_AA)

# Resize to 1360 px width (keeping aspect ratio)
target_width = 1360
h, w = img.shape[:2]
target_height = int(h * (target_width / w))
print(f"Resizing display from {w}x{h} to {target_width}x{target_height}...")
resized_img = cv2.resize(img, (target_width, target_height))

# Show result window
print("Displaying custom segment visualization. Press any key to close...")
cv2.imshow("YOLO26x Segment Test (No Morph)", resized_img)
cv2.waitKey(0)
cv2.destroyAllWindows()
print("Done.")
