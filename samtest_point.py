import cv2
import os
import numpy as np
from ultralytics.models.sam import SAM3SemanticPredictor

def load_first_image():
    image_dir = r"e:\CODING\vehicledetect\dataset\v1\annotate\images"
    if not os.path.exists(image_dir):
        image_dir = r"dataset\v1\annotate\images"
    
    images = [f for f in os.listdir(image_dir) if f.lower().endswith(('.jpg', '.jpeg', '.png'))]
    if not images:
        raise FileNotFoundError(f"No images found in {image_dir}")
        
    image_name = images[0]
    image_path = os.path.join(image_dir, image_name)
    print(f"Selected image: {image_name}")
    return image_path

# Global variables for interactive segmentation
points = []
labels = []
predictor = None
image_path = ""
img_orig = None
scale = 1.0
window_name = "SAM 3.1 Point Prompt (Click: Pos, Ctrl+Click: Neg, R: Reset, Esc: Exit)"
# Define target concepts to guide the SAM 3.1 grounding/concept head
concepts = ["car", "truck", "license plate", "person"]

def run_prediction():
    global points, labels, img_orig, scale, window_name, predictor
    if not points:
        # Show original image resized
        h, w = img_orig.shape[:2]
        display_w = int(w * scale)
        display_h = int(h * scale)
        display_img = cv2.resize(img_orig, (display_w, display_h))
        cv2.imshow(window_name, display_img)
        return

    print(f"Running prediction with {len(points)} points...")
    
    # Format coordinates as integers
    pt_coords = [[int(pt[0]), int(pt[1])] for pt in points]
    pt_labels = [int(lbl) for lbl in labels]
    
    # Run prediction using the semantic predictor with grounding concepts
    results = predictor(text=concepts, points=[pt_coords], labels=[pt_labels])
    
    # Plot predictions
    res_img = results[0].plot(labels=False, boxes=False)
    
    # Draw points on res_img before resizing
    for pt, lbl in zip(points, labels):
        color = (0, 255, 0) if lbl == 1 else (0, 0, 255) # Green for positive, Red for negative
        cv2.circle(res_img, (int(pt[0]), int(pt[1])), 8, color, -1)
        cv2.circle(res_img, (int(pt[0]), int(pt[1])), 8, (255, 255, 255), 2)
        # Plus/Minus sign
        text = "+" if lbl == 1 else "-"
        cv2.putText(res_img, text, (int(pt[0]) - 5, int(pt[1]) + 4), 
                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 2)

    # Resize to display scale
    h, w = res_img.shape[:2]
    display_w = int(w * scale)
    display_h = int(h * scale)
    display_img = cv2.resize(res_img, (display_w, display_h))
    cv2.imshow(window_name, display_img)

def on_mouse(event, x, y, flags, param):
    global points, labels, scale
    if event == cv2.EVENT_LBUTTONDOWN:
        # Map click coordinates back to original image scale
        orig_x = x / scale
        orig_y = y / scale
        
        # Check Ctrl modifier flag
        is_ctrl = bool(flags & cv2.EVENT_FLAG_CTRLKEY)
        label = 0 if is_ctrl else 1
        
        points.append([orig_x, orig_y])
        labels.append(label)
        
        print(f"Added {'Negative' if label == 0 else 'Positive'} point at: ({int(orig_x)}, {int(orig_y)})")
        run_prediction()

def main():
    global predictor, image_path, img_orig, scale, points, labels
    try:
        image_path = load_first_image()
        img_orig = cv2.imread(image_path)
        if img_orig is None:
            print("Error: Could not read image.")
            return

        h, w = img_orig.shape[:2]
        # Calculate scale to fit inside 1280x720 window
        scale = min(1280.0 / w, 720.0 / h)
        if scale > 1.0:
            scale = 1.0

        model_path = "sam3.1.pt"
        if not os.path.exists(model_path):
            print(f"Error: {model_path} not found.")
            return

        print("Loading SAM 3.1 model...")
        overrides = dict(
            conf=0.5,
            task="segment",
            mode="predict",
            model=model_path,
            save=False,
            device="cuda",
            half=False,
        )
        predictor = SAM3SemanticPredictor(overrides=overrides)
        print("SAM 3.1 model loaded successfully.")

        # Set image once
        print("Setting image in predictor...")
        predictor.set_image(image_path)

        # Create window and set mouse callback
        cv2.namedWindow(window_name)
        cv2.setMouseCallback(window_name, on_mouse)

        # Initial display
        run_prediction()

        print("\nControls:")
        print(" - Click on image to add POSITIVE point (green)")
        print(" - Ctrl+Click to add NEGATIVE point (red)")
        print(" - Press 'r' to reset points")
        print(" - Press 'Esc' or any other key to close")

        while True:
            key = cv2.waitKey(1) & 0xFF
            if key == 27:  # Esc
                break
            elif key == ord('r') or key == ord('R'):
                print("Resetting points...")
                points = []
                labels = []
                run_prediction()
            
            # Check if window is closed
            if cv2.getWindowProperty(window_name, cv2.WND_PROP_VISIBLE) < 1:
                break

        cv2.destroyAllWindows()
        print("Finished.")

    except Exception as e:
        print(f"An error occurred: {e}")

if __name__ == "__main__":
    main()
