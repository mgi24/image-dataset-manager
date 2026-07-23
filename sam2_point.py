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
baked_img = None
current_mask_result = None
scale = 1.0
window_name = "SAM 2.1 Visual Prompting (Click: Pos, Ctrl+Click: Neg, Enter: Confirm, R: Reset, Esc: Exit)"

def run_prediction():
    global points, labels, baked_img, scale, window_name, current_mask_result
    if not points:
        # Show baked image resized
        h, w = baked_img.shape[:2]
        display_w = int(w * scale)
        display_h = int(h * scale)
        display_img = cv2.resize(baked_img, (display_w, display_h))
        cv2.imshow(window_name, display_img)
        return

    print(f"Running prediction with {len(points)} points...")
    # Predict using the standard visual prompt API
    results = model.predict(
        source=image_path,
        points=[points],
        labels=[labels],
        device="cuda",
        verbose=True
    )
    current_mask_result = results[0]
    
    # Plot predictions on top of our baked_img
    try:
        res_img = current_mask_result.plot(img=baked_img.copy(), labels=False, boxes=False)
    except TypeError:
        res_img = current_mask_result.plot(labels=False, boxes=False)
    
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
    global model, image_path, img_orig, baked_img, scale, points, labels, current_mask_result
    try:
        image_path = load_first_image()
        img_orig = cv2.imread(image_path)
        if img_orig is None:
            print("Error: Could not read image.")
            return

        baked_img = img_orig.copy()

        h, w = img_orig.shape[:2]
        # Calculate scale to fit inside 1280x720 window
        scale = min(1280.0 / w, 720.0 / h)
        if scale > 1.0:
            scale = 1.0

        model_path = "sam2.1_l.pt"
        if not os.path.exists(model_path):
            print(f"{model_path} not found locally. Downloading from GitHub release...")
            import urllib.request
            url = "https://github.com/ultralytics/assets/releases/download/v8.3.0/sam2.1_l.pt"
            urllib.request.urlretrieve(url, model_path)
            print("Download complete.")

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
        print(" - Press 'Enter' to confirm object and start a new one")
        print(" - Press 'r' to reset points (and clear all objects)")
        print(" - Press 'Esc' or any other key to close")

        while True:
            key = cv2.waitKey(1) & 0xFF
            if key == 27:  # Esc
                break
            elif key == 13: # Enter
                if current_mask_result is not None:
                    print("Object confirmed! Starting new object.")
                    try:
                        baked_img = current_mask_result.plot(img=baked_img.copy(), labels=False, boxes=False)
                    except TypeError:
                        baked_img = current_mask_result.plot(labels=False, boxes=False)
                    points = []
                    labels = []
                    current_mask_result = None
                    run_prediction()
            elif key == ord('r') or key == ord('R'):
                print("Resetting points...")
                points = []
                labels = []
                current_mask_result = None
                baked_img = img_orig.copy()
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
