import os
import sys
import json
import sqlite3
import base64
import argparse
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse, FileResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Optional, Dict, Any
import cv2
import numpy as np
import threading

# Parse command line args
parser = argparse.ArgumentParser(description="Annodes Server")
parser.add_argument("--port", type=int, default=8001, help="Port to run server on")
# Note: we use parse_known_args because uvicorn might pass other args
args, unknown = parser.parse_known_args()

app = FastAPI(title="Annotation Nodes App")

# Enable CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Constants
DB_PATH = "annodes.db"
MODEL_DIR = "model"
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# YOLO model cache
_yolo_models = {}
_yolo_model_lock = threading.Lock()

def _get_yolo_model(model_name: str, model_path: str, device: str):
    global _yolo_models
    key = (model_name, device)
    if key not in _yolo_models:
        with _yolo_model_lock:
            if key not in _yolo_models:
                from ultralytics import YOLO
                yolo = YOLO(model_path)
                yolo.to(device)
                _yolo_models[key] = yolo
    return _yolo_models[key]

# Models
class CanvasSaveRequest(BaseModel):
    nodes: str
    connections: str

class RunFlowRequest(BaseModel):
    nodes: List[Dict[str, Any]]
    connections: List[Dict[str, Any]]

# Database setup
def init_db():
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS canvas (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nodes TEXT,
            connections TEXT
        );
    """)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS flow_state (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            current_index INTEGER DEFAULT 0
        );
    """)
    # Seed flow state
    cursor.execute("SELECT COUNT(*) FROM flow_state")
    if cursor.fetchone()[0] == 0:
        cursor.execute("INSERT INTO flow_state (current_index) VALUES (0)")
    conn.commit()
    conn.close()

init_db()

# --- Serve Frontend Files ---
@app.get("/")
def read_root():
    return FileResponse(os.path.join(BASE_DIR, "annodes.html"))

@app.get("/annodes.html")
def read_html():
    return FileResponse(os.path.join(BASE_DIR, "annodes.html"))

@app.get("/annodes.js")
def read_js():
    return FileResponse(os.path.join(BASE_DIR, "annodes.js"))

@app.get("/index.css")
def read_css():
    return FileResponse(os.path.join(BASE_DIR, "legacy", "index.css"))

# --- API Endpoints ---
@app.get("/api/gpus")
def list_gpus():
    try:
        import torch
        gpus = []
        if torch.cuda.is_available():
            for i in range(torch.cuda.device_count()):
                name = torch.cuda.get_device_name(i)
                mem_total = torch.cuda.get_device_properties(i).total_memory // (1024 * 1024)
                gpus.append({"id": f"cuda:{i}", "name": f"GPU {i}: {name} ({mem_total} MB)"})
        if not gpus:
            gpus.append({"id": "cpu", "name": "CPU"})
        return {"success": True, "gpus": gpus}
    except Exception as e:
        return {"success": False, "gpus": [{"id": "cpu", "name": "CPU"}], "error": str(e)}

@app.get("/api/models")
def list_models():
    try:
        os.makedirs(MODEL_DIR, exist_ok=True)
        files = [f for f in os.listdir(MODEL_DIR) if f.endswith(".pt")]
        return {"success": True, "models": files}
    except Exception as e:
        return {"success": False, "error": str(e)}

@app.get("/api/yolo-model-names")
def get_yolo_model_names(model: str):
    if not model.endswith(".pt"):
        model_file = f"{model}.pt"
    else:
        model_file = model
    model_path = os.path.join(MODEL_DIR, model_file)
    if not os.path.exists(model_path):
        return {"success": False, "error": f"Model {model_file} not found in model/ folder"}
    try:
        yolo = _get_yolo_model(model_file, model_path, device="cpu")
        names = [yolo.names[i] for i in sorted(yolo.names.keys())]
        return {"success": True, "names": names}
    except Exception as e:
        return {"success": False, "error": str(e)}

@app.post("/api/save-canvas")
def save_canvas(payload: CanvasSaveRequest):
    try:
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        cursor.execute("DELETE FROM canvas")
        cursor.execute("INSERT INTO canvas (nodes, connections) VALUES (?, ?)", (payload.nodes, payload.connections))
        conn.commit()
        conn.close()
        return {"success": True}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/load-canvas")
def load_canvas():
    try:
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        cursor.execute("SELECT nodes, connections FROM canvas LIMIT 1")
        row = cursor.fetchone()
        conn.close()
        if row:
            return {"success": True, "nodes": json.loads(row[0]), "connections": json.loads(row[1])}
        return {"success": True, "nodes": [], "connections": []}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/reset-index")
def reset_index():
    try:
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        cursor.execute("UPDATE flow_state SET current_index = 0")
        conn.commit()
        conn.close()
        return {"success": True}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# Parse hex color to BGR
def hex_to_bgr(hex_str: str):
    hex_str = hex_str.lstrip('#')
    if len(hex_str) == 3:
        hex_str = ''.join([c*2 for c in hex_str])
    rgb = tuple(int(hex_str[i:i+2], 16) for i in (0, 2, 4))
    return (rgb[2], rgb[1], rgb[0]) # BGR

@app.post("/api/run-flow")
def run_flow(payload: RunFlowRequest):
    nodes = {n["id"]: n for n in payload.nodes}
    connections = payload.connections

    # Find the YOLO Node
    yolo_node = None
    for n in payload.nodes:
        if n["type"] == "yolo_detector":
            yolo_node = n
            break

    if not yolo_node:
        raise HTTPException(status_code=400, detail="Missing YOLO Detector node in flow")

    # Find input node connected to YOLO node
    input_node = None
    for conn in connections:
        if conn["toNodeId"] == yolo_node["id"]:
            from_node = nodes.get(conn["fromNodeId"])
            if from_node and from_node["type"] in ("single_image", "folder"):
                input_node = from_node
                break

    if not input_node:
        raise HTTPException(status_code=400, detail="YOLO Detector node must be connected to an Input Node (Single Image or Folder)")

    # Execute Input Node
    image_path = ""
    annotation_path = None
    input_classes = []
    
    # Extract input classes
    raw_classes = input_node["properties"].get("classes", [])
    for idx, c in enumerate(raw_classes):
        input_classes.append({
            "index": idx,
            "name": c.get("name", f"Class {idx}"),
            "color": c.get("color", "#a855f7")
        })

    is_folder_mode = input_node["type"] == "folder"
    total_images = 0
    current_index = 0

    if is_folder_mode:
        images_dir = input_node["properties"].get("images_dir", "").strip()
        labels_dir = input_node["properties"].get("labels_dir", "").strip()
        
        if not images_dir or not os.path.exists(images_dir):
            raise HTTPException(status_code=400, detail=f"Images directory '{images_dir}' does not exist")
        
        # Get sorted images
        img_extensions = ('.jpg', '.jpeg', '.png')
        images = sorted([f for f in os.listdir(images_dir) if f.lower().endswith(img_extensions)])
        total_images = len(images)
        if total_images == 0:
            raise HTTPException(status_code=400, detail=f"No images found in folder '{images_dir}'")
            
        # Get current index from DB
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        cursor.execute("SELECT current_index FROM flow_state LIMIT 1")
        row = cursor.fetchone()
        current_index = row[0] if row else 0
        
        if current_index >= total_images:
            current_index = 0 # wrap around
            
        image_name = images[current_index]
        image_path = os.path.join(images_dir, image_name)
        
        # Check label path
        if labels_dir and os.path.exists(labels_dir):
            label_name = os.path.splitext(image_name)[0] + ".txt"
            cand_label = os.path.join(labels_dir, label_name)
            if os.path.exists(cand_label):
                annotation_path = cand_label
                
        # Update index for next run
        next_idx = (current_index + 1) % total_images
        cursor.execute("UPDATE flow_state SET current_index = ?", (next_idx,))
        conn.commit()
        conn.close()
    else:
        # Single Image Node
        image_path = input_node["properties"].get("image_path", "").strip()
        annotation_path = input_node["properties"].get("annotation_path", "").strip()
        if not annotation_path:
            annotation_path = None
            
        if not image_path or not os.path.exists(image_path):
            raise HTTPException(status_code=400, detail=f"Image file '{image_path}' not found")
        if annotation_path and not os.path.exists(annotation_path):
            raise HTTPException(status_code=400, detail=f"Annotation file '{annotation_path}' not found")

    # Validate annotation file formatting if present
    parsed_annotations = []
    if annotation_path:
        try:
            with open(annotation_path, "r", encoding="utf-8") as f:
                for line_idx, line in enumerate(f):
                    line = line.strip()
                    if not line:
                        continue
                    parts = line.split()
                    class_id = int(parts[0])
                    coords = [float(x) for x in parts[1:]]
                    if len(coords) < 4:
                        raise ValueError(f"Too few coordinates on line {line_idx+1}")
                    parsed_annotations.append({"class_id": class_id, "coords": coords})
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Format annotation.txt salah: {str(e)}")

    # Execute YOLO Node
    yolo_model_name = yolo_node["properties"].get("model", "yolov8x-seg").strip()
    yolo_imgsz = int(yolo_node["properties"].get("imgsz", 640))
    yolo_conf = float(yolo_node["properties"].get("conf", 0.25))
    yolo_verbose = bool(yolo_node["properties"].get("verbose", False))
    yolo_device = yolo_node["properties"].get("device", "cuda:0")
    
    # Class bindings from UI
    class_bindings = yolo_node["properties"].get("class_bindings", {}) # maps model_class_id string -> input_class_index (int)

    if not yolo_model_name.endswith(".pt"):
        model_file = f"{yolo_model_name}.pt"
    else:
        model_file = yolo_model_name
    model_path = os.path.join(MODEL_DIR, model_file)
    if not os.path.exists(model_path):
        raise HTTPException(status_code=400, detail=f"YOLO model '{model_file}' not found in model/ folder")

    # Capture stdout and stderr, and logging for YOLO logs
    import io
    import logging
    from contextlib import redirect_stdout, redirect_stderr
    
    yolo_logger = logging.getLogger("ultralytics")
    log_capture_string = io.StringIO()
    ch = logging.StreamHandler(log_capture_string)
    ch.setLevel(logging.INFO)
    ch.setFormatter(logging.Formatter("%(message)s"))
    yolo_logger.addHandler(ch)
    
    f_stdout = io.StringIO()
    f_stderr = io.StringIO()
    
    try:
        yolo = _get_yolo_model(model_file, model_path, yolo_device)
        with redirect_stdout(f_stdout), redirect_stderr(f_stderr):
            results = yolo.predict(image_path, imgsz=yolo_imgsz, conf=yolo_conf, device=yolo_device, verbose=True)
        verbose_log = log_capture_string.getvalue() + f_stdout.getvalue() + f_stderr.getvalue()
    except Exception as e:
        verbose_log = log_capture_string.getvalue() + f_stdout.getvalue() + f_stderr.getvalue() + f"\nError: {str(e)}"
        raise HTTPException(status_code=500, detail=f"YOLO inference error: {str(e)}")
    finally:
        yolo_logger.removeHandler(ch)

    # Render Preview Image
    img = cv2.imread(image_path)
    if img is None:
        raise HTTPException(status_code=500, detail="Failed to load input image for rendering preview")

    h, w = img.shape[:2]

    # Process detections
    detected_objects = []
    if results and len(results) > 0:
        res = results[0]
        boxes = res.boxes
        masks = res.masks

        # Loop to draw predictions
        for i, box in enumerate(boxes):
            cls_id = int(box.cls[0].item())
            conf_val = float(box.conf[0].item())
            
            # Map detected class
            bind_val = class_bindings.get(str(cls_id)) # key in JSON is always string
            
            target_class_name = None
            target_color = "#3b82f6" # default blue
            
            if bind_val is not None and bind_val != "" and int(bind_val) < len(input_classes):
                mapped_idx = int(bind_val)
                target_class_name = input_classes[mapped_idx]["name"]
                target_color = input_classes[mapped_idx]["color"]
            else:
                # If setting bind class is empty, fallback to model's default classes
                if cls_id < len(yolo.names):
                    target_class_name = yolo.names[cls_id]
                else:
                    target_class_name = f"Class {cls_id}"

            bgr = hex_to_bgr(target_color)

            # Draw polygon if mask is available
            has_drawn_mask = False
            if masks is not None and len(masks.xyn) > i:
                poly_pts = masks.xyn[i]
                if len(poly_pts) >= 3:
                    pts_px = np.array([[int(p[0]*w), int(p[1]*h)] for p in poly_pts], dtype=np.int32)
                    
                    # Fill color 30%
                    overlay = img.copy()
                    cv2.fillPoly(overlay, [pts_px], bgr)
                    cv2.addWeighted(overlay, 0.3, img, 0.7, 0, img)
                    
                    # Draw outline
                    cv2.polylines(img, [pts_px], True, bgr, 2)
                    has_drawn_mask = True
                    
                    # Label position
                    min_y_idx = np.argmin(pts_px[:, 1])
                    lbl_x = int(pts_px[min_y_idx][0])
                    lbl_y = int(pts_px[min_y_idx][1])
            
            # Draw bbox if no mask drawn
            if not has_drawn_mask:
                xyxy = box.xyxy[0].cpu().numpy()
                x1, y1, x2, y2 = int(xyxy[0]), int(xyxy[1]), int(xyxy[2]), int(xyxy[3])
                
                # Fill color 30%
                overlay = img.copy()
                cv2.rectangle(overlay, (x1, y1), (x2, y2), bgr, -1)
                cv2.addWeighted(overlay, 0.3, img, 0.7, 0, img)
                
                # Draw outline
                cv2.rectangle(img, (x1, y1), (x2, y2), bgr, 2)
                lbl_x, lbl_y = x1, y1

            # Draw text label
            lbl_txt = f"{target_class_name} {conf_val:.2f}"
            (tw, th), baseline = cv2.getTextSize(lbl_txt, cv2.FONT_HERSHEY_SIMPLEX, 0.4, 1)
            cv2.rectangle(img, (lbl_x, lbl_y - th - 5), (lbl_x + tw + 6, lbl_y + baseline), bgr, -1)
            cv2.putText(img, lbl_txt, (lbl_x + 3, lbl_y - 2), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (255, 255, 255), 1, cv2.LINE_AA)

            detected_objects.append({
                "class_id": cls_id,
                "class_name": target_class_name,
                "confidence": conf_val
            })

    # Encode image to Base64
    _, buffer = cv2.imencode(".jpg", img)
    preview_b64 = base64.b64encode(buffer).decode("utf-8")

    return {
        "success": True,
        "filename": os.path.basename(image_path),
        "preview": preview_b64,
        "detections": detected_objects,
        "verbose_log": verbose_log,
        "is_folder_mode": is_folder_mode,
        "current_index": current_index,
        "total_images": total_images
    }

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=args.port)
