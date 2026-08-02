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
    eval_cache = {}
    previews = {}
    logs = {}

    def evaluate(node_id: str, pin_name: str):
        cache_key = (node_id, pin_name)
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

            # Cache all outputs for this input node
            eval_cache[(node_id, "image")] = img_path
            eval_cache[(node_id, "annotation")] = parsed_annotations
            eval_cache[(node_id, "class")] = node_classes

            return eval_cache[cache_key]

        # 2. YOLO Node
        elif node["type"] == "yolo_detector":
            # Get connected image input
            img_source = connections_to.get((node_id, "image"))
            if not img_source:
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
                raise HTTPException(status_code=500, detail=f"YOLO inference error: {str(e)}")
            finally:
                yolo_logger.removeHandler(ch)

            # Process YOLO outputs
            yolo_annotations = []
            detected_objects_summary = []
            
            # Load raw image to draw YOLO preview
            img = cv2.imread(src_image_path)
            if img is None:
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
            previews[node_id] = preview_b64

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
            logs[node_id] = log_html

            # Cache YOLO output pins
            eval_cache[(node_id, "image")] = src_image_path
            eval_cache[(node_id, "annotation")] = yolo_annotations
            eval_cache[(node_id, "class")] = src_classes

            return eval_cache[cache_key]

        # 3. SAM3 Node
        elif node["type"] == "sam3":
            # Get connected image input
            img_source = connections_to.get((node_id, "image"))
            if not img_source:
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
                raise HTTPException(status_code=400, detail=f"SAM3 model '{model_file}' not found in model/ folder")

            # Extract list of prompt texts from keys of prompt_bindings
            prompts = [p.strip() for p in prompt_bindings.keys() if p.strip()]

            if not prompts:
                # If no prompts are defined, return empty
                eval_cache[(node_id, "image")] = src_image_path
                eval_cache[(node_id, "annotation")] = []
                eval_cache[(node_id, "class")] = src_classes
                
                # Copy image for preview (or just load it)
                img = cv2.imread(src_image_path)
                if img is not None:
                    _, buffer = cv2.imencode(".jpg", img)
                    preview_b64 = base64.b64encode(buffer).decode("utf-8")
                    previews[node_id] = preview_b64
                else:
                    previews[node_id] = ""
                
                logs[node_id] = '<div style="color:var(--text-muted);">No prompts configured in prompt bindings. Add a prompt binding first.</div>'
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
                raise HTTPException(status_code=500, detail=f"SAM3 inference error: {str(e)}")
            finally:
                yolo_logger.removeHandler(ch)

            # Process SAM3 outputs
            sam3_annotations = []
            detected_objects_summary = []
            
            # Load raw image to draw SAM3 preview
            img = cv2.imread(src_image_path)
            if img is None:
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
            previews[node_id] = preview_b64

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
            logs[node_id] = log_html

            # Cache SAM3 output pins
            eval_cache[(node_id, "image")] = src_image_path
            eval_cache[(node_id, "annotation")] = sam3_annotations
            eval_cache[(node_id, "class")] = src_classes

            return eval_cache[cache_key]

        raise HTTPException(status_code=400, detail=f"Cannot evaluate output pin {pin_name} on node {node_id}")

    # Process Preview Nodes (leaf nodes)
    preview_nodes_found = False
    for n in payload.nodes:
        if n["type"] == "preview":
            preview_nodes_found = True
            p_node_id = n["id"]
            
            # Resolve inputs
            img_source = connections_to.get((p_node_id, "image"))
            anno_source = connections_to.get((p_node_id, "annotation"))
            class_source = connections_to.get((p_node_id, "class"))

            if not img_source or not anno_source:
                raise HTTPException(status_code=400, detail="Preview node is missing connected 'Image' or 'Annotation' input")

            src_image_path = evaluate(img_source[0], img_source[1])
            src_annotations = evaluate(anno_source[0], anno_source[1])
            
            src_classes = []
            if class_source:
                src_classes = evaluate(class_source[0], class_source[1])

            # Draw outline + 30% fill
            img = cv2.imread(src_image_path)
            if img is None:
                raise HTTPException(status_code=500, detail=f"Failed to load image '{src_image_path}' for Preview rendering")
            
            h, w = img.shape[:2]

            # We will draw all annotations on annotated_img for the top "whole image" view
            annotated_img = img.copy()
            detection_crops_b64 = []

            for anno in src_annotations:
                class_id = anno["class_id"]
                coords = anno["coords"]
                is_segment = anno.get("is_segment", len(coords) > 4)
                conf = anno.get("confidence")

                # Resolve class name & color
                target_name = f"Class {class_id}"
                target_color = "#10b981" # default emerald
                
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
                    # bounding box: [xc, yc, bw, bh]
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

                # Draw Text Label if class_source is connected
                if class_source:
                    lbl_txt = target_name
                    if conf is not None:
                        lbl_txt += f" {conf:.2f}"
                    (tw, th), baseline = cv2.getTextSize(lbl_txt, cv2.FONT_HERSHEY_SIMPLEX, 0.4, 1)
                    cv2.rectangle(annotated_img, (lbl_x, lbl_y - th - 5), (lbl_x + tw + 6, lbl_y + baseline), bgr, -1)
                    cv2.putText(annotated_img, lbl_txt, (lbl_x + 3, lbl_y - 2), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (255, 255, 255), 1, cv2.LINE_AA)

                # Now calculate the crop bounding box for this individual detection
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

                # Crop raw image and draw its own annotation outline/overlay
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

                # Create mask to get ONLY the fill of the segment/box
                mask = np.zeros((h, w), dtype=np.uint8)
                if is_segment:
                    pts_px = np.array([[int(coords[i]*w), int(coords[i+1]*h)] for i in range(0, len(coords), 2)], dtype=np.int32)
                    if len(pts_px) >= 3:
                        cv2.fillPoly(mask, [pts_px], 255)
                else:
                    cv2.rectangle(mask, (cx1, cy1), (cx2, cy2), 255, -1)

                masked_img = cv2.bitwise_and(img, img, mask=mask)
                right_crop = masked_img[cy1:cy2, cx1:cx2].copy()

                # Resize to standard width W_half (320)
                W_half = 320
                h_row = int(crop_h * (W_half / crop_w))
                if h_row <= 0:
                    h_row = 1

                left_resized = cv2.resize(left_crop, (W_half, h_row))
                right_resized = cv2.resize(right_crop, (W_half, h_row))

                # Horizontal concatenation (bbox crop + segment fill crop)
                row_img = np.hstack([left_resized, right_resized])
                # Draw vertical divider line
                cv2.line(row_img, (W_half, 0), (W_half, h_row), (80, 80, 80), 2)

                # Encode this detection pair image to base64
                _, crop_buf = cv2.imencode(".jpg", row_img)
                crop_b64 = base64.b64encode(crop_buf).decode("utf-8")
                detection_crops_b64.append(crop_b64)

            # Build overall detection image
            W = 640
            h_top = int(h * (W / w))
            if h_top <= 0:
                h_top = 1
            top_img = cv2.resize(annotated_img, (W, h_top))

            _, top_buf = cv2.imencode(".jpg", top_img)
            overall_b64 = base64.b64encode(top_buf).decode("utf-8")

            # Store overall image + list of detection pair images
            previews[p_node_id] = [overall_b64] + detection_crops_b64

    # If no Preview nodes found, evaluate the YOLO or SAM3 node directly so we get its outputs
    if not preview_nodes_found:
        for n in payload.nodes:
            if n["type"] in ("yolo_detector", "sam3"):
                evaluate(n["id"], "image")

    # Find the active input node to return filename
    active_filename = "N/A"
    for n in payload.nodes:
        if n["type"] in ("single_image", "folder"):
            img_src = (n["id"], "image")
            if img_src in eval_cache:
                active_filename = os.path.basename(eval_cache[img_src])
                break

    return {
        "success": True,
        "filename": active_filename,
        "previews": previews,
        "logs": logs,
        "is_folder_mode": is_folder_mode,
        "current_index": current_index,
        "total_images": total_images
    }

if __name__ == "__main__":
    uvicorn.run("annodes:app", host="127.0.0.1", port=args.port, reload=True)
