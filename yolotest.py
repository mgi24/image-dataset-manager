import cv2
from ultralytics import YOLO
from ultralytics.utils.ops import scale_masks
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

# Run inference using imgsz=1024 for a balance of speed and high resolution quality
results = model(img, imgsz=640)

# Helper function to get class color in BGR (matching class colors from annotate2.js)
def get_cls_color(cls_id):
    # Hex colors converted to BGR:
    # 0: #6366f1 (indigo) -> RGB(99, 102, 241) -> BGR(241, 102, 99)
    # 1: #ef4444 (red)    -> RGB(239, 68, 68)   -> BGR(68, 68, 239)
    # 2: #f59e0b (amber)  -> RGB(245, 158, 11)  -> BGR(11, 158, 245)
    # 3: #10b981 (green)  -> RGB(16, 185, 129)  -> BGR(129, 185, 16)
    # 4: #06b6d4 (cyan)   -> RGB(6, 182, 212)   -> BGR(212, 182, 6)
    # 5: #a855f7 (purple) -> RGB(168, 85, 247)  -> BGR(247, 85, 168)
    colors = [
        (241, 102, 99),
        (68, 68, 239),
        (11, 158, 245),
        (129, 185, 16),
        (212, 182, 6),
        (247, 85, 168)
    ]
    return colors[int(cls_id) % len(colors)]

print("Drawing outlines and semi-transparent fills...")
if results and len(results) > 0:
    result = results[0]
    masks = result.masks
    boxes = result.boxes
    
    if boxes is not None:
        # Get model input shape from masks.data
        H_net, W_net = masks.data.shape[1:]
        
        # Calculate letterbox padding parameters manually to crop mask accurately
        r = min(H_net / h, W_net / w)
        new_h = int(round(h * r))
        new_w = int(round(w * r))
        pad_h = (H_net - new_h) // 2
        pad_w = (W_net - new_w) // 2
        
        for i, box in enumerate(boxes):
            cls_id = int(box.cls[0].item())
            class_name = model.names[cls_id]
            col = get_cls_color(cls_id)
            
            # 1) If segment masks are available
            if masks is not None and len(masks.xy) > i:
                # ── SEGMENT VARIANT 1: No Morph (using masks.xy[i]) ──
                pts_raw = masks.xy[i].astype(np.int32)
                if len(pts_raw) >= 3:
                    # Draw translucent fill (lowest opacity: 12% / alpha 0.12)
                    overlay = img.copy()
                    cv2.fillPoly(overlay, [pts_raw], col)
                    cv2.addWeighted(overlay, 0.12, img, 0.88, 0, img)
                    
                    # Draw thin border outline (thickness=1)
                    cv2.polylines(img, [pts_raw], isClosed=True, color=col, thickness=1)

                # Get binary mask for morphological operations
                mask_raw = masks.data[i].cpu().numpy()
                
                # Crop the letterbox padding
                mask_cropped = mask_raw[pad_h : pad_h + new_h, pad_w : pad_w + new_w]
                
                # Resize cropped mask to original image size
                mask_resized = cv2.resize(mask_cropped, (w, h), interpolation=cv2.INTER_LINEAR)
                
                # Threshold to binary (0 or 255)
                binary_mask = (mask_resized > 0.5).astype(np.uint8) * 255
                kernel = np.ones((5, 5), np.uint8)
                
                # ── SEGMENT VARIANT 2: Morphological Opening (Erode then Dilate) ──
                opened = cv2.morphologyEx(binary_mask, cv2.MORPH_OPEN, kernel)
                contours_open, _ = cv2.findContours(opened, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
                for contour in contours_open:
                    if len(contour) >= 3:
                        # Draw translucent fill (medium opacity: 25% / alpha 0.25)
                        overlay = img.copy()
                        cv2.fillPoly(overlay, [contour], col)
                        cv2.addWeighted(overlay, 0.25, img, 0.75, 0, img)
                        
                        # Draw medium border outline (thickness=2)
                        cv2.polylines(img, [contour], isClosed=True, color=col, thickness=2)
                
                # ── SEGMENT VARIANT 3: Morphological Closing (Dilate then Erode on opened mask) ──
                closed = cv2.morphologyEx(opened, cv2.MORPH_CLOSE, kernel)
                contours_close, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
                for contour in contours_close:
                    if len(contour) >= 3:
                        # Draw translucent fill (highest opacity: 45% / alpha 0.45)
                        overlay = img.copy()
                        cv2.fillPoly(overlay, [contour], col)
                        cv2.addWeighted(overlay, 0.45, img, 0.55, 0, img)
                        
                        # Draw thick border outline (thickness=3)
                        cv2.polylines(img, [contour], isClosed=True, color=col, thickness=3)
                
                # Compute bounding box for label placing from final processed mask
                mx, my, mw, mh = cv2.boundingRect(closed if len(contours_close) > 0 else (opened if len(contours_open) > 0 else binary_mask))
                min_x, min_y = mx, my
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
cv2.imshow("YOLO26x Segment Test (Custom Outline)", resized_img)
cv2.waitKey(0)
cv2.destroyAllWindows()
print("Done.")
