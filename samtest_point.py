import cv2
import os
import numpy as np
from ultralytics import SAM

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
model = None
image_path = ""
img_orig = None
scale = 1.0
window_name = "SAM Visual Prompting (Click: Pos, Ctrl+Click: Neg, R: Reset, Esc: Exit)"

def run_prediction():
    global points, labels, img_orig, scale, window_name
    if not points:
        # Show original image resized
        h, w = img_orig.shape[:2]
        display_w = int(w * scale)
        display_h = int(h * scale)
        display_img = cv2.resize(img_orig, (display_w, display_h))
        cv2.imshow(window_name, display_img)
        return

    print(f"Running prediction with {len(points)} points...")
    # Predict using the standard visual prompt API (SAM 2 / SAM 3 visual compatibility)
    results = model.predict(
        source=image_path,
        points=points,
        labels=labels,
        device="cuda",
        verbose=False
    )
    
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
    global model, image_path, img_orig, scale, points, labels
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

        model_path = "sam3.pt"
        if not os.path.exists(model_path):
            print(f"Error: {model_path} not found. Please make sure the sam3.pt file exists in the workspace directory.")
            return

        print(f"Loading {model_path} model...")
        model = SAM(model_path)
        print(f"{model_path} model loaded successfully.")

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
