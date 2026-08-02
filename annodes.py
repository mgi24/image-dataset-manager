import os
import sys
import json
import sqlite3
import base64
import argparse
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse, FileResponse, StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Optional, Dict, Any
import cv2
import numpy as np
import threading
import queue
import concurrent.futures

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

# SAM3 model cache
_sam3_predictors = {}
_sam3_model_lock = threading.Lock()

def _get_sam3_predictor(model_name: str, model_path: str, device: str, conf: float):
    global _sam3_predictors
    key = (model_name, device, conf)
    if key not in _sam3_predictors:
        with _sam3_model_lock:
            if key not in _sam3_predictors:
                from ultralytics.models.sam import SAM3SemanticPredictor
                overrides = dict(
                    conf=conf,
                    task="segment",
                    mode="predict",
                    model=model_path,
                    save=False,
                    device=device,
                    half=False,
                    verbose=True
                )
                predictor = SAM3SemanticPredictor(overrides=overrides)
                _sam3_predictors[key] = predictor
    return _sam3_predictors[key]

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
        # Always append CPU option
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

def calculate_iou(annoA, annoB, h, w):
    def get_bbox(anno):
        coords = anno["coords"]
        is_segment = anno.get("is_segment", len(coords) > 4)
        if is_segment:
            xs = coords[0::2]
            ys = coords[1::2]
            if len(xs) > 0 and len(ys) > 0:
                return int(min(xs)*w), int(min(ys)*h), int(max(xs)*w), int(max(ys)*h)
        else:
            if len(coords) >= 4:
                xc, yc, bw, bh = coords[0], coords[1], coords[2], coords[3]
                return int((xc - bw/2)*w), int((yc - bh/2)*h), int((xc + bw/2)*w), int((yc + bh/2)*h)
        return 0, 0, 0, 0

    ax1, ay1, ax2, ay2 = get_bbox(annoA)
    bx1, by1, bx2, by2 = get_bbox(annoB)

    # Check intersection
    ix1 = max(ax1, bx1)
    iy1 = max(ay1, by1)
    ix2 = min(ax2, bx2)
    iy2 = min(ay2, by2)

    if ix2 <= ix1 or iy2 <= iy1:
        return 0.0

    # Union bounding box
    ux1 = min(ax1, bx1)
    uy1 = min(ay1, by1)
    ux2 = max(ax2, bx2)
    uy2 = max(ay2, by2)

    uw = ux2 - ux1
    uh = uy2 - uy1
    if uw <= 0 or uh <= 0:
        return 0.0

    # Draw offset masks
    maskA = np.zeros((uh, uw), dtype=np.uint8)
    maskB = np.zeros((uh, uw), dtype=np.uint8)

    def draw_mask(mask, anno, ox, oy):
        coords = anno["coords"]
        is_segment = anno.get("is_segment", len(coords) > 4)
        if is_segment:
            pts_px = np.array([[int(coords[i]*w) - ox, int(coords[i+1]*h) - oy] for i in range(0, len(coords), 2)], dtype=np.int32)
            if len(pts_px) >= 3:
                cv2.fillPoly(mask, [pts_px], 255)
        else:
            if len(coords) >= 4:
                xc, yc, bw, bh = coords[0], coords[1], coords[2], coords[3]
                x1 = int((xc - bw/2)*w) - ox
                y1 = int((yc - bh/2)*h) - oy
                x2 = int((xc + bw/2)*w) - ox
                y2 = int((yc + bh/2)*h) - oy
                cv2.rectangle(mask, (x1, y1), (x2, y2), 255, -1)

    draw_mask(maskA, annoA, ux1, uy1)
    draw_mask(maskB, annoB, ux1, uy1)

    intersection = np.logical_and(maskA, maskB).sum()
    union = np.logical_or(maskA, maskB).sum()

    return float(intersection) / float(union) if union > 0 else 0.0

@app.post("/api/run-flow")
def run_flow(payload: RunFlowRequest):
    nodes = {n["id"]: n for n in payload.nodes}
    
    # Map connection targets: connections_to[(toNodeId, toPinName)] = (fromNodeId, fromPinName)
    connections_to = {}
    for conn in payload.connections:
        to_node = conn.get("toNodeId")
        to_pin = conn.get("toPinName")
        from_node = conn.get("fromNodeId")
        from_pin = conn.get("fromPinName")
        if to_node and to_pin:
            connections_to[(to_node, to_pin)] = (from_node, from_pin)

    # State & Caching for sequential folder node processing
    is_folder_mode = False
    total_images = 0
    current_index = 0
    current_image_filename = ""

    # Pre-evaluate folder mode if any folder node exists, to advance index
    folder_node = None
    for n in payload.nodes:
        if n["type"] == "folder":
            folder_node = n
            break

    if folder_node:
        is_folder_mode = True
        images_dir = folder_node["properties"].get("images_dir", "").strip()
        if not images_dir or not os.path.exists(images_dir):
            raise HTTPException(status_code=400, detail=f"Images directory '{images_dir}' does not exist")
        
        img_extensions = ('.jpg', '.jpeg', '.png')
        images = sorted([f for f in os.listdir(images_dir) if f.lower().endswith(img_extensions)])
        total_images = len(images)
        if total_images == 0:
            raise HTTPException(status_code=400, detail=f"No images found in folder '{images_dir}'")
            
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        cursor.execute("SELECT current_index FROM flow_state LIMIT 1")
        row = cursor.fetchone()
        current_index = row[0] if row else 0
        if current_index >= total_images:
            current_index = 0
            
        current_image_filename = images[current_index]
        
        # Advance index for next run
        next_idx = (current_index + 1) % total_images
        cursor.execute("UPDATE flow_state SET current_index = ?", (next_idx,))
        conn.commit()
        conn.close()

    # Cache for evaluation
    event_queue = queue.Queue()
    eval_cache = {}
    previews = {}
    logs = {}
    cache_lock = threading.RLock()

    def evaluate(node_id: str, pin_name: str):
        cache_key = (node_id, pin_name)
        with cache_lock:
            if cache_key in eval_cache:
                return eval_cache[cache_key]

        node = nodes.get(node_id)
        if not node:
            raise HTTPException(status_code=400, detail=f"Node {node_id} not found in canvas")

        # 1. Input Nodes
        if node["type"] in ("single_image", "folder"):
            # Setup image path
            if node["type"] == "folder":
                images_dir = node["properties"].get("images_dir", "").strip()
                labels_dir = node["properties"].get("labels_dir", "").strip()
                
                img_path = os.path.join(images_dir, current_image_filename)
                
                # Setup annotation path
                anno_path = None
                if labels_dir and os.path.exists(labels_dir):
                    label_name = os.path.splitext(current_image_filename)[0] + ".txt"
                    cand_label = os.path.join(labels_dir, label_name)
                    if os.path.exists(cand_label):
                        anno_path = cand_label
            else:
                img_path = node["properties"].get("image_path", "").strip()
                anno_path = node["properties"].get("annotation_path", "").strip()
                if not anno_path:
                    anno_path = None

            # Parse annotations
            parsed_annotations = []
            if anno_path:
                if not os.path.exists(anno_path):
                    raise HTTPException(status_code=400, detail=f"Annotation file '{anno_path}' not found")
                try:
                    with open(anno_path, "r", encoding="utf-8") as f:
                        for line_idx, line in enumerate(f):
                            line = line.strip()
                            if not line:
                                continue
                            parts = line.split()
                            class_id = int(parts[0])
                            coords = [float(x) for x in parts[1:]]
                            if len(coords) < 4:
                                raise ValueError(f"Too few coordinates on line {line_idx+1}")
                            parsed_annotations.append({
                                "class_id": class_id,
                                "coords": coords,
                                "is_segment": len(coords) > 4
                            })
                except Exception as e:
                    raise HTTPException(status_code=400, detail=f"Failed to parse annotation file '{anno_path}': {str(e)}")

            # Parse classes
            raw_classes = node["properties"].get("classes", [])
            node_classes = []
            for idx, c in enumerate(raw_classes):
                node_classes.append({
                    "index": idx,
                    "name": c.get("name", f"Class {idx}"),
                    "color": c.get("color", "#a855f7")
                })

            with cache_lock:
                # Cache all outputs for this input node
                eval_cache[(node_id, "image")] = img_path
                eval_cache[(node_id, "annotation")] = parsed_annotations
                eval_cache[(node_id, "class")] = node_classes

                return eval_cache[cache_key]

        # 2. YOLO Node
        elif node["type"] == "yolo_detector":
            event_queue.put({"type": "start", "node_id": node_id})
            
            # Get connected image input
            img_source = connections_to.get((node_id, "image"))
            if not img_source:
                event_queue.put({"type": "end", "node_id": node_id})
                raise HTTPException(status_code=400, detail="YOLO Detector node is missing connected 'Image' input")
            src_image_path = evaluate(img_source[0], img_source[1])

            # Get connected class input
            class_source = connections_to.get((node_id, "class"))
            src_classes = []
            if class_source:
                src_classes = evaluate(class_source[0], class_source[1])

            # Configure settings
            yolo_model_name = node["properties"].get("model", "yolov8x-seg").strip()
            yolo_imgsz = int(node["properties"].get("imgsz", 640))
            yolo_conf = float(node["properties"].get("conf", 0.25))
            yolo_verbose = bool(node["properties"].get("verbose", False))
            yolo_device = node["properties"].get("device", "cuda:0")
            class_bindings = node["properties"].get("class_bindings", {})

            if not yolo_model_name.endswith(".pt"):
                model_file = f"{yolo_model_name}.pt"
            else:
                model_file = yolo_model_name
            model_path = os.path.join(MODEL_DIR, model_file)
            if not os.path.exists(model_path):
                event_queue.put({"type": "end", "node_id": node_id})
                raise HTTPException(status_code=400, detail=f"YOLO model '{model_file}' not found in model/ folder")

            # Capture stdout/stderr/logging
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
                    results = yolo.predict(src_image_path, imgsz=yolo_imgsz, conf=yolo_conf, device=yolo_device, verbose=True)
                verbose_log = log_capture_string.getvalue() + f_stdout.getvalue() + f_stderr.getvalue()
            except Exception as e:
                verbose_log = log_capture_string.getvalue() + f_stdout.getvalue() + f_stderr.getvalue() + f"\nError: {str(e)}"
                event_queue.put({"type": "end", "node_id": node_id})
                raise HTTPException(status_code=500, detail=f"YOLO inference error: {str(e)}")
            finally:
                yolo_logger.removeHandler(ch)

            # Process YOLO outputs
            yolo_annotations = []
            detected_objects_summary = []
            
            # Load raw image to draw YOLO preview
            img = cv2.imread(src_image_path)
            if img is None:
                event_queue.put({"type": "end", "node_id": node_id})
                raise HTTPException(status_code=500, detail=f"Failed to load image '{src_image_path}' for YOLO preview")
            h, w = img.shape[:2]

            if results and len(results) > 0:
                res = results[0]
                boxes = res.boxes
                masks = res.masks

                for i, box in enumerate(boxes):
                    cls_id = int(box.cls[0].item())
                    conf_val = float(box.conf[0].item())
                    
                    # Map to custom class index if bound
                    bind_val = class_bindings.get(str(cls_id))
                    
                    target_class_name = None
                    target_color = "#3b82f6" # default blue
                    mapped_class_id = cls_id
                    
                    if bind_val is not None and bind_val != "" and int(bind_val) < len(src_classes):
                        mapped_class_id = int(bind_val)
                        target_class_name = src_classes[mapped_class_id]["name"]
                        target_color = src_classes[mapped_class_id]["color"]
                    else:
                        if cls_id < len(yolo.names):
                            target_class_name = yolo.names[cls_id]
                        else:
                            target_class_name = f"Class {cls_id}"

                    bgr = hex_to_bgr(target_color)

                    # Check coordinates
                    coords = []
                    is_segment = False
                    if masks is not None and len(masks.xyn) > i:
                        poly_pts = masks.xyn[i]
                        if len(poly_pts) >= 3:
                            # Flatten coordinates
                            for pt in poly_pts:
                                coords.extend([float(pt[0]), float(pt[1])])
                            is_segment = True
                            
                            # Draw preview polygon
                            pts_px = np.array([[int(pt[0]*w), int(pt[1]*h)] for pt in poly_pts], dtype=np.int32)
                            overlay = img.copy()
                            cv2.fillPoly(overlay, [pts_px], bgr)
                            cv2.addWeighted(overlay, 0.3, img, 0.7, 0, img)
                            cv2.polylines(img, [pts_px], True, bgr, 2)
                            min_y_idx = np.argmin(pts_px[:, 1])
                            lbl_x = int(pts_px[min_y_idx][0])
                            lbl_y = int(pts_px[min_y_idx][1])
                    
                    if not is_segment:
                        # bounding box normalized coordinates
                        xywhn = box.xywhn[0].cpu().numpy()
                        coords = [float(c) for c in xywhn] # [xc, yc, w, h]
                        
                        # Draw preview box
                        xyxy = box.xyxy[0].cpu().numpy()
                        x1, y1, x2, y2 = int(xyxy[0]), int(xyxy[1]), int(xyxy[2]), int(xyxy[3])
                        overlay = img.copy()
                        cv2.rectangle(overlay, (x1, y1), (x2, y2), bgr, -1)
                        cv2.addWeighted(overlay, 0.3, img, 0.7, 0, img)
                        cv2.rectangle(img, (x1, y1), (x2, y2), bgr, 2)
                        lbl_x, lbl_y = x1, y1

                    # Draw text label on YOLO preview
                    lbl_txt = f"{target_class_name} {conf_val:.2f}"
                    (tw, th), baseline = cv2.getTextSize(lbl_txt, cv2.FONT_HERSHEY_SIMPLEX, 0.4, 1)
                    cv2.rectangle(img, (lbl_x, lbl_y - th - 5), (lbl_x + tw + 6, lbl_y + baseline), bgr, -1)
                    cv2.putText(img, lbl_txt, (lbl_x + 3, lbl_y - 2), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (255, 255, 255), 1, cv2.LINE_AA)

                    yolo_annotations.append({
                        "class_id": mapped_class_id,
                        "coords": coords,
                        "is_segment": is_segment,
                        "confidence": conf_val
                    })
                    
                    detected_objects_summary.append({
                        "class_name": target_class_name,
                        "confidence": conf_val
                    })

            # Base64 encode YOLO preview image
            _, buffer = cv2.imencode(".jpg", img)
            preview_b64 = base64.b64encode(buffer).decode("utf-8")

            # Generate YOLO node logs HTML
            log_html = ""
            if verbose_log:
                escaped_verbose = verbose_log.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
                log_html += f'<div style="color:var(--text-muted); border-bottom:1px dashed var(--border); padding-bottom:6px; margin-bottom:6px; font-weight:normal;">{escaped_verbose}</div>'
            if detected_objects_summary:
                log_html += "<div><strong>Detections:</strong></div>"
                for det in detected_objects_summary:
                    log_html += f"<div>• {det['class_name']}: {det['confidence']*100:.1f}%</div>"
            else:
                log_html += '<div style="color:var(--text-muted);">No detections</div>'

            with cache_lock:
                previews[node_id] = preview_b64
                logs[node_id] = log_html
                # Cache YOLO output pins
                eval_cache[(node_id, "image")] = src_image_path
                eval_cache[(node_id, "annotation")] = yolo_annotations
                eval_cache[(node_id, "class")] = src_classes

            event_queue.put({"type": "end", "node_id": node_id})
            event_queue.put({
                "type": "preview",
                "node_id": node_id,
                "preview": preview_b64,
                "logs": log_html
            })

            return eval_cache[cache_key]

        # 3. SAM3 Node
        elif node["type"] == "sam3":
            event_queue.put({"type": "start", "node_id": node_id})

            # Get connected image input
            img_source = connections_to.get((node_id, "image"))
            if not img_source:
                event_queue.put({"type": "end", "node_id": node_id})
                raise HTTPException(status_code=400, detail="SAM3 node is missing connected 'Image' input")
            src_image_path = evaluate(img_source[0], img_source[1])

            # Get connected class input
            class_source = connections_to.get((node_id, "class"))
            src_classes = []
            if class_source:
                src_classes = evaluate(class_source[0], class_source[1])

            # Configure settings
            sam3_model_name = node["properties"].get("model", "sam3.pt").strip()
            sam3_imgsz = int(node["properties"].get("imgsz", 640))
            sam3_conf = float(node["properties"].get("conf", 0.25))
            sam3_verbose = bool(node["properties"].get("verbose", False))
            sam3_device = node["properties"].get("device", "cuda:0")
            prompt_bindings = node["properties"].get("prompt_bindings", {})

            if not sam3_model_name.endswith(".pt"):
                model_file = f"{sam3_model_name}.pt"
            else:
                model_file = sam3_model_name
            model_path = os.path.join(MODEL_DIR, model_file)
            if not os.path.exists(model_path):
                event_queue.put({"type": "end", "node_id": node_id})
                raise HTTPException(status_code=400, detail=f"SAM3 model '{model_file}' not found in model/ folder")

            # Extract list of prompt texts from keys of prompt_bindings
            prompts = [p.strip() for p in prompt_bindings.keys() if p.strip()]

            if not prompts:
                # If no prompts are defined, return empty
                # Copy image for preview (or just load it)
                img = cv2.imread(src_image_path)
                if img is not None:
                    _, buffer = cv2.imencode(".jpg", img)
                    preview_b64 = base64.b64encode(buffer).decode("utf-8")
                else:
                    preview_b64 = ""
                
                log_html = '<div style="color:var(--text-muted);">No prompts configured in prompt bindings. Add a prompt binding first.</div>'
                
                with cache_lock:
                    eval_cache[(node_id, "image")] = src_image_path
                    eval_cache[(node_id, "annotation")] = []
                    eval_cache[(node_id, "class")] = src_classes
                    previews[node_id] = preview_b64
                    logs[node_id] = log_html

                event_queue.put({"type": "end", "node_id": node_id})
                event_queue.put({
                    "type": "preview",
                    "node_id": node_id,
                    "preview": preview_b64,
                    "logs": log_html
                })
                
                return eval_cache[cache_key]

            # Capture stdout/stderr/logging
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
                predictor = _get_sam3_predictor(model_file, model_path, sam3_device, sam3_conf)
                predictor.set_image(src_image_path)
                with redirect_stdout(f_stdout), redirect_stderr(f_stderr):
                    results = predictor(text=prompts)
                verbose_log = log_capture_string.getvalue() + f_stdout.getvalue() + f_stderr.getvalue()
            except Exception as e:
                verbose_log = log_capture_string.getvalue() + f_stdout.getvalue() + f_stderr.getvalue() + f"\nError: {str(e)}"
                event_queue.put({"type": "end", "node_id": node_id})
                raise HTTPException(status_code=500, detail=f"SAM3 inference error: {str(e)}")
            finally:
                yolo_logger.removeHandler(ch)

            # Process SAM3 outputs
            sam3_annotations = []
            detected_objects_summary = []
            
            # Load raw image to draw SAM3 preview
            img = cv2.imread(src_image_path)
            if img is None:
                event_queue.put({"type": "end", "node_id": node_id})
                raise HTTPException(status_code=500, detail=f"Failed to load image '{src_image_path}' for SAM3 preview")
            h, w = img.shape[:2]

            if results and len(results) > 0:
                res = results[0]
                boxes = res.boxes
                masks = res.masks

                if boxes is not None:
                    for i, box in enumerate(boxes):
                        cls_id = int(box.cls[0].item())
                        conf_val = float(box.conf[0].item())
                        
                        # Get prompt string for this class id
                        prompt_str = prompts[cls_id] if cls_id < len(prompts) else f"Class {cls_id}"
                        
                        # Map to custom class index if bound
                        bind_val = prompt_bindings.get(prompt_str)
                        
                        target_class_name = prompt_str
                        target_color = "#3b82f6" # default blue
                        mapped_class_id = cls_id
                        
                        if bind_val is not None and bind_val != "" and int(bind_val) < len(src_classes):
                            mapped_class_id = int(bind_val)
                            target_class_name = src_classes[mapped_class_id]["name"]
                            target_color = src_classes[mapped_class_id]["color"]

                        bgr = hex_to_bgr(target_color)

                        # Check coordinates
                        coords = []
                        is_segment = False
                        if masks is not None and len(masks.xyn) > i:
                            poly_pts = masks.xyn[i]
                            if len(poly_pts) >= 3:
                                # Flatten coordinates
                                for pt in poly_pts:
                                    coords.extend([float(pt[0]), float(pt[1])])
                                is_segment = True
                                
                                # Draw preview polygon
                                pts_px = np.array([[int(pt[0]*w), int(pt[1]*h)] for pt in poly_pts], dtype=np.int32)
                                overlay = img.copy()
                                cv2.fillPoly(overlay, [pts_px], bgr)
                                cv2.addWeighted(overlay, 0.3, img, 0.7, 0, img)
                                cv2.polylines(img, [pts_px], True, bgr, 2)
                                min_y_idx = np.argmin(pts_px[:, 1])
                                lbl_x = int(pts_px[min_y_idx][0])
                                lbl_y = int(pts_px[min_y_idx][1])
                        
                        if not is_segment:
                            # bounding box normalized coordinates
                            xywhn = box.xywhn[0].cpu().numpy()
                            coords = [float(c) for c in xywhn] # [xc, yc, w, h]
                            
                            # Draw preview box
                            xyxy = box.xyxy[0].cpu().numpy()
                            x1, y1, x2, y2 = int(xyxy[0]), int(xyxy[1]), int(xyxy[2]), int(xyxy[3])
                            overlay = img.copy()
                            cv2.rectangle(overlay, (x1, y1), (x2, y2), bgr, -1)
                            cv2.addWeighted(overlay, 0.3, img, 0.7, 0, img)
                            cv2.rectangle(img, (x1, y1), (x2, y2), bgr, 2)
                            lbl_x, lbl_y = x1, y1

                        # Draw text label on SAM3 preview
                        lbl_txt = f"{target_class_name} {conf_val:.2f}"
                        (tw, th), baseline = cv2.getTextSize(lbl_txt, cv2.FONT_HERSHEY_SIMPLEX, 0.4, 1)
                        cv2.rectangle(img, (lbl_x, lbl_y - th - 5), (lbl_x + tw + 6, lbl_y + baseline), bgr, -1)
                        cv2.putText(img, lbl_txt, (lbl_x + 3, lbl_y - 2), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (255, 255, 255), 1, cv2.LINE_AA)

                        sam3_annotations.append({
                            "class_id": mapped_class_id,
                            "coords": coords,
                            "is_segment": is_segment,
                            "confidence": conf_val
                        })
                        
                        detected_objects_summary.append({
                            "class_name": target_class_name,
                            "confidence": conf_val
                        })

            # Base64 encode SAM3 preview image
            _, buffer = cv2.imencode(".jpg", img)
            preview_b64 = base64.b64encode(buffer).decode("utf-8")

            # Generate SAM3 node logs HTML
            log_html = ""
            if verbose_log:
                escaped_verbose = verbose_log.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
                log_html += f'<div style="color:var(--text-muted); border-bottom:1px dashed var(--border); padding-bottom:6px; margin-bottom:6px; font-weight:normal;">{escaped_verbose}</div>'
            if detected_objects_summary:
                log_html += "<div><strong>Detections:</strong></div>"
                for det in detected_objects_summary:
                    log_html += f"<div>• {det['class_name']}: {det['confidence']*100:.1f}%</div>"
            else:
                log_html += '<div style="color:var(--text-muted);">No detections</div>'

            with cache_lock:
                previews[node_id] = preview_b64
                logs[node_id] = log_html
                # Cache SAM3 output pins
                eval_cache[(node_id, "image")] = src_image_path
                eval_cache[(node_id, "annotation")] = sam3_annotations
                eval_cache[(node_id, "class")] = src_classes

            event_queue.put({"type": "end", "node_id": node_id})
            event_queue.put({
                "type": "preview",
                "node_id": node_id,
                "preview": preview_b64,
                "logs": log_html
            })

            return eval_cache[cache_key]

        raise HTTPException(status_code=400, detail=f"Cannot evaluate output pin {pin_name} on node {node_id}")

    def run_all():
        try:
            preview_nodes = [n for n in payload.nodes if n["type"] in ("preview", "overlap_comparator")]
            
            if preview_nodes:
                def process_preview(n):
                    p_node_id = n["id"]
                    if n["type"] == "preview":
                        img_source = connections_to.get((p_node_id, "image"))
                        anno_source = connections_to.get((p_node_id, "annotation"))
                        class_source = connections_to.get((p_node_id, "class"))

                        if not img_source or not anno_source:
                            event_queue.put({"type": "error", "message": "Preview node is missing connected 'Image' or 'Annotation' input"})
                            return

                        event_queue.put({"type": "start", "node_id": p_node_id})

                        try:
                            src_image_path = evaluate(img_source[0], img_source[1])
                            src_annotations = evaluate(anno_source[0], anno_source[1])
                            
                            src_classes = []
                            if class_source:
                                src_classes = evaluate(class_source[0], class_source[1])

                            img = cv2.imread(src_image_path)
                            if img is None:
                                event_queue.put({"type": "end", "node_id": p_node_id})
                                event_queue.put({"type": "error", "message": f"Failed to load image '{src_image_path}' for Preview rendering"})
                                return
                            
                            h, w = img.shape[:2]
                            annotated_img = img.copy()
                            detection_crops_b64 = []

                            for anno in src_annotations:
                                class_id = anno["class_id"]
                                coords = anno["coords"]
                                is_segment = anno.get("is_segment", len(coords) > 4)
                                conf = anno.get("confidence")

                                target_name = f"Class {class_id}"
                                target_color = "#10b981"
                                if class_id < len(src_classes):
                                    target_name = src_classes[class_id]["name"]
                                    target_color = src_classes[class_id]["color"]
                                
                                bgr = hex_to_bgr(target_color)

                                lbl_x, lbl_y = 0, 0
                                if is_segment:
                                    pts_px = np.array([[int(coords[i]*w), int(coords[i+1]*h)] for i in range(0, len(coords), 2)], dtype=np.int32)
                                    if len(pts_px) >= 3:
                                        overlay = annotated_img.copy()
                                        cv2.fillPoly(overlay, [pts_px], bgr)
                                        cv2.addWeighted(overlay, 0.3, annotated_img, 0.7, 0, annotated_img)
                                        cv2.polylines(annotated_img, [pts_px], True, bgr, 2)
                                        
                                        min_y_idx = np.argmin(pts_px[:, 1])
                                        lbl_x = int(pts_px[min_y_idx][0])
                                        lbl_y = int(pts_px[min_y_idx][1])
                                else:
                                    if len(coords) >= 4:
                                        xc, yc, bw, bh = coords[0], coords[1], coords[2], coords[3]
                                        x1 = int((xc - bw/2) * w)
                                        y1 = int((yc - bh/2) * h)
                                        x2 = int((xc + bw/2) * w)
                                        y2 = int((yc + bh/2) * h)
                                        
                                        overlay = annotated_img.copy()
                                        cv2.rectangle(overlay, (x1, y1), (x2, y2), bgr, -1)
                                        cv2.addWeighted(overlay, 0.3, annotated_img, 0.7, 0, annotated_img)
                                        cv2.rectangle(annotated_img, (x1, y1), (x2, y2), bgr, 2)
                                        lbl_x, lbl_y = x1, y1

                                if class_source:
                                    lbl_txt = target_name
                                    if conf is not None:
                                        lbl_txt += f" {conf:.2f}"
                                    (tw, th), baseline = cv2.getTextSize(lbl_txt, cv2.FONT_HERSHEY_SIMPLEX, 0.4, 1)
                                    cv2.rectangle(annotated_img, (lbl_x, lbl_y - th - 5), (lbl_x + tw + 6, lbl_y + baseline), bgr, -1)
                                    cv2.putText(annotated_img, lbl_txt, (lbl_x + 3, lbl_y - 2), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (255, 255, 255), 1, cv2.LINE_AA)

                                # Calculate crop BBox
                                if is_segment:
                                    xs = coords[0::2]
                                    ys = coords[1::2]
                                    if len(xs) > 0 and len(ys) > 0:
                                        xmin, xmax = min(xs), max(xs)
                                        ymin, ymax = min(ys), max(ys)
                                        cx1 = int(xmin * w)
                                        cy1 = int(ymin * h)
                                        cx2 = int(xmax * w)
                                        cy2 = int(ymax * h)
                                    else:
                                        continue
                                else:
                                    if len(coords) >= 4:
                                        xc, yc, bw, bh = coords[0], coords[1], coords[2], coords[3]
                                        cx1 = int((xc - bw/2) * w)
                                        cy1 = int((yc - bh/2) * h)
                                        cx2 = int((xc + bw/2) * w)
                                        cy2 = int((yc + bh/2) * h)
                                    else:
                                        continue

                                cx1 = max(0, min(cx1, w - 1))
                                cx2 = max(0, min(cx2, w - 1))
                                cy1 = max(0, min(cy1, h - 1))
                                cy2 = max(0, min(cy2, h - 1))

                                crop_w = cx2 - cx1
                                crop_h = cy2 - cy1
                                if crop_w <= 0 or crop_h <= 0:
                                    continue

                                left_crop = img[cy1:cy2, cx1:cx2].copy()
                                if is_segment:
                                    pts_px = np.array([[int(coords[i]*w), int(coords[i+1]*h)] for i in range(0, len(coords), 2)], dtype=np.int32)
                                    pts_offset = pts_px - [cx1, cy1]
                                    if len(pts_offset) >= 3:
                                        overlay_crop = left_crop.copy()
                                        cv2.fillPoly(overlay_crop, [pts_offset], bgr)
                                        cv2.addWeighted(overlay_crop, 0.3, left_crop, 0.7, 0, left_crop)
                                        cv2.polylines(left_crop, [pts_offset], True, bgr, 2)
                                else:
                                    overlay_crop = left_crop.copy()
                                    cv2.rectangle(overlay_crop, (0, 0), (crop_w, crop_h), bgr, -1)
                                    cv2.addWeighted(overlay_crop, 0.3, left_crop, 0.7, 0, left_crop)
                                    cv2.rectangle(left_crop, (0, 0), (crop_w, crop_h), bgr, 2)

                                mask = np.zeros((h, w), dtype=np.uint8)
                                if is_segment:
                                    pts_px = np.array([[int(coords[i]*w), int(coords[i+1]*h)] for i in range(0, len(coords), 2)], dtype=np.int32)
                                    if len(pts_px) >= 3:
                                        cv2.fillPoly(mask, [pts_px], 255)
                                else:
                                    cv2.rectangle(mask, (cx1, cy1), (cx2, cy2), 255, -1)

                                masked_img = cv2.bitwise_and(img, img, mask=mask)
                                right_crop = masked_img[cy1:cy2, cx1:cx2].copy()

                                # Horizontal concatenation at full resolution (no resize)
                                row_img = np.hstack([left_crop, right_crop])
                                cv2.line(row_img, (crop_w, 0), (crop_w, crop_h), (80, 80, 80), 2)

                                _, crop_buf = cv2.imencode(".jpg", row_img)
                                crop_b64 = base64.b64encode(crop_buf).decode("utf-8")
                                detection_crops_b64.append(crop_b64)

                            # Encode overall image at its ORIGINAL resolution (No Resize)
                            _, top_buf = cv2.imencode(".jpg", annotated_img)
                            overall_b64 = base64.b64encode(top_buf).decode("utf-8")

                            with cache_lock:
                                previews[p_node_id] = [overall_b64] + detection_crops_b64

                            event_queue.put({"type": "end", "node_id": p_node_id})
                            event_queue.put({
                                "type": "preview",
                                "node_id": p_node_id,
                                "preview": previews[p_node_id],
                                "logs": ""
                            })
                        except Exception as ex:
                            event_queue.put({"type": "end", "node_id": p_node_id})
                            event_queue.put({"type": "error", "message": f"Preview node error: {str(ex)}"})

                    elif n["type"] == "overlap_comparator":
                        # Resolve inputs
                        img_source = connections_to.get((p_node_id, "image"))
                        class_source = connections_to.get((p_node_id, "class"))

                        if not img_source:
                            event_queue.put({"type": "error", "message": "Overlap Comparator node is missing connected 'Image' input"})
                            return

                        event_queue.put({"type": "start", "node_id": p_node_id})

                        try:
                            src_image_path = evaluate(img_source[0], img_source[1])
                            
                            src_classes = []
                            if class_source:
                                src_classes = evaluate(class_source[0], class_source[1])

                            input_pins = n["properties"].get("input_pins", ["image", "annotation1", "annotation2"])
                            annotation_inputs = []
                            for pin_name in input_pins:
                                if pin_name.startswith("annotation"):
                                    anno_src = connections_to.get((p_node_id, pin_name))
                                    pin_idx_str = pin_name.replace("annotation", "")
                                    pin_label = f"Annotation {pin_idx_str}"
                                    if anno_src:
                                        annos = evaluate(anno_src[0], anno_src[1])
                                        annotation_inputs.append((pin_label, annos))

                            img = cv2.imread(src_image_path)
                            if img is None:
                                event_queue.put({"type": "end", "node_id": p_node_id})
                                event_queue.put({"type": "error", "message": f"Failed to load image '{src_image_path}' for Overlap Comparator rendering"})
                                return
                            
                            h, w = img.shape[:2]
                            preview_items = []

                            # --- 1. RAW SECTION ---
                            for pin_label, annos in annotation_inputs:
                                raw_annotated = img.copy()
                                for anno in annos:
                                    class_id = anno["class_id"]
                                    coords = anno["coords"]
                                    is_segment = anno.get("is_segment", len(coords) > 4)
                                    
                                    target_name = f"Class {class_id}"
                                    target_color = "#10b981"
                                    if class_id < len(src_classes):
                                        target_name = src_classes[class_id]["name"]
                                        target_color = src_classes[class_id]["color"]
                                    bgr = hex_to_bgr(target_color)

                                    lbl_x, lbl_y = 0, 0
                                    if is_segment:
                                        pts_px = np.array([[int(coords[i]*w), int(coords[i+1]*h)] for i in range(0, len(coords), 2)], dtype=np.int32)
                                        if len(pts_px) >= 3:
                                            overlay = raw_annotated.copy()
                                            cv2.fillPoly(overlay, [pts_px], bgr)
                                            cv2.addWeighted(overlay, 0.3, raw_annotated, 0.7, 0, raw_annotated)
                                            cv2.polylines(raw_annotated, [pts_px], True, bgr, 2)
                                            min_y_idx = np.argmin(pts_px[:, 1])
                                            lbl_x, lbl_y = int(pts_px[min_y_idx][0]), int(pts_px[min_y_idx][1])
                                    else:
                                        if len(coords) >= 4:
                                            xc, yc, bw, bh = coords[0], coords[1], coords[2], coords[3]
                                            x1 = int((xc - bw/2) * w)
                                            y1 = int((yc - bh/2) * h)
                                            x2 = int((xc + bw/2) * w)
                                            y2 = int((yc + bh/2) * h)
                                            overlay = raw_annotated.copy()
                                            cv2.rectangle(overlay, (x1, y1), (x2, y2), bgr, -1)
                                            cv2.addWeighted(overlay, 0.3, raw_annotated, 0.7, 0, raw_annotated)
                                            cv2.rectangle(raw_annotated, (x1, y1), (x2, y2), bgr, 2)
                                            lbl_x, lbl_y = x1, y1

                                    if class_source:
                                        conf = anno.get("confidence")
                                        lbl_txt = target_name
                                        if conf is not None:
                                            lbl_txt += f" {conf:.2f}"
                                        (tw, th), baseline = cv2.getTextSize(lbl_txt, cv2.FONT_HERSHEY_SIMPLEX, 0.4, 1)
                                        cv2.rectangle(raw_annotated, (lbl_x, lbl_y - th - 5), (lbl_x + tw + 6, lbl_y + baseline), bgr, -1)
                                        cv2.putText(raw_annotated, lbl_txt, (lbl_x + 3, lbl_y - 2), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (255, 255, 255), 1, cv2.LINE_AA)
                                
                                _, raw_buf = cv2.imencode(".jpg", raw_annotated)
                                raw_b64 = base64.b64encode(raw_buf).decode("utf-8")
                                preview_items.append({
                                    "label": f"RAW: {pin_label}",
                                    "image": raw_b64
                                })

                            # --- 2. COMPARE ALL PAIRS ACROSS DIFFERENT SOURCES ---
                            threshold = float(n["properties"].get("iou_threshold", 0.5))
                            tagged_sources = []
                            for src_idx, (pin_label, annos) in enumerate(annotation_inputs):
                                tagged_annos = []
                                for idx, anno in enumerate(annos):
                                    tagged_annos.append({
                                        "src_idx": src_idx,
                                        "pin_label": pin_label,
                                        "anno_idx": idx,
                                        "anno": anno,
                                        "matched_with": []
                                    })
                                tagged_sources.append(tagged_annos)

                            num_sources = len(tagged_sources)
                            for i in range(num_sources):
                                for j in range(i + 1, num_sources):
                                    for detA in tagged_sources[i]:
                                        for detB in tagged_sources[j]:
                                            iou = calculate_iou(detA["anno"], detB["anno"], h, w)
                                            if iou >= threshold:
                                                detA["matched_with"].append((j, detB["anno_idx"], iou))
                                                detB["matched_with"].append((i, detA["anno_idx"], iou))

                            # --- OVERLAP CROP GENERATION ---
                            rendered_pairs = set()

                            def get_detection_bbox_and_segment_crops(anno, color_hex):
                                coords = anno["coords"]
                                is_segment = anno.get("is_segment", len(coords) > 4)
                                if is_segment:
                                    xs = coords[0::2]
                                    ys = coords[1::2]
                                    cx1, cy1 = int(min(xs)*w), int(min(ys)*h)
                                    cx2, cy2 = int(max(xs)*w), int(max(ys)*h)
                                else:
                                    if len(coords) >= 4:
                                        xc, yc, bw, bh = coords[0], coords[1], coords[2], coords[3]
                                        cx1 = int((xc - bw/2)*w)
                                        cy1 = int((yc - bh/2)*h)
                                        cx2 = int((xc + bw/2)*w)
                                        cy2 = int((yc + bh/2)*h)
                                    else:
                                        return None, None
                                
                                cx1 = max(0, min(cx1, w - 1))
                                cx2 = max(0, min(cx2, w - 1))
                                cy1 = max(0, min(cy1, h - 1))
                                cy2 = max(0, min(cy2, h - 1))
                                
                                cw = cx2 - cx1
                                ch = cy2 - cy1
                                if cw <= 0 or ch <= 0:
                                    return None, None
                                
                                bgr = hex_to_bgr(color_hex)
                                left_crop = img[cy1:cy2, cx1:cx2].copy()
                                if is_segment:
                                    pts_px = np.array([[int(coords[i]*w), int(coords[i+1]*h)] for i in range(0, len(coords), 2)], dtype=np.int32)
                                    pts_offset = pts_px - [cx1, cy1]
                                    if len(pts_offset) >= 3:
                                        overlay_crop = left_crop.copy()
                                        cv2.fillPoly(overlay_crop, [pts_offset], bgr)
                                        cv2.addWeighted(overlay_crop, 0.3, left_crop, 0.7, 0, left_crop)
                                        cv2.polylines(left_crop, [pts_offset], True, bgr, 2)
                                else:
                                    overlay_crop = left_crop.copy()
                                    cv2.rectangle(overlay_crop, (0, 0), (cw, ch), bgr, -1)
                                    cv2.addWeighted(overlay_crop, 0.3, left_crop, 0.7, 0, left_crop)
                                    cv2.rectangle(left_crop, (0, 0), (cw, ch), bgr, 2)
                                    
                                mask = np.zeros((h, w), dtype=np.uint8)
                                if is_segment:
                                    pts_px = np.array([[int(coords[i]*w), int(coords[i+1]*h)] for i in range(0, len(coords), 2)], dtype=np.int32)
                                    if len(pts_px) >= 3:
                                        cv2.fillPoly(mask, [pts_px], 255)
                                else:
                                    cv2.rectangle(mask, (cx1, cy1), (cx2, cy2), 255, -1)
                                    
                                masked_img = cv2.bitwise_and(img, img, mask=mask)
                                right_crop = masked_img[cy1:cy2, cx1:cx2].copy()
                                return left_crop, right_crop

                            for i in range(num_sources):
                                for detA in tagged_sources[i]:
                                    for j, anno_idx_B, iou in detA["matched_with"]:
                                        pair_key = (min(i, j), min(detA["anno_idx"], anno_idx_B), max(i, j), max(detA["anno_idx"], anno_idx_B))
                                        if pair_key not in rendered_pairs:
                                            rendered_pairs.add(pair_key)
                                            detB = tagged_sources[j][anno_idx_B]
                                            
                                            c_id_A = detA["anno"]["class_id"]
                                            color_A = "#10b981"
                                            if c_id_A < len(src_classes):
                                                color_A = src_classes[c_id_A]["color"]
                                                
                                            c_id_B = detB["anno"]["class_id"]
                                            color_B = "#3b82f6"
                                            if c_id_B < len(src_classes):
                                                color_B = src_classes[c_id_B]["color"]
                                            
                                            cropA_bbox, cropA_seg = get_detection_bbox_and_segment_crops(detA["anno"], color_A)
                                            cropB_bbox, cropB_seg = get_detection_bbox_and_segment_crops(detB["anno"], color_B)
                                            
                                            if cropA_bbox is not None and cropB_bbox is not None:
                                                hA, wA = cropA_bbox.shape[:2]
                                                hB, wB = cropB_bbox.shape[:2]
                                                max_h = max(hA, hB)
                                                
                                                padA = np.zeros((max_h, wA, 3), dtype=np.uint8)
                                                padA[0:hA, 0:wA] = cropA_bbox
                                                padB = np.zeros((max_h, wB, 3), dtype=np.uint8)
                                                padB[0:hB, 0:wB] = cropB_bbox
                                                
                                                overlap_bbox_row = np.hstack([padA, padB])
                                                cv2.line(overlap_bbox_row, (wA, 0), (wA, max_h), (80, 80, 80), 2)
                                                
                                                _, ob_buf = cv2.imencode(".jpg", overlap_bbox_row)
                                                ob_b64 = base64.b64encode(ob_buf).decode("utf-8")
                                                
                                                padA_seg = np.zeros((max_h, wA, 3), dtype=np.uint8)
                                                padA_seg[0:hA, 0:wA] = cropA_seg
                                                padB_seg = np.zeros((max_h, wB, 3), dtype=np.uint8)
                                                padB_seg[0:hB, 0:wB] = cropB_seg
                                                
                                                overlap_seg_row = np.hstack([padA_seg, padB_seg])
                                                cv2.line(overlap_seg_row, (wA, 0), (wA, max_h), (80, 80, 80), 2)
                                                
                                                _, os_buf = cv2.imencode(".jpg", overlap_seg_row)
                                                os_b64 = base64.b64encode(os_buf).decode("utf-8")
                                                
                                                preview_items.append({
                                                    "label": f"Overlap: {detA['pin_label']} (BBox) | {detB['pin_label']} (BBox) [IoU: {iou*100:.1f}%]",
                                                    "image": ob_b64
                                                })
                                                preview_items.append({
                                                    "label": f"Overlap: {detA['pin_label']} (Segment) | {detB['pin_label']} (Segment) [IoU: {iou*100:.1f}%]",
                                                    "image": os_b64
                                                })

                            # --- 3. NOT OVERLAP SECTION ---
                            for i in range(num_sources):
                                for det in tagged_sources[i]:
                                    if len(det["matched_with"]) == 0:
                                        c_id = det["anno"]["class_id"]
                                        color = "#10b981"
                                        if c_id < len(src_classes):
                                            color = src_classes[c_id]["color"]
                                            
                                        crop_bbox, crop_seg = get_detection_bbox_and_segment_crops(det["anno"], color)
                                        
                                        if crop_bbox is not None and crop_seg is not None:
                                            row_img = np.hstack([crop_bbox, crop_seg])
                                            h_row, w_row = row_img.shape[:2]
                                            cv2.line(row_img, (w_row // 2, 0), (w_row // 2, h_row), (80, 80, 80), 2)
                                            
                                            _, no_buf = cv2.imencode(".jpg", row_img)
                                            no_b64 = base64.b64encode(no_buf).decode("utf-8")
                                            
                                            preview_items.append({
                                                "label": f"Not Overlap: From {det['pin_label']} (BBox | Segment)",
                                                "image": no_b64
                                            })

                            with cache_lock:
                                previews[p_node_id] = preview_items

                            event_queue.put({"type": "end", "node_id": p_node_id})
                            event_queue.put({
                                "type": "preview",
                                "node_id": p_node_id,
                                "preview": previews[p_node_id],
                                "logs": ""
                            })
                        except Exception as ex:
                            event_queue.put({"type": "end", "node_id": p_node_id})
                            event_queue.put({"type": "error", "message": f"Overlap Comparator node error: {str(ex)}"})

                with concurrent.futures.ThreadPoolExecutor(max_workers=len(preview_nodes)) as executor:
                    executor.map(process_preview, preview_nodes)
            else:
                # Spawning evaluations for YOLO or SAM3 directly
                direct_nodes = [n for n in payload.nodes if n["type"] in ("yolo_detector", "sam3")]
                if direct_nodes:
                    def process_direct(n):
                        try:
                            evaluate(n["id"], "image")
                        except Exception as ex:
                            event_queue.put({"type": "error", "message": f"Detector node error: {str(ex)}"})
                    with concurrent.futures.ThreadPoolExecutor(max_workers=len(direct_nodes)) as executor:
                        executor.map(process_direct, direct_nodes)

            # Find the active input node to return filename
            active_filename = "N/A"
            for n in payload.nodes:
                if n["type"] in ("single_image", "folder"):
                    img_src = (n["id"], "image")
                    with cache_lock:
                        if img_src in eval_cache:
                            active_filename = os.path.basename(eval_cache[img_src])
                            break

            event_queue.put({
                "type": "done",
                "filename": active_filename,
                "is_folder_mode": is_folder_mode,
                "current_index": current_index,
                "total_images": total_images
            })
        except Exception as e:
            for n_id in nodes.keys():
                event_queue.put({"type": "end", "node_id": n_id})
            event_queue.put({"type": "error", "message": str(e)})

    # Start target in a background thread
    t = threading.Thread(target=run_all)
    t.start()

    def stream_generator():
        # Keep yielding events until the thread completes and the queue is empty
        while t.is_alive() or not event_queue.empty():
            try:
                ev = event_queue.get(timeout=0.1)
                yield json.dumps(ev) + "\n"
            except queue.Empty:
                continue

    return StreamingResponse(stream_generator(), media_type="application/x-ndjson")

if __name__ == "__main__":
    uvicorn.run("annodes:app", host="127.0.0.1", port=args.port, reload=True)
