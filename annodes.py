import os
import sys
import shutil
import json
import sqlite3
import base64
import argparse
import uvicorn
from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.responses import HTMLResponse, FileResponse, StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Optional, Dict, Any
import cv2
import numpy as np
import threading
import queue
import concurrent.futures
import requests

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

class CreateTabRequest(BaseModel):
    name: str

class SelectTabRequest(BaseModel):
    id: int

class RenameTabRequest(BaseModel):
    id: int
    name: str

class DeleteTabRequest(BaseModel):
    id: int

class RunFlowRequest(BaseModel):
    nodes: List[Dict[str, Any]]
    connections: List[Dict[str, Any]]
    run_only_nodes: Optional[List[str]] = None

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
        CREATE TABLE IF NOT EXISTS canvas_tabs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            nodes TEXT NOT NULL,
            connections TEXT NOT NULL,
            is_active INTEGER DEFAULT 0
        );
    """)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS flow_state (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            current_index INTEGER DEFAULT 0
        );
    """)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS ai_decision_config (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
    """)
    # Seed AI configs
    cursor.execute("SELECT COUNT(*) FROM ai_decision_config WHERE key = 'endpoints'")
    if cursor.fetchone()[0] == 0:
        cursor.execute("INSERT INTO ai_decision_config (key, value) VALUES ('endpoints', '[]')")
        
    cursor.execute("SELECT COUNT(*) FROM ai_decision_config WHERE key = 'models'")
    if cursor.fetchone()[0] == 0:
        cursor.execute("INSERT INTO ai_decision_config (key, value) VALUES ('models', '[\"gpt-4o\", \"gpt-4-turbo\", \"claude-3-5-sonnet\", \"llama3\"]')")

    # Seed flow state
    cursor.execute("SELECT COUNT(*) FROM flow_state")
    if cursor.fetchone()[0] == 0:
        cursor.execute("INSERT INTO flow_state (current_index) VALUES (0)")
        
    # Migrate to canvas_tabs if empty
    cursor.execute("SELECT COUNT(*) FROM canvas_tabs")
    if cursor.fetchone()[0] == 0:
        try:
            cursor.execute("SELECT nodes, connections FROM canvas LIMIT 1")
            old_row = cursor.fetchone()
            if old_row:
                cursor.execute("INSERT INTO canvas_tabs (name, nodes, connections, is_active) VALUES (?, ?, ?, 1)", ("Flow 1", old_row[0], old_row[1]))
            else:
                cursor.execute("INSERT INTO canvas_tabs (name, nodes, connections, is_active) VALUES (?, ?, ?, 1)", ("Flow 1", "[]", "[]"))
        except Exception:
            cursor.execute("INSERT INTO canvas_tabs (name, nodes, connections, is_active) VALUES (?, ?, ?, 1)", ("Flow 1", "[]", "[]"))
            
    conn.commit()
    conn.close()

init_db()

# --- Serve Frontend Files ---
@app.get("/")
def read_root():
    try:
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        cursor.execute("SELECT id FROM canvas_tabs ORDER BY id ASC LIMIT 1")
        row = cursor.fetchone()
        if row:
            first_id = row[0]
            cursor.execute("UPDATE canvas_tabs SET is_active = 0")
            cursor.execute("UPDATE canvas_tabs SET is_active = 1 WHERE id = ?", (first_id,))
            conn.commit()
        conn.close()
    except Exception as e:
        pass
    return FileResponse(os.path.join(BASE_DIR, "annodes.html"))

@app.get("/nodes/{file_path:path}")
def serve_node_modules(file_path: str):
    """Serve JS files from the nodes/ subdirectory."""
    safe_path = os.path.normpath(file_path).lstrip(os.sep)
    full_path = os.path.join(BASE_DIR, "nodes", safe_path)
    if os.path.exists(full_path) and os.path.isfile(full_path):
        return FileResponse(full_path)
    raise HTTPException(status_code=404, detail=f"Node module not found: {file_path}")

@app.get("/{flow_id}")
def read_flow_tab(flow_id: str):
    if flow_id.isdigit():
        try:
            conn = sqlite3.connect(DB_PATH)
            cursor = conn.cursor()
            cursor.execute("SELECT id FROM canvas_tabs WHERE id = ?", (int(flow_id),))
            if cursor.fetchone():
                cursor.execute("UPDATE canvas_tabs SET is_active = 0")
                cursor.execute("UPDATE canvas_tabs SET is_active = 1 WHERE id = ?", (int(flow_id),))
                conn.commit()
            conn.close()
        except Exception as e:
            pass
        return FileResponse(os.path.join(BASE_DIR, "annodes.html"))

    # Serve static files from BASE_DIR if they exist
    file_path = os.path.join(BASE_DIR, flow_id)
    if os.path.exists(file_path) and os.path.isfile(file_path):
        return FileResponse(file_path)

    raise HTTPException(status_code=404, detail="Not Found")

@app.get("/api/models")
def get_models():
    if not os.path.exists(MODEL_DIR):
        return {"success": True, "models": []}
    models = [f for f in os.listdir(MODEL_DIR) if f.endswith(".pt")]
    return {"success": True, "models": sorted(models)}

@app.get("/api/gpus")
def get_gpus():
    gpus = []
    try:
        import torch
        if torch.cuda.is_available():
            num_gpus = torch.cuda.device_count()
            for i in range(num_gpus):
                name = torch.cuda.get_device_name(i)
                mem_total = torch.cuda.get_device_properties(i).total_memory // (1024 * 1024)
                gpus.append({"id": f"cuda:{i}", "name": f"GPU {i}: {name} ({mem_total} MB)"})
        gpus.append({"id": "cpu", "name": "CPU"})
        return {"success": True, "gpus": gpus}
    except Exception as e:
        return {"success": False, "gpus": [{"id": "cpu", "name": "CPU"}], "error": str(e)}

@app.get("/api/yolo-model-names")
def get_yolo_model_names(model: str):
    model_path = os.path.join(MODEL_DIR, model)
    if not os.path.exists(model_path):
        return {"success": False, "error": f"Model '{model}' not found"}
    try:
        yolo = _get_yolo_model(model, model_path, device="cpu")
        names = [yolo.names[i] for i in sorted(yolo.names.keys())]
        return {"success": True, "names": names}
    except Exception as e:
        return {"success": False, "error": str(e)}

@app.post("/api/save-canvas")
def save_canvas(payload: CanvasSaveRequest):
    try:
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        # Find active tab
        cursor.execute("SELECT id FROM canvas_tabs WHERE is_active = 1 LIMIT 1")
        row = cursor.fetchone()
        if row:
            active_id = row[0]
            cursor.execute("UPDATE canvas_tabs SET nodes = ?, connections = ? WHERE id = ?", (payload.nodes, payload.connections, active_id))
        else:
            cursor.execute("INSERT INTO canvas_tabs (name, nodes, connections, is_active) VALUES (?, ?, ?, 1)", ("Flow 1", payload.nodes, payload.connections))
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
        cursor.execute("SELECT id, name, nodes, connections FROM canvas_tabs WHERE is_active = 1 LIMIT 1")
        row = cursor.fetchone()
        if not row:
            cursor.execute("SELECT id, name, nodes, connections FROM canvas_tabs LIMIT 1")
            row = cursor.fetchone()
            if row:
                cursor.execute("UPDATE canvas_tabs SET is_active = 1 WHERE id = ?", (row[0],))
                conn.commit()
            else:
                cursor.execute("INSERT INTO canvas_tabs (name, nodes, connections, is_active) VALUES (?, '[]', '[]', 1)", ("Flow 1",))
                conn.commit()
                cursor.execute("SELECT id, name, nodes, connections FROM canvas_tabs WHERE is_active = 1 LIMIT 1")
                row = cursor.fetchone()
        
        conn.close()
        return {
            "success": True,
            "tab_id": row[0],
            "tab_name": row[1],
            "nodes": json.loads(row[2]) if row[2] else [],
            "connections": json.loads(row[3]) if row[3] else []
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/node-image/{node_id}")
def get_node_image(node_id: str):
    try:
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        cursor.execute("SELECT nodes, connections FROM canvas_tabs WHERE is_active = 1 LIMIT 1")
        row = cursor.fetchone()
        conn.close()

        if not row:
            raise HTTPException(status_code=400, detail="No active flow found")

        canvas_nodes_list = json.loads(row[0])
        canvas_connections_list = json.loads(row[1])

        nodes = {n["id"]: n for n in canvas_nodes_list}
        connections_to = {}
        for conn_item in canvas_connections_list:
            to_node = conn_item.get("toNodeId")
            to_pin = conn_item.get("toPinName")
            from_node = conn_item.get("fromNodeId")
            from_pin = conn_item.get("fromPinName")
            if to_node and to_pin:
                connections_to[(to_node, to_pin)] = (from_node, from_pin)

        # Replicate index resolution for folder node
        is_folder_mode = False
        current_image_filename = ""
        
        folder_node = None
        for n in canvas_nodes_list:
            if n["type"] == "folder":
                folder_node = n
                break

        if folder_node:
            images_dir = folder_node["properties"].get("images_dir", "").strip()
            if images_dir and os.path.exists(images_dir):
                img_extensions = ('.jpg', '.jpeg', '.png')
                images = sorted([f for f in os.listdir(images_dir) if f.lower().endswith(img_extensions)])
                if images:
                    conn = sqlite3.connect(DB_PATH)
                    cursor = conn.cursor()
                    cursor.execute("SELECT current_index FROM flow_state LIMIT 1")
                    db_row = cursor.fetchone()
                    conn.close()
                    
                    current_index = db_row[0] if db_row else 0
                    active_idx = (current_index - 1) % len(images)
                    current_image_filename = images[active_idx]

        # Nested evaluate function just for path resolution
        def evaluate_path(n_id: str, pin_name: str) -> str:
            n = nodes.get(n_id)
            if not n:
                raise Exception(f"Node {n_id} not found")
            if n["type"] in ("single_image", "folder"):
                if n["type"] == "folder":
                    img_dir = n["properties"].get("images_dir", "").strip()
                    return os.path.join(img_dir, current_image_filename)
                else:
                    return n["properties"].get("image_path", "").strip()
            
            src = connections_to.get((n_id, "image"))
            if not src:
                raise Exception(f"Node {n_id} has no image input connected")
            return evaluate_path(src[0], src[1])

        # Get connected image input for target node
        img_src = connections_to.get((node_id, "image"))
        if not img_src:
            raise HTTPException(status_code=400, detail="No Image input connected to this node")

        src_image_path = evaluate_path(img_src[0], img_src[1])
        if not src_image_path or not os.path.exists(src_image_path):
            raise HTTPException(status_code=400, detail=f"Image file '{src_image_path}' not found")

        img = cv2.imread(src_image_path)
        if img is None:
            raise HTTPException(status_code=500, detail="Failed to load image file")

        _, buffer = cv2.imencode(".jpg", img)
        img_b64 = base64.b64encode(buffer).decode("utf-8")

        return {"success": True, "image": img_b64}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/upload-image")
async def upload_image(file: UploadFile = File(...)):
    try:
        upload_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "uploads")
        os.makedirs(upload_dir, exist_ok=True)
        
        file_path = os.path.join(upload_dir, file.filename)
        with open(file_path, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)
            
        return {"success": True, "path": f"uploads/{file.filename}"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

class AIConfigSaveRequest(BaseModel):
    endpoints: List[Dict[str, Any]]
    models: List[str]

@app.get("/api/ai-decision/config")
def get_ai_decision_config():
    try:
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        cursor.execute("SELECT value FROM ai_decision_config WHERE key = 'endpoints'")
        endpoints_row = cursor.fetchone()
        cursor.execute("SELECT value FROM ai_decision_config WHERE key = 'models'")
        models_row = cursor.fetchone()
        conn.close()
        
        endpoints = json.loads(endpoints_row[0]) if endpoints_row else []
        models = json.loads(models_row[0]) if models_row else ["gpt-4o", "gpt-4-turbo", "claude-3-5-sonnet", "llama3"]
        return {"endpoints": endpoints, "models": models}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/ai-decision/config")
def save_ai_decision_config(payload: AIConfigSaveRequest):
    try:
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        cursor.execute("INSERT OR REPLACE INTO ai_decision_config (key, value) VALUES ('endpoints', ?)", (json.dumps(payload.endpoints),))
        cursor.execute("INSERT OR REPLACE INTO ai_decision_config (key, value) VALUES ('models', ?)", (json.dumps(payload.models),))
        conn.commit()
        conn.close()
        return {"success": True}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# Pause state mapping: node_id -> bool
_paused_queues = {}

class PauseToggleRequest(BaseModel):
    node_id: str
    paused: bool

@app.post("/api/ai-queue/pause-toggle")
def pause_toggle(payload: PauseToggleRequest):
    _paused_queues[payload.node_id] = payload.paused
    return {"success": True, "paused": payload.paused}

def call_vlm_api(endpoints, model_name, messages):
    is_gemini = "gemini" in model_name.lower()
    
    url = ""
    api_key = ""
    for ep in endpoints:
        if is_gemini and "googleapis" in ep.get("url", ""):
            url = ep.get("url")
            api_key = ep.get("api_key")
            break
            
    if not api_key:
        if is_gemini:
            api_key = os.environ.get("GEMINI_API_KEY", "")
        else:
            api_key = os.environ.get("OPENAI_API_KEY", "")
            
    if not url:
        if is_gemini:
            url = f"https://generativelanguage.googleapis.com/v1beta/models/{model_name}:generateContent"
        elif endpoints:
            url = endpoints[0].get("url", "").rstrip("/") + "/chat/completions"
        else:
            url = "https://api.openai.com/v1/chat/completions"

    if is_gemini and "key=" not in url and api_key:
        url = url + f"?key={api_key}"

    headers = {"Content-Type": "application/json"}
    if api_key and not is_gemini:
        headers["Authorization"] = f"Bearer {api_key}"

    if is_gemini:
        contents = []
        for msg in messages:
            role = "user" if msg["role"] in ("user", "error") else "model"
            parts = []
            if msg.get("content"):
                parts.append({"text": msg["content"]})
            if msg["role"] == "user" and msg.get("images"):
                for img_b64 in msg["images"]:
                    parts.append({
                        "inlineData": {
                            "mimeType": "image/jpeg",
                            "data": img_b64
                        }
                    })
            contents.append({"role": role, "parts": parts})
            
        payload = {"contents": contents}
        
        has_json = False
        for msg in messages:
            if msg.get("content") and "json" in msg["content"].lower():
                has_json = True
                break
                
        if has_json:
            payload["generationConfig"] = {
                "responseMimeType": "application/json"
            }
        
        res = requests.post(url, headers=headers, json=payload, timeout=45)
        res.raise_for_status()
        data = res.json()
        text = data["candidates"][0]["content"]["parts"][0]["text"]
        return text
    else:
        openai_messages = []
        for msg in messages:
            role = "user" if msg["role"] in ("user", "error") else "assistant"
            content_list = []
            if msg.get("content"):
                content_list.append({"type": "text", "text": msg["content"]})
            if msg["role"] == "user" and msg.get("images"):
                for img_b64 in msg["images"]:
                    content_list.append({
                        "type": "image_url",
                        "image_url": {"url": f"data:image/jpeg;base64,{img_b64}"}
                    })
            openai_messages.append({"role": role, "content": content_list if len(content_list) > 1 else msg.get("content", "")})
            
        payload = {
            "model": model_name,
            "messages": openai_messages
        }
        has_json = False
        for msg in messages:
            if msg.get("content") and "json" in msg["content"].lower():
                has_json = True
                break
        if has_json:
            payload["response_format"] = {"type": "json_object"}
            
        res = requests.post(url, headers=headers, json=payload, timeout=45)
        res.raise_for_status()
        data = res.json()
        text = data["choices"][0]["message"]["content"]
        return text

class AICheckEndpointRequest(BaseModel):
    url: str
    api_key: Optional[str] = None

@app.post("/api/ai-decision/check-endpoint")
def check_endpoint(payload: AICheckEndpointRequest):
    url = payload.url.strip()
    api_key = payload.api_key.strip() if payload.api_key else ""
    
    if not url:
        raise HTTPException(status_code=400, detail="Endpoint URL is required")
        
    headers = {}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
        
    try:
        test_url = url
        if not test_url.endswith("/models") and not test_url.endswith("/v1/models") and not test_url.endswith("/api/tags"):
            if "ollama" in test_url or "11434" in test_url:
                test_url = test_url.rstrip("/") + "/api/tags"
            else:
                test_url = test_url.rstrip("/") + "/v1/models"
                
        response = requests.get(test_url, headers=headers, timeout=10)
        if response.status_code != 200:
            raise HTTPException(status_code=response.status_code, detail=f"Endpoint returned status code {response.status_code}: {response.text}")
            
        data = response.json()
        models = []
        if "data" in data and isinstance(data["data"], list):
            for item in data["data"]:
                if isinstance(item, dict):
                    m_id = item.get("id") or item.get("name")
                    if m_id:
                        models.append(str(m_id).replace("models/", ""))
        elif "models" in data and isinstance(data["models"], list):
            for item in data["models"]:
                if isinstance(item, dict):
                    m_id = item.get("name") or item.get("id")
                    if m_id:
                        models.append(str(m_id).replace("models/", ""))
        else:
            if isinstance(data, list):
                for item in data:
                    if isinstance(item, str):
                        models.append(item.replace("models/", ""))
                    elif isinstance(item, dict):
                        m_id = item.get("id") or item.get("name")
                        if m_id:
                            models.append(str(m_id).replace("models/", ""))
                        
        models = [m for m in models if m]
        return {"success": True, "models": sorted(list(set(models)))}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to connect to endpoint: {str(e)}")

@app.post("/api/select-folder")
def select_folder():
    try:
        import tkinter as tk
        from tkinter import filedialog
        root = tk.Tk()
        root.withdraw()
        root.attributes('-topmost', True)
        folder_selected = filedialog.askdirectory(title="Select Save Annotation Directory")
        root.destroy()
        if folder_selected:
            folder_selected = os.path.normpath(folder_selected)
            return {"success": True, "path": folder_selected}
        return {"success": False, "message": "Selection cancelled"}
    except Exception as e:
        return {"success": False, "error": str(e)}

@app.get("/api/tabs")
def get_tabs():
    try:
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        cursor.execute("SELECT id, name, is_active FROM canvas_tabs ORDER BY id ASC")
        rows = cursor.fetchall()
        conn.close()
        return [{"id": r[0], "name": r[1], "is_active": bool(r[2])} for r in rows]
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/tabs/create")
def create_tab(payload: CreateTabRequest):
    try:
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        cursor.execute("UPDATE canvas_tabs SET is_active = 0")
        cursor.execute("INSERT INTO canvas_tabs (name, nodes, connections, is_active) VALUES (?, '[]', '[]', 1)", (payload.name,))
        new_id = cursor.lastrowid
        conn.commit()
        conn.close()
        return {"success": True, "id": new_id}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/tabs/select")
def select_tab(payload: SelectTabRequest):
    try:
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        cursor.execute("UPDATE canvas_tabs SET is_active = 0")
        cursor.execute("UPDATE canvas_tabs SET is_active = 1 WHERE id = ?", (payload.id,))
        cursor.execute("SELECT id, name, nodes, connections FROM canvas_tabs WHERE id = ?", (payload.id,))
        row = cursor.fetchone()
        conn.commit()
        conn.close()
        if row:
            return {
                "success": True,
                "tab_id": row[0],
                "tab_name": row[1],
                "nodes": json.loads(row[2]) if row[2] else [],
                "connections": json.loads(row[3]) if row[3] else []
            }
        raise HTTPException(status_code=404, detail="Tab not found")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/tabs/rename")
def rename_tab(payload: RenameTabRequest):
    try:
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        cursor.execute("UPDATE canvas_tabs SET name = ? WHERE id = ?", (payload.name, payload.id))
        conn.commit()
        conn.close()
        return {"success": True}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/tabs/delete")
def delete_tab(payload: DeleteTabRequest):
    try:
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        cursor.execute("SELECT is_active FROM canvas_tabs WHERE id = ?", (payload.id,))
        row = cursor.fetchone()
        is_active_del = row[0] if row else 0
        
        cursor.execute("DELETE FROM canvas_tabs WHERE id = ?", (payload.id,))
        
        if is_active_del:
            cursor.execute("SELECT id FROM canvas_tabs ORDER BY id ASC LIMIT 1")
            other = cursor.fetchone()
            if other:
                cursor.execute("UPDATE canvas_tabs SET is_active = 1 WHERE id = ?", (other[0],))
            else:
                cursor.execute("INSERT INTO canvas_tabs (name, nodes, connections, is_active) VALUES (?, '[]', '[]', 1)", ("Flow 1",))
        
        conn.commit()
        conn.close()
        return {"success": True}
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

def process_overlap_comparator_node(node, connections_to, evaluate):
    node_id = node["id"]
    img_source = connections_to.get((node_id, "image"))
    class_source = connections_to.get((node_id, "class"))

    if not img_source:
        raise HTTPException(status_code=400, detail="Overlap Comparator node is missing connected 'Image' input")

    src_image_path = evaluate(img_source[0], img_source[1])
    
    src_classes = []
    if class_source:
        src_classes = evaluate(class_source[0], class_source[1])

    input_pins = node["properties"].get("input_pins", ["image", "class", "annotation1", "annotation2"])
    comparator_rules = node["properties"].get("comparator_rules", [])

    def get_rule_action(pin_a, pin_b):
        for r in comparator_rules:
            s, t, act = r.get("src"), r.get("target"), r.get("action")
            if (s == pin_a and t == pin_b) or (s == pin_b and t == pin_a):
                if act in ("choose_src", "choose_annotation1"):
                    return "choose_pin_a" if s == pin_a else "choose_pin_b"
                elif act in ("choose_target", "choose_annotation2"):
                    return "choose_pin_b" if s == pin_a else "choose_pin_a"
                elif act == "compare":
                    return "compare"
        return "compare" # Default action if unconfigured

    annotation_inputs = []
    for pin_name in input_pins:
        if pin_name.startswith("annotation"):
            anno_src = connections_to.get((node_id, pin_name))
            pin_idx_str = pin_name.replace("annotation", "")
            pin_label = f"Annotation {pin_idx_str}"
            if anno_src:
                annos = evaluate(anno_src[0], anno_src[1])
                annotation_inputs.append((pin_name, pin_label, annos))

    img = cv2.imread(src_image_path)
    if img is None:
        raise HTTPException(status_code=500, detail=f"Failed to load image '{src_image_path}' for Overlap Comparator")
    
    h, w = img.shape[:2]
    preview_items = []

    # 1. RAW preview items
    for pin_name, pin_label, annos in annotation_inputs:
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
            "image": raw_b64,
            "category": "raw"
        })

    # 2. COMPARE PAIRS AND RESOLVE ACTIONS
    threshold = float(node["properties"].get("iou_threshold", 0.5))

    def get_detection_crops(anno, color_hex):
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

    all_detections = []
    for src_idx, (pin_name, pin_label, annos) in enumerate(annotation_inputs):
        for anno in annos:
            all_detections.append({
                "pin_name": pin_name,
                "pin_label": pin_label,
                "src_idx": src_idx,
                "anno": anno,
                "global_idx": len(all_detections)
            })

    num_dets = len(all_detections)
    adj = [[] for _ in range(num_dets)]
    for i in range(num_dets):
        for j in range(i + 1, num_dets):
            iou = calculate_iou(all_detections[i]["anno"], all_detections[j]["anno"], h, w)
            if iou >= threshold:
                adj[i].append((j, iou))
                adj[j].append((i, iou))

    visited = set()
    clusters = []
    for i in range(num_dets):
        if i not in visited:
            comp = []
            q = [i]
            visited.add(i)
            while q:
                curr = q.pop(0)
                comp.append(all_detections[curr])
                for neighbor, _ in adj[curr]:
                    if neighbor not in visited:
                        visited.add(neighbor)
                        q.append(neighbor)
            clusters.append(comp)

    resolved_annotations = []
    conflict_pairs = []

    # Process each component cluster
    for comp in clusters:
        sources_in_comp = set(det["src_idx"] for det in comp)
        if len(comp) > 1 and len(sources_in_comp) > 1:
            # Multi-source overlap
            comp.sort(key=lambda d: (d["src_idx"], d["anno"]["class_id"]))
            
            # Compare pairs in component
            for i_idx in range(len(comp)):
                for j_idx in range(i_idx + 1, len(comp)):
                    det_A = comp[i_idx]
                    det_B = comp[j_idx]
                    iou_val = calculate_iou(det_A["anno"], det_B["anno"], h, w)
                    if iou_val < threshold:
                        continue

                    c_id_A = det_A["anno"]["class_id"]
                    c_name_A = src_classes[c_id_A]["name"] if c_id_A < len(src_classes) else f"Class {c_id_A}"
                    color_A = src_classes[c_id_A]["color"] if c_id_A < len(src_classes) else "#10b981"

                    c_id_B = det_B["anno"]["class_id"]
                    c_name_B = src_classes[c_id_B]["name"] if c_id_B < len(src_classes) else f"Class {c_id_B}"
                    color_B = src_classes[c_id_B]["color"] if c_id_B < len(src_classes) else "#3b82f6"

                    action = get_rule_action(det_A["pin_name"], det_B["pin_name"])

                    if action == "choose_pin_a":
                        if det_A["anno"] not in resolved_annotations:
                            resolved_annotations.append(det_A["anno"])
                    elif action == "choose_pin_b":
                        if det_B["anno"] not in resolved_annotations:
                            resolved_annotations.append(det_B["anno"])
                    else: # action == "compare" (default)
                        conflict_pairs.append({
                            "pair_id": f"conflict-{len(conflict_pairs)+1}",
                            "iou": round(float(iou_val), 4),
                            "action": "compare",
                            "detection_a": {
                                "source_pin": det_A["pin_name"],
                                "source_label": det_A["pin_label"],
                                "class_id": c_id_A,
                                "class_name": c_name_A,
                                "confidence": det_A["anno"].get("confidence"),
                                "coords": det_A["anno"]["coords"],
                                "is_segment": det_A["anno"].get("is_segment", len(det_A["anno"]["coords"]) > 4)
                            },
                            "detection_b": {
                                "source_pin": det_B["pin_name"],
                                "source_label": det_B["pin_label"],
                                "class_id": c_id_B,
                                "class_name": c_name_B,
                                "confidence": det_B["anno"].get("confidence"),
                                "coords": det_B["anno"]["coords"],
                                "is_segment": det_B["anno"].get("is_segment", len(det_B["anno"]["coords"]) > 4)
                            }
                        })

            # Calculate unified bounding box across ALL detections in component
            all_boxes = []
            for det in comp:
                anno = det["anno"]
                coords = anno["coords"]
                is_seg = anno.get("is_segment", len(coords) > 4)
                if is_seg:
                    xs = coords[0::2]
                    ys = coords[1::2]
                    if len(xs) > 0 and len(ys) > 0:
                        all_boxes.append((min(xs)*w, min(ys)*h, max(xs)*w, max(ys)*h))
                else:
                    if len(coords) >= 4:
                        xc, yc, bw, bh = coords[0], coords[1], coords[2], coords[3]
                        all_boxes.append(((xc - bw/2)*w, (yc - bh/2)*h, (xc + bw/2)*w, (yc + bh/2)*h))

            if all_boxes:
                min_x = min(b[0] for b in all_boxes)
                min_y = min(b[1] for b in all_boxes)
                max_x = max(b[2] for b in all_boxes)
                max_y = max(b[3] for b in all_boxes)

                pad_w = (max_x - min_x) * 0.15 + 10
                pad_h = (max_y - min_y) * 0.15 + 10

                cx1 = int(max(0, min_x - pad_w))
                cy1 = int(max(0, min_y - pad_h))
                cx2 = int(min(w, max_x + pad_w))
                cy2 = int(min(h, max_y + pad_h))

                cw = cx2 - cx1
                ch = cy2 - cy1

                if cw > 0 and ch > 0:
                    item_crops = []
                    det_labels = []

                    target_h = 160
                    aspect = cw / float(ch)
                    target_w = max(100, int(target_h * aspect))

                    for idx, det in enumerate(comp):
                        c_id = det["anno"]["class_id"]
                        color_hex = src_classes[c_id]["color"] if c_id < len(src_classes) else "#3b82f6"
                        c_name = src_classes[c_id]["name"] if c_id < len(src_classes) else f"Class {c_id}"
                        bgr = hex_to_bgr(color_hex)
                        coords = det["anno"]["coords"]
                        is_segment = det["anno"].get("is_segment", len(coords) > 4)

                        det_labels.append(f"{det['pin_label']}: {c_name}")

                        # A. Generate BBox Outline Crop (Individual Image)
                        crop_bbox = img[cy1:cy2, cx1:cx2].copy()
                        if is_segment:
                            pts_px = np.array([[int(coords[i]*w), int(coords[i+1]*h)] for i in range(0, len(coords), 2)], dtype=np.int32)
                            pts_offset = pts_px - [cx1, cy1]
                            if len(pts_offset) >= 3:
                                overlay = crop_bbox.copy()
                                cv2.fillPoly(overlay, [pts_offset], bgr)
                                cv2.addWeighted(overlay, 0.25, crop_bbox, 0.75, 0, crop_bbox)
                                cv2.polylines(crop_bbox, [pts_offset], True, bgr, 2)
                        else:
                            overlay = crop_bbox.copy()
                            cv2.rectangle(overlay, (0, 0), (cw, ch), bgr, -1)
                            cv2.addWeighted(overlay, 0.25, crop_bbox, 0.75, 0, crop_bbox)
                            cv2.rectangle(crop_bbox, (0, 0), (cw, ch), bgr, 2)

                        # B. Generate Segment Mask Crop (Individual Image)
                        mask = np.zeros((h, w), dtype=np.uint8)
                        if is_segment:
                            pts_px = np.array([[int(coords[i]*w), int(coords[i+1]*h)] for i in range(0, len(coords), 2)], dtype=np.int32)
                            if len(pts_px) >= 3:
                                cv2.fillPoly(mask, [pts_px], 255)
                        else:
                            rx1 = int((coords[0] - coords[2]/2)*w)
                            ry1 = int((coords[1] - coords[3]/2)*h)
                            rx2 = int((coords[0] + coords[2]/2)*w)
                            ry2 = int((coords[1] + coords[3]/2)*h)
                            cv2.rectangle(mask, (rx1, ry1), (rx2, ry2), 255, -1)

                        masked_img = cv2.bitwise_and(img, img, mask=mask)
                        crop_seg = masked_img[cy1:cy2, cx1:cx2].copy()

                        crop_bbox_resized = cv2.resize(crop_bbox, (target_w, target_h), interpolation=cv2.INTER_AREA)
                        crop_seg_resized = cv2.resize(crop_seg, (target_w, target_h), interpolation=cv2.INTER_AREA)

                        _, buf_bbox = cv2.imencode(".jpg", crop_bbox_resized)
                        b64_bbox = base64.b64encode(buf_bbox).decode("utf-8")

                        _, buf_seg = cv2.imencode(".jpg", crop_seg_resized)
                        b64_seg = base64.b64encode(buf_seg).decode("utf-8")

                        item_crops.append({
                            "index": idx + 1,
                            "pin_name": det["pin_name"],
                            "pin_label": det["pin_label"],
                            "class_id": c_id,
                            "class_name": c_name,
                            "image": b64_seg,
                            "bbox_crop": b64_bbox,
                            "seg_crop": b64_seg,
                            "coords": coords,
                            "is_segment": is_segment
                        })

                    # Add structured conflict item list for AI decision node & preview
                    conflict_pairs.append({
                        "pair_id": f"conflict-{len(conflict_pairs)+1}",
                        "action": "compare",
                        "items": item_crops
                    })

                    preview_items.append({
                        "label": f"Overlap Comparison ({' vs '.join(det_labels)})",
                        "category": "overlap",
                        "items": item_crops
                    })
        else:
            # Non-overlapping detections automatically added to output
            for det in comp:
                if det["anno"] not in resolved_annotations:
                    resolved_annotations.append(det["anno"])
                
                c_id = det["anno"]["class_id"]
                color = "#10b981"
                class_name = f"Class {c_id}"
                if c_id < len(src_classes):
                    color = src_classes[c_id]["color"]
                    class_name = src_classes[c_id]["name"]
                    
                crop_bbox, crop_seg = get_detection_crops(det["anno"], color)
                if crop_bbox is not None and crop_seg is not None:
                    row_img = np.hstack([crop_bbox, crop_seg])
                    h_row, w_row = row_img.shape[:2]
                    cv2.line(row_img, (w_row // 2, 0), (w_row // 2, h_row), (80, 80, 80), 2)
                    
                    _, no_buf = cv2.imencode(".jpg", row_img)
                    no_b64 = base64.b64encode(no_buf).decode("utf-8")
                    
                    preview_items.append({
                        "label": f"Not Overlap: From {det['pin_label']} ({class_name}) (BBox | Segment)",
                        "image": no_b64,
                        "category": "not_overlap"
                    })

    processed_data = {
        "image_path": src_image_path,
        "resolved_annotations": resolved_annotations,
        "conflict_pairs": conflict_pairs
    }

    return processed_data, preview_items

def parse_ai_choice(vlm_output: str, num_candidates: int) -> Optional[int]:
    cleaned = vlm_output.strip()
    try:
        start = cleaned.find('{')
        end = cleaned.rfind('}')
        if start != -1 and end != -1:
            json_str = cleaned[start:end+1]
            data = json.loads(json_str)
            for key in ("choice", "selected", "choice_index", "selected_index", "index", "image_index"):
                val = data.get(key)
                if val is not None:
                    try:
                        idx = int(val)
                        if 1 <= idx <= num_candidates:
                            return idx
                    except ValueError:
                        pass
    except Exception:
        pass
        
    import re
    patterns = [
        r"(?:choice|selected|index|image)\s*[:=]\s*(\d+)",
        r"pilih(?: gambar)?\s*(\d+)",
        r"image\s*(\d+)"
    ]
    for pattern in patterns:
        match = re.search(pattern, cleaned, re.IGNORECASE)
        if match:
            idx = int(match.group(1))
            if 1 <= idx <= num_candidates:
                return idx
                
    if cleaned.isdigit():
        idx = int(cleaned)
        if 1 <= idx <= num_candidates:
            return idx
            
    return None

def draw_resolved_annotations(img, annotations, src_classes):
    h, w = img.shape[:2]
    out_img = img.copy()
    for anno in annotations:
        c_id = anno["class_id"]
        color_hex = src_classes[c_id]["color"] if c_id < len(src_classes) else "#3b82f6"
        c_name = src_classes[c_id]["name"] if c_id < len(src_classes) else f"Class {c_id}"
        bgr = hex_to_bgr(color_hex)
        coords = anno["coords"]
        is_segment = anno.get("is_segment", len(coords) > 4)
        
        lbl_x, lbl_y = 10, 10
        if is_segment:
            pts_px = np.array([[int(coords[j]*w), int(coords[j+1]*h)] for j in range(0, len(coords), 2)], dtype=np.int32)
            if len(pts_px) >= 3:
                overlay = out_img.copy()
                cv2.fillPoly(overlay, [pts_px], bgr)
                cv2.addWeighted(overlay, 0.3, out_img, 0.7, 0, out_img)
                cv2.polylines(out_img, [pts_px], True, bgr, 2)
                min_y_idx = np.argmin(pts_px[:, 1])
                lbl_x = int(pts_px[min_y_idx][0])
                lbl_y = int(pts_px[min_y_idx][1])
        else:
            if len(coords) >= 4:
                xc, yc, bw, bh = coords[0], coords[1], coords[2], coords[3]
                x1 = int((xc - bw/2)*w)
                y1 = int((yc - bh/2)*h)
                x2 = int((xc + bw/2)*w)
                y2 = int((yc + bh/2)*h)
                overlay = out_img.copy()
                cv2.rectangle(overlay, (x1, y1), (x2, y2), bgr, -1)
                cv2.addWeighted(overlay, 0.3, out_img, 0.7, 0, out_img)
                cv2.rectangle(out_img, (x1, y1), (x2, y2), bgr, 2)
                lbl_x, lbl_y = x1, y1
                
        lbl_txt = f"{c_name}"
        (tw, th), baseline = cv2.getTextSize(lbl_txt, cv2.FONT_HERSHEY_SIMPLEX, 0.4, 1)
        cv2.rectangle(out_img, (lbl_x, lbl_y - th - 5), (lbl_x + tw + 6, lbl_y + baseline), bgr, -1)
        cv2.putText(out_img, lbl_txt, (lbl_x + 3, lbl_y - 2), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (255, 255, 255), 1, cv2.LINE_AA)
        
    return out_img

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
            if payload.run_only_nodes is not None and n["id"] not in payload.run_only_nodes:
                continue
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
                    mapped_class_id = None
                    target_class_name = None
                    target_color = "#3b82f6" # default blue

                    # 1. Direct lookup: class_bindings stores { yolo_cls_id: custom_cls_idx }
                    bind_val = class_bindings.get(str(cls_id))
                    if bind_val is not None and bind_val != "":
                        try:
                            c_idx = int(bind_val)
                            if c_idx < len(src_classes):
                                mapped_class_id = c_idx
                                target_class_name = src_classes[c_idx]["name"]
                                target_color = src_classes[c_idx]["color"]
                        except ValueError:
                            pass

                    # 2. Reverse lookup: class_bindings stores { custom_cls_idx: yolo_cls_id }
                    if mapped_class_id is None:
                        for cust_cls_idx_str, yolo_cls_id_str in class_bindings.items():
                            if str(yolo_cls_id_str) == str(cls_id):
                                try:
                                    c_idx = int(cust_cls_idx_str)
                                    if c_idx < len(src_classes):
                                        mapped_class_id = c_idx
                                        target_class_name = src_classes[c_idx]["name"]
                                        target_color = src_classes[c_idx]["color"]
                                        break
                                except ValueError:
                                    pass

                    # If Class input is connected, only include detections with valid class bindings
                    if class_source:
                        if mapped_class_id is None:
                            continue
                    else:
                        # Fallback if no Class node is connected at all
                        if mapped_class_id is None:
                            mapped_class_id = cls_id
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
                        "confidence": conf_val,
                        "is_segment": is_segment
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
                    tag_type = '<span style="color:#34d399; font-weight:bold;">[Segment]</span>' if det.get('is_segment') else '<span style="color:#38bdf8;">[BBox]</span>'
                    log_html += f"<div>• {det['class_name']}: {det['confidence']*100:.1f}% {tag_type}</div>"
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

            # Get connected point input
            point_source = connections_to.get((node_id, "point"))
            point_data = None
            if point_source:
                point_data = evaluate(point_source[0], point_source[1])
            
            has_points = point_data is not None and "points" in point_data and point_data["points"]
            
            if not prompts and not has_points:
                # If no prompts and no points are defined, return empty
                # Copy image for preview (or just load it)
                img = cv2.imread(src_image_path)
                if img is not None:
                    _, buffer = cv2.imencode(".jpg", img)
                    preview_b64 = base64.b64encode(buffer).decode("utf-8")
                else:
                    preview_b64 = ""
                
                log_html = '<div style="color:var(--text-muted);">No prompts or points configured. Add a prompt binding or connect a pointer node.</div>'
                
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
                    predict_kwargs = {}
                    if prompts:
                        predict_kwargs["text"] = prompts
                    if has_points:
                        if "points" in point_data and "labels" in point_data:
                            predict_kwargs["points"] = point_data["points"]
                            predict_kwargs["labels"] = point_data["labels"]
                    
                    results = predictor(**predict_kwargs)
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

        # 4. Pointer Node
        elif node["type"] == "pointer":
            event_queue.put({"type": "start", "node_id": node_id})

            # Get connected image input
            img_source = connections_to.get((node_id, "image"))
            if not img_source:
                event_queue.put({"type": "end", "node_id": node_id})
                raise HTTPException(status_code=400, detail="Pointer node is missing connected 'Image' input")
            
            src_image_path = evaluate(img_source[0], img_source[1])

            # Get points
            raw_points = node["properties"].get("points", [])
            
            # Draw preview base64
            img = cv2.imread(src_image_path)
            if img is None:
                event_queue.put({"type": "end", "node_id": node_id})
                raise HTTPException(status_code=500, detail=f"Failed to load image '{src_image_path}' for Pointer preview")
            h, w = img.shape[:2]

            # If there are no points, it is blocking!
            if not raw_points:
                # We still generate a preview of the clean image so the user can see it to click!
                _, buffer = cv2.imencode(".jpg", img)
                preview_b64 = base64.b64encode(buffer).decode("utf-8")
                
                with cache_lock:
                    previews[node_id] = preview_b64
                    logs[node_id] = "Blocking: Please select at least one point on the image to continue."
                    eval_cache[(node_id, "image")] = src_image_path
                    eval_cache[(node_id, "point")] = {"points": [], "labels": []}
                
                event_queue.put({"type": "end", "node_id": node_id})
                event_queue.put({
                    "type": "preview",
                    "node_id": node_id,
                    "preview": preview_b64,
                    "logs": logs[node_id]
                })
                raise HTTPException(status_code=400, detail="Pointer node blocking: Silakan tentukan titik (point) pada gambar terlebih dahulu.")

            # If there are points, draw them on the preview
            preview_img = img.copy()
            for pt in raw_points:
                pt_x = int(pt["x"] * w)
                pt_y = int(pt["y"] * h)
                label = pt["label"]
                color = (0, 255, 0) if label == 1 else (0, 0, 255) # Green positive, Red negative
                cv2.circle(preview_img, (pt_x, pt_y), 8, color, -1)
                cv2.circle(preview_img, (pt_x, pt_y), 8, (255, 255, 255), 2)
                text = "+" if label == 1 else "-"
                cv2.putText(preview_img, text, (pt_x - 5, pt_y + 4), 
                            cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 2)

            _, buffer = cv2.imencode(".jpg", preview_img)
            preview_b64 = base64.b64encode(buffer).decode("utf-8")

            # Convert point list to format compatible with SAM/SAM3 predictor or general usage:
            # point_data is dict: {"points": [[x, y], ...], "labels": [1, 0, ...]}
            # where coordinates are absolute in the original image space
            points_list = []
            labels_list = []
            for pt in raw_points:
                points_list.append([float(pt["x"] * w), float(pt["y"] * h)])
                labels_list.append(int(pt["label"]))

            point_data = {
                "points": points_list,
                "labels": labels_list
            }

            with cache_lock:
                previews[node_id] = preview_b64
                logs[node_id] = f"Processed {len(raw_points)} points."
                # Cache outputs
                eval_cache[(node_id, "image")] = src_image_path
                eval_cache[(node_id, "point")] = point_data

            event_queue.put({"type": "end", "node_id": node_id})
            event_queue.put({
                "type": "preview",
                "node_id": node_id,
                "preview": preview_b64,
                "logs": logs[node_id]
            })

            return eval_cache[cache_key]

        # 5. AI Decision Node
        elif node["type"] == "ai_decision":
            event_queue.put({"type": "start", "node_id": node_id})
            
            worker_input_src = connections_to.get((node_id, "worker_input"))
            if not worker_input_src:
                event_queue.put({"type": "end", "node_id": node_id})
                raise HTTPException(status_code=400, detail="AI Decision node: worker_input input is missing connection.")
                
            worker_input_key = (worker_input_src[0], worker_input_src[1])
            with cache_lock:
                worker_payload = eval_cache.get(worker_input_key)
                
            if worker_payload is None:
                worker_payload = evaluate(worker_input_src[0], worker_input_src[1])

            conn = sqlite3.connect(DB_PATH)
            cursor = conn.cursor()
            cursor.execute("SELECT value FROM ai_decision_config WHERE key = 'endpoints'")
            endpoints_row = cursor.fetchone()
            cursor.execute("SELECT value FROM ai_decision_config WHERE key = 'models'")
            models_row = cursor.fetchone()
            conn.close()
            
            endpoints = json.loads(endpoints_row[0]) if endpoints_row else []
            model_name = node["properties"].get("model", "").strip()
            if not model_name:
                model_name = "gemini-1.5-flash"
                
            messages = worker_payload.get("history", [])
            
            try:
                response_text = call_vlm_api(endpoints, model_name, messages)
            except Exception as ex:
                response_text = f"Error calling VLM API: {str(ex)}"
                
            with cache_lock:
                eval_cache[(node_id, "worker_output")] = response_text
                
            event_queue.put({"type": "end", "node_id": node_id})
            
            updated_history = list(messages)
            updated_history.append({"role": "assistant", "content": response_text})
            
            try:
                conn = sqlite3.connect(DB_PATH)
                cursor = conn.cursor()
                cursor.execute("SELECT id, nodes FROM canvas_tabs WHERE is_active = 1 LIMIT 1")
                tab_row = cursor.fetchone()
                if tab_row:
                    tab_id, nodes_json = tab_row[0], tab_row[1]
                    nodes_list = json.loads(nodes_json)
                    for n in nodes_list:
                        if n["id"] == node_id:
                            n["properties"]["last_chat_history"] = updated_history
                            break
                    cursor.execute("UPDATE canvas_tabs SET nodes = ? WHERE id = ?", (json.dumps(nodes_list), tab_id))
                    conn.commit()
                conn.close()
            except Exception:
                pass
                
            event_queue.put({
                "type": "chat_history_update",
                "node_id": node_id,
                "chat_history": updated_history
            })
            
            return response_text

        # 5b. AI Queueing Node
        elif node["type"] == "ai_queueing":
            event_queue.put({"type": "start", "node_id": node_id})
            
            img_src = connections_to.get((node_id, "image"))
            if not img_src:
                event_queue.put({"type": "end", "node_id": node_id})
                raise HTTPException(status_code=400, detail="AI Queueing node: image input is missing connection.")
            src_image_path = evaluate(img_src[0], img_src[1])
            img = cv2.imread(src_image_path)
            if img is None:
                event_queue.put({"type": "end", "node_id": node_id})
                raise HTTPException(status_code=400, detail="AI Queueing node: Failed to load image.")
            h, w = img.shape[:2]

            proc_src = connections_to.get((node_id, "processed_annotation"))
            if not proc_src:
                event_queue.put({"type": "end", "node_id": node_id})
                raise HTTPException(status_code=400, detail="AI Queueing node: processed_annotation input is missing connection.")
            processed_ann = evaluate(proc_src[0], proc_src[1])

            orig_src = connections_to.get((node_id, "original_annotate"))
            original_annotations = []
            if orig_src:
                original_annotations = evaluate(orig_src[0], orig_src[1])

            src_classes = []
            for n in nodes.values():
                if n["type"] in ("single_image", "folder"):
                    src_classes = n["properties"].get("classes", [])
                    if src_classes:
                        break

            # Normalize processed_ann: may be a plain list (from YOLO/SAM3 direct output),
            # or a dict from overlap_comparator with "conflict_pairs" / "resolved_annotations"
            if isinstance(processed_ann, list):
                conflict_pairs = []
                resolved_annotations = list(processed_ann)
            elif isinstance(processed_ann, dict):
                raw_pairs = processed_ann.get("conflict_pairs", [])
                resolved_annotations = list(processed_ann.get("resolved_annotations", []))
                # Normalize old-format pairs (detection_a/detection_b) to new items[] format
                conflict_pairs = []
                for cp in raw_pairs:
                    if "items" in cp:
                        conflict_pairs.append(cp)
                    elif "detection_a" in cp and "detection_b" in cp:
                        # Convert old format to new items[] format
                        items = []
                        for idx, det_key in enumerate(["detection_a", "detection_b"]):
                            det = cp[det_key]
                            items.append({
                                "index": idx + 1,
                                "pin_name": det.get("source_pin", ""),
                                "pin_label": det.get("source_label", str(idx + 1)),
                                "class_id": det.get("class_id", 0),
                                "class_name": det.get("class_name", ""),
                                "image": det.get("image", ""),
                                "bbox_crop": det.get("bbox_crop", ""),
                                "seg_crop": det.get("seg_crop", ""),
                                "coords": det.get("coords", []),
                                "is_segment": det.get("is_segment", False),
                                "confidence": det.get("confidence", 1.0)
                            })
                        conflict_pairs.append({
                            "pair_id": cp.get("pair_id", f"conflict-{len(conflict_pairs)+1}"),
                            "action": "compare",
                            "items": items
                        })
            else:
                conflict_pairs = []
                resolved_annotations = []
            failed_annotations = []
            
            active_workers = []
            for conn in payload.connections:
                if conn.get("fromNodeId") == node_id and conn.get("fromPinName", "").startswith("worker_input_"):
                    to_nid = conn.get("toNodeId")
                    to_pin = conn.get("toPinName")
                    from_pin = conn.get("fromPinName")
                    try:
                        w_idx = int(from_pin.replace("worker_input_", ""))
                        active_workers.append((w_idx, to_nid, to_pin))
                    except ValueError:
                        pass
            
            if not active_workers:
                event_queue.put({"type": "end", "node_id": node_id})
                raise HTTPException(status_code=400, detail="AI Queueing node: Hubungkan setidaknya satu worker (AI Decision) terlebih dahulu.")
                
            active_workers.sort()
            max_retries = node["properties"].get("max_retries", 3)
            
            K = len(conflict_pairs)
            for k, cp in enumerate(conflict_pairs):
                while _paused_queues.get(node_id, False):
                    event_queue.put({
                        "type": "node_state_update",
                        "node_id": node_id,
                        "properties": {
                            "paused": True,
                            "last_logs": f'<div style="color:#f59e0b; font-weight:bold;">[PAUSED] Queue paused at conflict {k+1}/{K}. click Resume to continue.</div>'
                        }
                    })
                    time.sleep(0.5)
                    
                w_idx, w_nid, w_pin = active_workers[k % len(active_workers)]
                
                worker_node = nodes.get(w_nid)
                global_rules = worker_node["properties"].get("global_rules", "")
                class_rules = worker_node["properties"].get("class_rules", {})
                if not isinstance(class_rules, dict):
                    class_rules = {}
                
                available_classes_str = ", ".join(f"[{i}: {c['name']}]" for i, c in enumerate(src_classes))
                if not available_classes_str:
                    available_classes_str = "[0: car], [1: truck], [2: bus]"
                    
                class_rules_str = ""
                if class_rules:
                    class_rules_str = "\n".join(f"- Rule '{rule_txt}' -> Target: {src_classes[int(c_idx)]['name'] if int(c_idx) < len(src_classes) else c_idx}" for rule_txt, c_idx in class_rules.items())
                else:
                    class_rules_str = "- (None)"
                    
                image_input_str = "\n".join(f"image {item['index']}: {item['class_name']}" for item in cp["items"])
                
                prompt = global_rules
                if "{class_rules}" in prompt:
                    prompt = prompt.replace("{class_rules}", class_rules_str)
                if "{class}" in prompt:
                    prompt = prompt.replace("{class}", available_classes_str)
                if "{image_input}" in prompt:
                    prompt = prompt.replace("{image_input}", image_input_str)
                else:
                    prompt += f"\n\nClass Rules:\n{class_rules_str}\n\nAvailable Classes:\n{available_classes_str}\n\nImage Inputs:\n{image_input_str}"
                
                candidate_images = [item["image"] for item in cp["items"]]
                
                messages = [
                    {
                        "role": "user",
                        "content": prompt,
                        "images": candidate_images
                    }
                ]
                
                choice = None
                for attempt in range(max_retries):
                    progress_pct = int((k / K) * 100) if K > 0 else 100
                    status_log = f'<div style="color:#38bdf8;">Resolving conflict {k+1}/{K} ({progress_pct}%) - Attempt {attempt+1}/{max_retries}...</div>'
                    
                    event_queue.put({
                        "type": "node_state_update",
                        "node_id": node_id,
                        "properties": {
                            "is_processing": True,
                            "last_logs": status_log
                        }
                    })
                    event_queue.put({
                        "type": "node_state_update",
                        "node_id": w_nid,
                        "properties": {
                            "is_processing": True
                        }
                    })
                    
                    payload_key = (node_id, f"worker_input_{w_idx}")
                    with cache_lock:
                        eval_cache[payload_key] = {
                            "conflict_pair": cp,
                            "global_rules": global_rules,
                            "history": list(messages)
                        }
                        if (w_nid, "worker_output") in eval_cache:
                            del eval_cache[(w_nid, "worker_output")]
                            
                    try:
                        vlm_output = evaluate(w_nid, "worker_output")
                    except Exception as ex:
                        vlm_output = f"Error during execution: {str(ex)}"
                        
                    event_queue.put({
                        "type": "node_state_update",
                        "node_id": w_nid,
                        "properties": {
                            "is_processing": False
                        }
                    })
                    
                    messages.append({"role": "assistant", "content": vlm_output})
                    
                    parsed_choice = parse_ai_choice(vlm_output, len(cp["items"]))
                    if parsed_choice is not None:
                        choice = parsed_choice
                        event_queue.put({
                            "type": "chat_history_update",
                            "node_id": w_nid,
                            "chat_history": list(messages)
                        })
                        break
                    else:
                        err_msg = f"Failed to parse selection. Output must be a valid JSON containing a 'choice' key indicating an integer index from 1 to {len(cp['items'])}."
                        messages.append({"role": "error", "content": err_msg})
                        event_queue.put({
                            "type": "chat_history_update",
                            "node_id": w_nid,
                            "chat_history": list(messages)
                        })
                        
                if choice is not None:
                    selected_item = cp["items"][choice - 1]
                    resolved_annotations.append({
                        "class_id": selected_item["class_id"],
                        "coords": selected_item["coords"],
                        "is_segment": selected_item["is_segment"],
                        "confidence": selected_item.get("confidence", 1.0)
                    })
                else:
                    for item in cp["items"]:
                        failed_annotations.append({
                            "class_id": item["class_id"],
                            "coords": item["coords"],
                            "is_segment": item["is_segment"],
                            "confidence": item.get("confidence", 1.0)
                        })
                        
            final_resolved = resolved_annotations
            
            preview_img = draw_resolved_annotations(img, final_resolved, src_classes)
            _, buffer = cv2.imencode(".jpg", preview_img)
            preview_b64 = base64.b64encode(buffer).decode("utf-8")
            
            log_html = f'<div style="color:#34d399; font-weight:bold;">Queue finished! Resolved {len(final_resolved)} annotations.</div>'
            if failed_annotations:
                log_html += f'<div style="color:#ef4444; font-weight:bold;">{len(failed_annotations)} annotations failed to resolve and routed to failed output.</div>'
                
            with cache_lock:
                previews[node_id] = preview_b64
                logs[node_id] = log_html
                
                eval_cache[(node_id, "image")] = src_image_path
                eval_cache[(node_id, "annotation")] = final_resolved
                eval_cache[(node_id, "failed_image")] = src_image_path
                eval_cache[(node_id, "failed_annotation")] = failed_annotations
                
            event_queue.put({
                "type": "node_state_update",
                "node_id": node_id,
                "properties": {
                    "is_processing": False,
                    "paused": False,
                    "last_logs": log_html,
                    "last_preview": preview_b64
                }
            })
            
            event_queue.put({"type": "end", "node_id": node_id})
            event_queue.put({
                "type": "preview",
                "node_id": node_id,
                "preview": preview_b64,
                "logs": log_html
            })
            return eval_cache[cache_key]
        # 6. Overlap Comparator Node
        elif node["type"] == "overlap_comparator":
            event_queue.put({"type": "start", "node_id": node_id})

            img_source = connections_to.get((node_id, "image"))
            if not img_source:
                event_queue.put({"type": "end", "node_id": node_id})
                raise HTTPException(status_code=400, detail="Overlap Comparator node is missing connected 'Image' input")
            
            src_image_path = evaluate(img_source[0], img_source[1])
            processed_data, preview_items = process_overlap_comparator_node(node, connections_to, evaluate)

            with cache_lock:
                previews[node_id] = preview_items
                eval_cache[(node_id, "image")] = src_image_path
                eval_cache[(node_id, "processed_annotation")] = processed_data

            event_queue.put({"type": "end", "node_id": node_id})
            event_queue.put({
                "type": "preview",
                "node_id": node_id,
                "preview": preview_items,
                "logs": ""
            })
            return eval_cache[cache_key]

        # 7. Save Annotation Node
        elif node["type"] == "save_annotation":
            event_queue.put({"type": "start", "node_id": node_id})

            output_dir = node["properties"].get("output_dir", "").strip()
            if not output_dir:
                event_queue.put({"type": "end", "node_id": node_id})
                log_html = '<div style="color:#ef4444; font-weight:bold;">[ERROR] Save directory is empty. Click Browse to select a folder.</div>'
                logs[node_id] = log_html
                event_queue.put({"type": "preview", "node_id": node_id, "preview": None, "logs": log_html})
                raise HTTPException(status_code=400, detail="Save Annotation node: Folder output belum ditentukan.")

            images_dir = os.path.join(output_dir, "images")
            labels_dir = os.path.join(output_dir, "labels")

            # Ensure subfolders exist or create them
            try:
                os.makedirs(images_dir, exist_ok=True)
                os.makedirs(labels_dir, exist_ok=True)
            except Exception as ex:
                event_queue.put({"type": "end", "node_id": node_id})
                log_html = f'<div style="color:#ef4444; font-weight:bold;">[ERROR] Gagal membuat subfolder images/labels: {str(ex)}</div>'
                logs[node_id] = log_html
                event_queue.put({"type": "preview", "node_id": node_id, "preview": None, "logs": log_html})
                raise HTTPException(status_code=400, detail=f"Save Annotation node: Gagal membuat folder: {str(ex)}")

            # Write permission test
            test_file_path = os.path.join(output_dir, ".write_test")
            try:
                with open(test_file_path, "w", encoding="utf-8") as f_test:
                    f_test.write("test")
                if os.path.exists(test_file_path):
                    os.remove(test_file_path)
            except Exception as ex:
                event_queue.put({"type": "end", "node_id": node_id})
                log_html = f'<div style="color:#ef4444; font-weight:bold;">[ERROR] Folder tidak dapat ditulis (Write Failed): {str(ex)}</div>'
                logs[node_id] = log_html
                event_queue.put({"type": "preview", "node_id": node_id, "preview": None, "logs": log_html})
                raise HTTPException(status_code=400, detail=f"Save Annotation node: Error Gagal Write ke Folder: {str(ex)}")

            # Evaluate inputs
            img_source = connections_to.get((node_id, "image"))
            anno_source = connections_to.get((node_id, "annotation"))

            if not img_source or not anno_source:
                event_queue.put({"type": "end", "node_id": node_id})
                log_html = '<div style="color:#ef4444; font-weight:bold;">[ERROR] Input Image atau Annotation belum terhubung.</div>'
                logs[node_id] = log_html
                event_queue.put({"type": "preview", "node_id": node_id, "preview": None, "logs": log_html})
                raise HTTPException(status_code=400, detail="Save Annotation node: Missing Image or Annotation input connection.")

            src_image_path = evaluate(img_source[0], img_source[1])
            src_annotations = evaluate(anno_source[0], anno_source[1])

            # If src_annotations is dict (from processed_annotation output pin of overlap_comparator):
            if isinstance(src_annotations, dict) and "resolved_annotations" in src_annotations:
                src_annotations = src_annotations["resolved_annotations"]

            # Save Image
            img_filename = os.path.basename(src_image_path)
            dest_img_path = os.path.join(images_dir, img_filename)
            try:
                shutil.copy2(src_image_path, dest_img_path)
            except Exception as ex:
                event_queue.put({"type": "end", "node_id": node_id})
                log_html = f'<div style="color:#ef4444; font-weight:bold;">[ERROR] Gagal menyalin gambar: {str(ex)}</div>'
                logs[node_id] = log_html
                event_queue.put({"type": "preview", "node_id": node_id, "preview": None, "logs": log_html})
                raise HTTPException(status_code=500, detail=f"Save Annotation node: Gagal menyalin gambar: {str(ex)}")

            # Save YOLO Label File
            img_basename = os.path.splitext(img_filename)[0]
            label_filename = f"{img_basename}.txt"
            dest_label_path = os.path.join(labels_dir, label_filename)

            try:
                with open(dest_label_path, "w", encoding="utf-8") as f_lbl:
                    for anno in src_annotations:
                        class_id = anno["class_id"]
                        coords = anno["coords"]
                        coords_str = " ".join([f"{c:.6f}" for c in coords])
                        f_lbl.write(f"{class_id} {coords_str}\n")
            except Exception as ex:
                event_queue.put({"type": "end", "node_id": node_id})
                log_html = f'<div style="color:#ef4444; font-weight:bold;">[ERROR] Gagal menulis file label txt: {str(ex)}</div>'
                logs[node_id] = log_html
                event_queue.put({"type": "preview", "node_id": node_id, "preview": None, "logs": log_html})
                raise HTTPException(status_code=500, detail=f"Save Annotation node: Gagal menulis file label: {str(ex)}")

            log_html = f'''<div style="color:#34d399; font-weight:bold;">[SUCCESS] Berhasil disimpan!</div>
<div style="font-size:0.7rem; color:var(--text-secondary);">
• Image: {img_filename}<br/>
• Labels ({len(src_annotations)} objects): {label_filename}
</div>'''
            logs[node_id] = log_html

            with cache_lock:
                eval_cache[(node_id, "image")] = dest_img_path

            event_queue.put({"type": "end", "node_id": node_id})
            event_queue.put({
                "type": "preview",
                "node_id": node_id,
                "preview": None,
                "logs": log_html
            })

            return dest_img_path

        raise HTTPException(status_code=400, detail=f"Cannot evaluate output pin {pin_name} on node {node_id}")

    def run_all():
        try:
            preview_nodes = [n for n in payload.nodes if n["type"] in ("preview", "overlap_comparator", "save_annotation")]
            if payload.run_only_nodes is not None:
                preview_nodes = [n for n in preview_nodes if n["id"] in payload.run_only_nodes]
            
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
                        event_queue.put({"type": "start", "node_id": p_node_id})
                        try:
                            evaluate(p_node_id, "processed_annotation")
                        except Exception as ex:
                            event_queue.put({"type": "end", "node_id": p_node_id})
                            event_queue.put({"type": "error", "message": f"Overlap Comparator node error: {str(ex)}"})
                    elif n["type"] == "save_annotation":
                        event_queue.put({"type": "start", "node_id": p_node_id})
                        try:
                            evaluate(p_node_id, "image")
                        except Exception as ex:
                            event_queue.put({"type": "end", "node_id": p_node_id})
                            event_queue.put({"type": "error", "message": f"Save Annotation node error: {str(ex)}"})

                with concurrent.futures.ThreadPoolExecutor(max_workers=len(preview_nodes)) as executor:
                    executor.map(process_preview, preview_nodes)
            else:
                # Spawning evaluations for YOLO or SAM3 or pointer directly
                direct_nodes = [n for n in payload.nodes if n["type"] in ("yolo_detector", "sam3", "pointer", "ai_decision")]
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
