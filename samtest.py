import cv2
import os
import numpy as np
from ultralytics.models.sam import SAM3SemanticPredictor

def load_first_image():
    image_dir = r"e:\CODING\vehicledetect\dataset\v1\annotate\images"
    
    # Get all image files
    images = [f for f in os.listdir(image_dir) if f.lower().endswith(('.jpg', '.jpeg', '.png'))]
    if not images:
        raise FileNotFoundError(f"No images found in {image_dir}")
        
    # Select first image
    image_name = images[0]
    image_path = os.path.join(image_dir, image_name)
    print(f"Selected image: {image_name}")
    return image_path

def main():
    try:
        # Load image path
        image_path = load_first_image()
        
        model_path = "sam3.1.pt"
        if not os.path.exists(model_path):
            print(f"Error: {model_path} not found. Please wait for download_sam3.py to finish.")
            return
            
        print("Loading SAM 3.1 model...")
        overrides = dict(
            conf=0.8,
            task="segment",
            mode="predict",
            model=model_path,
            save=False,
            device="cuda",  # Kembalikan ke CUDA
            half=False      # Paksa FP32 untuk kestabilan indexing
        )

        predictor = SAM3SemanticPredictor(overrides=overrides)
        print("SAM 3.1 model loaded successfully.")

        
        # Run inference using text prompt
        print("Running inference (Text Prompt: ['car', 'truck'])...")
        predictor.set_image(image_path)
        results = predictor(text=["car", "truck", "license plate", "person"])
            
        # Draw results
        result_img = results[0].plot()
        
        # Resize output to width 1280, maintaining aspect ratio
        h, w = result_img.shape[:2]
        new_w = 1280
        new_h = int(h * (new_w / w))
        resized_img = cv2.resize(result_img, (new_w, new_h))
        
        print("Displaying image in OpenCV window. Press any key to close...")
        cv2.imshow("SAM 3.1 Inference Result", resized_img)
        cv2.waitKey(0)
        cv2.destroyAllWindows()
        print("Window closed.")
        
    except Exception as e:
        print(f"An error occurred: {e}")

if __name__ == "__main__":
    main()
