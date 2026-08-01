import os
import cv2
from ultralytics import YOLO

def main():
    model_path = os.path.join("model", "yolov8x-seg.pt")
    image_path = "test.jpg"
    
    if not os.path.exists(model_path):
        print(f"Error: Model not found at {model_path}")
        return
        
    if not os.path.exists(image_path):
        print(f"Error: Image not found at {image_path}")
        return

    print(f"Loading model {model_path}...")
    model = YOLO(model_path)

    # COCO Class IDs:
    # 0: person, 1: bicycle, 2: car, 3: motorcycle, 5: bus, 7: truck
    class_ids = [0, 1, 2, 3, 5, 7]
    
    print(f"Running prediction on {image_path}...")
    # Get predictions filtered by classes
    results = model.predict(image_path, 
                            classes=class_ids,
                            conf = 0.7,
                            imgsz = 1280
                            )

    # Use standard Ultralytics plotting to visualize segments
    print("Plotting standard Ultralytics visualization...")
    annotated_img = results[0].plot()

    # Resize keeping aspect ratio to fit within 1280x720
    h, w = annotated_img.shape[:2]
    max_w, max_h = 1280, 720
    scale = min(max_w / w, max_h / h)
    if scale < 1.0:
        new_w = int(w * scale)
        new_h = int(h * scale)
        print(f"Resizing window/image from {w}x{h} to {new_w}x{new_h} to fit screen...")
        annotated_img = cv2.resize(annotated_img, (new_w, new_h))

    # Display using cv2 window
    window_name = "YOLOv8x Segment - Ultralytics Standard Plot"
    cv2.imshow(window_name, annotated_img)
    print("Window opened. Press any key in the window to close...")
    cv2.waitKey(0)
    cv2.destroyAllWindows()
    print("Done.")

if __name__ == "__main__":
    main()
