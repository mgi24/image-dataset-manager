import os
import sys
import shutil
import mimetypes
import yaml
import sqlite3
import threading
import json
import base64
import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Optional
import uvicorn

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATASET_DIR = os.path.join(BASE_DIR, 'dataset')
DB_PATH = os.path.join(BASE_DIR, 'dataset_manager.db')

def init_db():
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS tags (
            name TEXT PRIMARY KEY
        );
    """)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS image_tags (
            dataset_name TEXT,
            image_filename TEXT,
            tag_name TEXT,
            PRIMARY KEY (dataset_name, image_filename, tag_name),
            FOREIGN KEY (tag_name) REFERENCES tags (name) ON DELETE CASCADE
        );
    """)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS auto_annotate_settings (
            dataset_name TEXT PRIMARY KEY,
            model TEXT DEFAULT 'sam3.1',
            prompts TEXT DEFAULT '[]',
            on_approved_tags TEXT DEFAULT '[]',
            conf REAL DEFAULT 0.25,
            iou REAL DEFAULT 0.85,
            device TEXT DEFAULT 'cuda:0',
            recheck INTEGER DEFAULT 0,
            recheck_model TEXT DEFAULT 'sam3',
            recheck_device TEXT DEFAULT 'cuda:0',
            recheck_min_area REAL DEFAULT 0.70,
            recheck_max_area REAL DEFAULT 1.20,
            recheck_imgsz INTEGER DEFAULT 1024,
            magic_model TEXT DEFAULT 'sam3',
            magic_device TEXT DEFAULT 'cuda:0',
            magic_imgsz INTEGER DEFAULT 1024,
            yolo_entries TEXT DEFAULT '[]'
        );
    """)
    # Add columns if migrating an existing DB
    try:
        cursor.execute("ALTER TABLE auto_annotate_settings ADD COLUMN yolo_entries TEXT DEFAULT '[]';")
    except sqlite3.OperationalError:
        pass
    try:
        cursor.execute("ALTER TABLE auto_annotate_settings ADD COLUMN conf REAL DEFAULT 0.25;")
    except sqlite3.OperationalError:
        pass
    try:
        cursor.execute("ALTER TABLE auto_annotate_settings ADD COLUMN iou REAL DEFAULT 0.85;")
    except sqlite3.OperationalError:
        pass
    try:
        cursor.execute("ALTER TABLE auto_annotate_settings ADD COLUMN recheck INTEGER DEFAULT 0;")
    except sqlite3.OperationalError:
        pass
    try:
        cursor.execute("ALTER TABLE auto_annotate_settings ADD COLUMN recheck_model TEXT DEFAULT 'sam3';")
    except sqlite3.OperationalError:
        pass
    try:
        cursor.execute("ALTER TABLE auto_annotate_settings ADD COLUMN recheck_min_area REAL DEFAULT 0.70;")
    except sqlite3.OperationalError:
        pass
    try:
        cursor.execute("ALTER TABLE auto_annotate_settings ADD COLUMN recheck_max_area REAL DEFAULT 1.20;")
    except sqlite3.OperationalError:
        pass
    try:
        cursor.execute("ALTER TABLE auto_annotate_settings ADD COLUMN device TEXT DEFAULT 'cuda:0';")
    except sqlite3.OperationalError:
        pass
    try:
        cursor.execute("ALTER TABLE auto_annotate_settings ADD COLUMN recheck_device TEXT DEFAULT 'cuda:0';")
    except sqlite3.OperationalError:
        pass
    try:
        cursor.execute("ALTER TABLE auto_annotate_settings ADD COLUMN recheck_imgsz INTEGER DEFAULT 1024;")
    except sqlite3.OperationalError:
        pass
    try:
        cursor.execute("ALTER TABLE auto_annotate_settings ADD COLUMN magic_model TEXT DEFAULT 'sam3';")
    except sqlite3.OperationalError:
        pass
    try:
        cursor.execute("ALTER TABLE auto_annotate_settings ADD COLUMN magic_device TEXT DEFAULT 'cuda:0';")
    except sqlite3.OperationalError:
        pass
    try:
        cursor.execute("ALTER TABLE auto_annotate_settings ADD COLUMN magic_imgsz INTEGER DEFAULT 1024;")
    except sqlite3.OperationalError:
        pass

    # Create LLM Settings table
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS llm_settings (
            id INTEGER PRIMARY KEY,
            api_url TEXT DEFAULT 'http://127.0.0.1:1234',
            api_key TEXT DEFAULT '',
            model TEXT DEFAULT '',
            dataset_type TEXT DEFAULT 'object_detection',
            autosave INTEGER DEFAULT 0,
            auto_layering INTEGER DEFAULT 0
        );
    """)
    try:
        cursor.execute("ALTER TABLE llm_settings ADD COLUMN autosave INTEGER DEFAULT 0;")
    except sqlite3.OperationalError:
        pass
    try:
        cursor.execute("ALTER TABLE llm_settings ADD COLUMN auto_layering INTEGER DEFAULT 0;")
    except sqlite3.OperationalError:
        pass

    # Insert default row if not exists
    cursor.execute("""
        INSERT OR IGNORE INTO llm_settings (id, api_url, api_key, model, dataset_type, autosave, auto_layering)
        VALUES (1, 'http://127.0.0.1:1234', '', '', 'object_detection', 0, 0);
    """)

    # Try migration from JSON to DB
    json_path = os.path.join(BASE_DIR, 'llm_settings.json')
    if os.path.exists(json_path):
        try:
            with open(json_path, 'r', encoding='utf-8') as f:
                data = json.load(f)
            api_url = data.get("api_url", "http://127.0.0.1:1234")
            api_key = data.get("api_key", "")
            model = data.get("model", "")
            dataset_type = data.get("dataset_type", "object_detection")
            
            cursor.execute("""
                INSERT OR REPLACE INTO llm_settings (id, api_url, api_key, model, dataset_type)
                VALUES (1, ?, ?, ?, ?);
            """, (api_url, api_key, model, dataset_type))
            conn.commit()
            print("Successfully migrated llm_settings.json to database.")
            # Rename the json file to prevent re-migration
            os.rename(json_path, json_path + ".bak")
        except Exception as e:
            print(f"Failed to migrate llm_settings.json: {e}")

    conn.commit()
    conn.close()

init_db()

app = FastAPI(title="Antigravity Dataset Manager API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class ClassSettingsUpdate(BaseModel):
    names: list
    color: list

class DeleteImagesRequest(BaseModel):
    filenames: List[str]

class RenameImageRequest(BaseModel):
    old_filename: str
    new_filename: str

class AnnotateMoveRequest(BaseModel):
    filenames: List[str]

class BatchRenameRequest(BaseModel):
    base_name: str
    filenames: List[str]
    mode: str = "overwrite"

class TagCreate(BaseModel):
    name: str

class ImageTagsUpdate(BaseModel):
    filenames: List[str]
    tags: List[str]

class AutoAnnotateSettingsUpdate(BaseModel):
    model: str = 'sam3.1'
    prompts: list = []       # [{"prompt": str, "class_id": int}, ...]
    on_approved_tags: list = []
    conf: Optional[float] = 0.25
    iou: Optional[float] = 0.85
    device: Optional[str] = 'cuda:0'
    recheck: Optional[bool] = False
    recheck_model: Optional[str] = 'sam3'
    recheck_device: Optional[str] = 'cuda:0'
    recheck_min_area: Optional[float] = 0.70
    recheck_max_area: Optional[float] = 1.20
    recheck_imgsz: Optional[int] = 1024
    magic_model: Optional[str] = 'sam3'
    magic_device: Optional[str] = 'cuda:0'
    magic_imgsz: Optional[int] = 1024
    yolo_entries: list = []

class SamAutoAnnotateRequest(BaseModel):
    filename: str
    model: str = 'sam3.1'
    prompts: list = []       # [{"prompt": str, "class_id": int}, ...]
    conf: Optional[float] = 0.25
    iou: Optional[float] = 0.85
    device: Optional[str] = 'cuda:0'
    recheck: Optional[bool] = False
    recheck_model: Optional[str] = 'sam3'
    recheck_device: Optional[str] = 'cuda:0'
    recheck_min_area: Optional[float] = 0.70
    recheck_max_area: Optional[float] = 1.20
    recheck_imgsz: Optional[int] = 1024

class LLMSettings(BaseModel):
    api_url: str
    api_key: Optional[str] = ""
    model: Optional[str] = ""
    dataset_type: Optional[str] = "object_detection"
    autosave: Optional[bool] = False
    auto_layering: Optional[bool] = False

class MoveImagesRequest(BaseModel):
    filenames: List[str]

class SaveAnnotationsRequest(BaseModel):
    filename: str
    annotations: list

class YoloClassPair(BaseModel):
    yolo_class_id: int
    ds_class_id: int

class YoloDetectRequest(BaseModel):
    filename: str
    model: str = 'yolov26x'
    conf: Optional[float] = 0.25
    device: Optional[str] = 'cuda:0'
    pairs: List[YoloClassPair] = []



# ─────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────

def parse_label_file(label_path):
    annotations = []
    if os.path.exists(label_path):
        try:
            with open(label_path, 'r', encoding='utf-8') as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    parts = line.split()
                    try:
                        class_id = int(parts[0])
                        coords = [float(x) for x in parts[1:]]
                        points = []
                        for i in range(0, len(coords), 2):
                            if i + 1 < len(coords):
                                points.append([coords[i], coords[i+1]])
                        annotations.append({"class_id": class_id, "points": points})
                    except Exception:
                        pass
        except Exception as e:
            print(f"Error reading label file {label_path}: {e}")
    return annotations


def load_data_yaml(yaml_path):
    if os.path.exists(yaml_path):
        try:
            with open(yaml_path, 'r', encoding='utf-8') as f:
                data = yaml.safe_load(f) or {}
                names = data.get('names', [])
                colors = data.get('color', [])
                if not isinstance(colors, list) or colors is None:
                    colors = []
                while len(colors) < len(names):
                    colors.append('#ff0000')
                return {"names": names, "color": colors}
        except Exception as e:
            print(f"Error parsing YAML {yaml_path}: {e}")
    return {"names": [], "color": []}


def safe_dataset_path(dataset_name: str) -> str:
    """Return absolute dataset path or raise 404 if not valid."""
    dataset_path = os.path.normpath(os.path.join(DATASET_DIR, dataset_name))
    if not dataset_path.startswith(os.path.normpath(DATASET_DIR)):
        raise HTTPException(status_code=403, detail="Access denied")
    if not os.path.isdir(dataset_path):
        raise HTTPException(status_code=404, detail="Dataset not found")
    return dataset_path

# ─────────────────────────────────────────────
# Static routes
# ─────────────────────────────────────────────

@app.get("/", response_class=HTMLResponse)
def serve_dashboard():
    index_path = os.path.join(BASE_DIR, 'index.html')
    if os.path.exists(index_path):
        with open(index_path, 'r', encoding='utf-8') as f:
            return f.read()
    raise HTTPException(status_code=404, detail="index.html not found")


@app.get("/dataset/{dataset_name}/images/{filename:path}")
def serve_image(dataset_name: str, filename: str):
    dataset_path = safe_dataset_path(dataset_name)
    file_path = os.path.normpath(os.path.join(dataset_path, 'images', filename))
    if not file_path.startswith(os.path.normpath(DATASET_DIR)):
        raise HTTPException(status_code=403, detail="Access denied")
    if os.path.isfile(file_path):
        mime_type, _ = mimetypes.guess_type(file_path)
        return FileResponse(file_path,
                            media_type=mime_type or "application/octet-stream",
                            headers={"Cache-Control": "public, max-age=3600"})
    raise HTTPException(status_code=404, detail="Image not found")


@app.get("/dataset/{dataset_name}/annotate/images/{filename:path}")
def serve_annotate_image(dataset_name: str, filename: str):
    dataset_path = safe_dataset_path(dataset_name)
    file_path = os.path.normpath(os.path.join(dataset_path, 'annotate', 'images', filename))
    if not file_path.startswith(os.path.normpath(DATASET_DIR)):
        raise HTTPException(status_code=403, detail="Access denied")
    if os.path.isfile(file_path):
        mime_type, _ = mimetypes.guess_type(file_path)
        return FileResponse(file_path, media_type=mime_type or "application/octet-stream",
                            headers={"Cache-Control": "public, max-age=3600"})
    raise HTTPException(status_code=404, detail="Image not found")

# ─────────────────────────────────────────────
# Dataset listing API
# ─────────────────────────────────────────────

@app.get("/api/datasets")
def list_datasets():
    datasets = []
    if not os.path.exists(DATASET_DIR):
        return datasets
    try:
        for entry in sorted(os.listdir(DATASET_DIR)):
            entry_path = os.path.join(DATASET_DIR, entry)
            if not os.path.isdir(entry_path):
                continue
            images_dir = os.path.join(entry_path, 'images')
            labels_dir = os.path.join(entry_path, 'labels')
            yaml_path  = os.path.join(entry_path, 'data.yaml')
            if not os.path.exists(images_dir):
                continue
            img_files = sorted([
                f for f in os.listdir(images_dir)
                if os.path.splitext(f)[1].lower() in {'.jpg', '.jpeg', '.png', '.bmp', '.webp'}
            ])
            preview = None
            if img_files:
                pf = img_files[0]
                lp = os.path.join(labels_dir, os.path.splitext(pf)[0] + '.txt')
                preview = {"filename": pf, "annotations": parse_label_file(lp)}
            datasets.append({
                "name": entry,
                "total_images": len(img_files),
                "preview": preview,
                "classes": load_data_yaml(yaml_path)
            })
    except Exception as e:
        print(f"Error listing datasets: {e}")
    return datasets


@app.get("/api/dataset/{dataset_name}")
def get_dataset_details(dataset_name: str):
    dataset_path = safe_dataset_path(dataset_name)
    images_dir = os.path.join(dataset_path, 'images')
    labels_dir = os.path.join(dataset_path, 'labels')
    yaml_path  = os.path.join(dataset_path, 'data.yaml')
    yaml_data  = load_data_yaml(yaml_path)
    images_list = []
    if os.path.exists(images_dir):
        try:
            for f in sorted(os.listdir(images_dir)):
                name, ext = os.path.splitext(f)
                if ext.lower() in {'.jpg', '.jpeg', '.png', '.bmp', '.webp'}:
                    lp = os.path.join(labels_dir, name + '.txt')
                    images_list.append({"filename": f, "annotations": parse_label_file(lp)})
        except Exception as e:
            print(f"Error loading images: {e}")
    return {"classes": yaml_data, "images": images_list}


@app.get("/api/dataset/{dataset_name}/annotate")
def get_annotate_details(dataset_name: str):
    """Return images in the annotate staging folder."""
    dataset_path = safe_dataset_path(dataset_name)
    ann_images_dir = os.path.join(dataset_path, 'annotate', 'images')
    ann_labels_dir = os.path.join(dataset_path, 'annotate', 'labels')
    yaml_path  = os.path.join(dataset_path, 'data.yaml')
    yaml_data  = load_data_yaml(yaml_path)
    images_list = []
    if os.path.exists(ann_images_dir):
        try:
            for f in sorted(os.listdir(ann_images_dir)):
                name, ext = os.path.splitext(f)
                if ext.lower() in {'.jpg', '.jpeg', '.png', '.bmp', '.webp'}:
                    lp = os.path.join(ann_labels_dir, name + '.txt')
                    images_list.append({"filename": f, "annotations": parse_label_file(lp)})
        except Exception as e:
            print(f"Error loading annotate images: {e}")
    return {"classes": yaml_data, "images": images_list}


class SaveLabelRequest(BaseModel):
    filename: str
    label: str

@app.post("/api/dataset/{dataset_name}/annotate/save-label")
def save_annotate_label(dataset_name: str, payload: SaveLabelRequest):
    """Save YOLO-format label file for an annotate/ image."""
    dataset_path = safe_dataset_path(dataset_name)
    ann_labels_dir = os.path.join(dataset_path, 'annotate', 'labels')
    os.makedirs(ann_labels_dir, exist_ok=True)
    # Security: only allow the filename portion, not a path
    safe_fn = os.path.basename(payload.filename)
    stem = os.path.splitext(safe_fn)[0]
    label_path = os.path.normpath(os.path.join(ann_labels_dir, stem + '.txt'))
    if not label_path.startswith(os.path.normpath(DATASET_DIR)):
        raise HTTPException(status_code=403, detail="Access denied")
    try:
        with open(label_path, 'w', encoding='utf-8') as f:
            f.write(payload.label)
        return {"success": True}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ─────────────────────────────────────────────
# Class settings API
# ─────────────────────────────────────────────

@app.post("/api/dataset/{dataset_name}/classes")
def update_classes(dataset_name: str, payload: ClassSettingsUpdate):
    dataset_path = safe_dataset_path(dataset_name)
    try:
        yaml_path = os.path.join(dataset_path, 'data.yaml')
        existing_data = {}
        if os.path.exists(yaml_path):
            try:
                with open(yaml_path, 'r', encoding='utf-8') as f:
                    existing_data = yaml.safe_load(f) or {}
            except Exception:
                pass
        existing_data['names'] = payload.names
        existing_data['color'] = payload.color
        with open(yaml_path, 'w', encoding='utf-8') as f:
            yaml.safe_dump(existing_data, f, default_flow_style=False, sort_keys=False)
        return {"success": True}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# ─────────────────────────────────────────────
# Delete images API
# ─────────────────────────────────────────────

@app.post("/api/dataset/{dataset_name}/delete")
def delete_images(dataset_name: str, payload: DeleteImagesRequest):
    dataset_path = safe_dataset_path(dataset_name)
    images_dir = os.path.join(dataset_path, 'images')
    labels_dir = os.path.join(dataset_path, 'labels')
    deleted = []
    errors  = []
    
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    
    for filename in payload.filenames:
        # Safety: no path traversal
        safe_fn = os.path.basename(filename)
        img_path   = os.path.join(images_dir, safe_fn)
        label_path = os.path.join(labels_dir, os.path.splitext(safe_fn)[0] + '.txt')
        try:
            if os.path.isfile(img_path):
                os.remove(img_path)
            if os.path.isfile(label_path):
                os.remove(label_path)
            cursor.execute("DELETE FROM image_tags WHERE dataset_name = ? AND image_filename = ?;", (dataset_name, safe_fn))
            deleted.append(safe_fn)
        except Exception as e:
            errors.append({"file": safe_fn, "error": str(e)})
            
    conn.commit()
    conn.close()
    return {"deleted": deleted, "errors": errors}

# ─────────────────────────────────────────────
# Rename image API
# ─────────────────────────────────────────────

@app.post("/api/dataset/{dataset_name}/rename")
def rename_image(dataset_name: str, payload: RenameImageRequest):
    dataset_path = safe_dataset_path(dataset_name)
    images_dir = os.path.join(dataset_path, 'images')
    labels_dir = os.path.join(dataset_path, 'labels')
    old_fn = os.path.basename(payload.old_filename)
    new_fn = os.path.basename(payload.new_filename)
    # Preserve extension
    old_ext = os.path.splitext(old_fn)[1]
    new_base, new_ext = os.path.splitext(new_fn)
    if not new_ext:
        new_fn = new_base + old_ext
    try:
        old_img = os.path.join(images_dir, old_fn)
        new_img = os.path.join(images_dir, new_fn)
        if not os.path.isfile(old_img):
            raise HTTPException(status_code=404, detail="Original image not found")
        if os.path.isfile(new_img):
            raise HTTPException(status_code=409, detail="Target filename already exists")
        os.rename(old_img, new_img)
        old_lbl = os.path.join(labels_dir, os.path.splitext(old_fn)[0] + '.txt')
        new_lbl = os.path.join(labels_dir, os.path.splitext(new_fn)[0] + '.txt')
        if os.path.isfile(old_lbl):
            os.rename(old_lbl, new_lbl)
            
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        cursor.execute("UPDATE image_tags SET image_filename = ? WHERE dataset_name = ? AND image_filename = ?;", (new_fn, dataset_name, old_fn))
        conn.commit()
        conn.close()
        
        return {"success": True, "new_filename": new_fn}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# ─────────────────────────────────────────────
# Move to annotate staging API
# ─────────────────────────────────────────────

@app.post("/api/dataset/{dataset_name}/annotate")
def move_to_annotate(dataset_name: str, payload: AnnotateMoveRequest):
    dataset_path = safe_dataset_path(dataset_name)
    images_dir     = os.path.join(dataset_path, 'images')
    labels_dir     = os.path.join(dataset_path, 'labels')
    ann_images_dir = os.path.join(dataset_path, 'annotate', 'images')
    ann_labels_dir = os.path.join(dataset_path, 'annotate', 'labels')
    os.makedirs(ann_images_dir, exist_ok=True)
    os.makedirs(ann_labels_dir, exist_ok=True)
    moved  = []
    errors = []
    for filename in payload.filenames:
        safe_fn = os.path.basename(filename)
        src_img   = os.path.join(images_dir, safe_fn)
        src_lbl   = os.path.join(labels_dir, os.path.splitext(safe_fn)[0] + '.txt')
        dst_img   = os.path.join(ann_images_dir, safe_fn)
        dst_lbl   = os.path.join(ann_labels_dir, os.path.splitext(safe_fn)[0] + '.txt')
        try:
            if os.path.isfile(src_img):
                shutil.move(src_img, dst_img)
            if os.path.isfile(src_lbl):
                shutil.move(src_lbl, dst_lbl)
            moved.append(safe_fn)
        except Exception as e:
            errors.append({"file": safe_fn, "error": str(e)})
    return {"moved": moved, "errors": errors}


# ─────────────────────────────────────────────
# Scan for Bounding Box labels API
# ─────────────────────────────────────────────

@app.post("/api/dataset/{dataset_name}/scan-bbox")
def scan_dataset_for_bbox(dataset_name: str):
    dataset_path = safe_dataset_path(dataset_name)
    images_dir = os.path.join(dataset_path, 'images')
    labels_dir = os.path.join(dataset_path, 'labels')
    
    bbox_files = []
    
    if os.path.exists(labels_dir):
        image_extensions = {'.jpg', '.jpeg', '.png', '.bmp', '.webp'}
        image_files = {}
        if os.path.exists(images_dir):
            for f in os.listdir(images_dir):
                stem, ext = os.path.splitext(f)
                if ext.lower() in image_extensions:
                    image_files[stem] = f
        
        for f in os.listdir(labels_dir):
            if f.lower().endswith('.txt'):
                label_path = os.path.join(labels_dir, f)
                stem = os.path.splitext(f)[0]
                if stem not in image_files:
                    continue
                
                has_bbox = False
                try:
                    with open(label_path, 'r', encoding='utf-8') as lf:
                        for line in lf:
                            line = line.strip()
                            if not line:
                                continue
                            parts = line.split()
                            if len(parts) == 5:
                                try:
                                    int(parts[0])
                                    for val in parts[1:]:
                                        float(val)
                                    has_bbox = True
                                    break
                                except ValueError:
                                    pass
                except Exception as e:
                    print(f"Error reading label file {label_path}: {e}")
                
                if has_bbox:
                    bbox_files.append(image_files[stem])
                    
    return {"count": len(bbox_files), "bbox_files": bbox_files}


# ─────────────────────────────────────────────
# Batch rename images API
# ─────────────────────────────────────────────

@app.post("/api/dataset/{dataset_name}/rename-batch")
def rename_images_batch(dataset_name: str, payload: BatchRenameRequest):
    dataset_path = safe_dataset_path(dataset_name)
    images_dir = os.path.join(dataset_path, 'images')
    labels_dir = os.path.join(dataset_path, 'labels')
    base       = os.path.basename(payload.base_name)
    renamed    = []
    errors     = []
    
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    
    for idx, old_fn in enumerate(payload.filenames):
        safe_fn    = os.path.basename(old_fn)
        old_base, old_ext = os.path.splitext(safe_fn)
        if payload.mode == "prefix":
            new_fn = f"{base}_{idx}_{old_base}{old_ext}"
        else:
            new_fn = f"{base}_{idx}{old_ext}"
        old_img    = os.path.join(images_dir, safe_fn)
        new_img    = os.path.join(images_dir, new_fn)
        old_lbl    = os.path.join(labels_dir, old_base + '.txt')
        new_lbl    = os.path.join(labels_dir, os.path.splitext(new_fn)[0] + '.txt')
        try:
            if os.path.isfile(old_img):
                os.rename(old_img, new_img)
            if os.path.isfile(old_lbl):
                os.rename(old_lbl, new_lbl)
                
            cursor.execute("UPDATE image_tags SET image_filename = ? WHERE dataset_name = ? AND image_filename = ?;", (new_fn, dataset_name, safe_fn))
            renamed.append({'old': safe_fn, 'new': new_fn})
        except Exception as e:
            errors.append({'file': safe_fn, 'error': str(e)})
            
    conn.commit()
    conn.close()
    return {'renamed': renamed, 'errors': errors}


# ─────────────────────────────────────────────
# Tags and Class Management API (SQLite / Files)
# ─────────────────────────────────────────────

@app.get("/api/tags")
def list_tags():
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute("SELECT name FROM tags ORDER BY name;")
    tags = [row[0] for row in cursor.fetchall()]
    
    cursor.execute("SELECT tag_name, COUNT(*) FROM image_tags GROUP BY tag_name;")
    counts = {row[0]: row[1] for row in cursor.fetchall()}
    conn.close()
    
    return [{"name": t, "count": counts.get(t, 0)} for t in tags]

@app.post("/api/tags")
def create_tag(payload: TagCreate):
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Tag name cannot be empty")
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    try:
        cursor.execute("INSERT INTO tags (name) VALUES (?);", (name,))
        conn.commit()
    except sqlite3.IntegrityError:
        raise HTTPException(status_code=409, detail=f"Tag '{name}' already exists")
    finally:
        conn.close()
    return {"success": True}

@app.delete("/api/tags/{tag_name:path}")
def delete_tag(tag_name: str):
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute("DELETE FROM image_tags WHERE tag_name = ?;", (tag_name,))
    cursor.execute("DELETE FROM tags WHERE name = ?;", (tag_name,))
    conn.commit()
    conn.close()
    return {"success": True}

@app.get("/api/dataset/{dataset_name}/tags")
def get_dataset_tags(dataset_name: str):
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute("SELECT image_filename, tag_name FROM image_tags WHERE dataset_name = ?;", (dataset_name,))
    rows = cursor.fetchall()
    conn.close()
    
    mapping = {}
    for img_fn, tag in rows:
        if img_fn not in mapping:
            mapping[img_fn] = []
        mapping[img_fn].append(tag)
    return mapping

@app.post("/api/dataset/{dataset_name}/image-tags")
def update_image_tags(dataset_name: str, payload: ImageTagsUpdate):
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    try:
        for fn in payload.filenames:
            cursor.execute("DELETE FROM image_tags WHERE dataset_name = ? AND image_filename = ?;", (dataset_name, fn))
            for tag in payload.tags:
                cursor.execute("INSERT OR IGNORE INTO image_tags (dataset_name, image_filename, tag_name) VALUES (?, ?, ?);", (dataset_name, fn, tag))
        conn.commit()
    except Exception as e:
        conn.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        conn.close()
    return {"success": True}

@app.get("/api/dataset/{dataset_name}/image-tags/{filename:path}")
def get_image_tags(dataset_name: str, filename: str):
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute("SELECT tag_name FROM image_tags WHERE dataset_name = ? AND image_filename = ?;", (dataset_name, filename))
    rows = cursor.fetchall()
    conn.close()
    tags = [r[0] for r in rows]
    return {"tags": tags}

@app.get("/api/dataset/{dataset_name}/class-annotations-count/{class_id}")
def get_class_annotations_count(dataset_name: str, class_id: int):
    dataset_path = safe_dataset_path(dataset_name)
    label_dirs = [
        os.path.join(dataset_path, 'labels'),
        os.path.join(dataset_path, 'annotate', 'labels')
    ]
    count = 0
    for l_dir in label_dirs:
        if os.path.exists(l_dir):
            for f in os.listdir(l_dir):
                if f.lower().endswith('.txt'):
                    try:
                        with open(os.path.join(l_dir, f), 'r', encoding='utf-8') as file:
                            for line in file:
                                line = line.strip()
                                if not line:
                                    continue
                                parts = line.split()
                                if int(parts[0]) == class_id:
                                    count += 1
                    except Exception:
                        pass
    return {"count": count}

class_delete_progress = {}

def perform_class_deletion(dataset_name: str, class_id: int):
    progress_key = f"{dataset_name}_{class_id}"
    class_delete_progress[progress_key] = 0.0
    try:
        dataset_path = safe_dataset_path(dataset_name)
        label_dirs = [
            os.path.join(dataset_path, 'labels'),
            os.path.join(dataset_path, 'annotate', 'labels')
        ]
        
        txt_files = []
        for l_dir in label_dirs:
            if os.path.exists(l_dir):
                for f in os.listdir(l_dir):
                    if f.lower().endswith('.txt'):
                        txt_files.append(os.path.join(l_dir, f))
                        
        total_files = len(txt_files)
        if total_files > 0:
            for idx, filepath in enumerate(txt_files):
                updated_lines = []
                changed = False
                with open(filepath, 'r', encoding='utf-8') as f:
                    for line in f:
                        line = line.strip()
                        if not line:
                            continue
                        parts = line.split()
                        try:
                            cid = int(parts[0])
                            if cid == class_id:
                                changed = True
                                continue
                            elif cid > class_id:
                                parts[0] = str(cid - 1)
                                changed = True
                            updated_lines.append(" ".join(parts))
                        except Exception:
                            updated_lines.append(line)
                
                if changed:
                    with open(filepath, 'w', encoding='utf-8') as f:
                        f.write("\n".join(updated_lines) + ("\n" if updated_lines else ""))
                
                class_delete_progress[progress_key] = round(((idx + 1) / total_files) * 100.0, 1)
        
        # Update data.yaml
        yaml_path = os.path.join(dataset_path, 'data.yaml')
        if os.path.exists(yaml_path):
            with open(yaml_path, 'r', encoding='utf-8') as f:
                data = yaml.safe_load(f) or {}
            names = data.get('names', [])
            colors = data.get('color', [])
            
            if 0 <= class_id < len(names):
                names.pop(class_id)
            if 0 <= class_id < len(colors):
                colors.pop(class_id)
                
            data['names'] = names
            data['color'] = colors
            with open(yaml_path, 'w', encoding='utf-8') as f:
                yaml.safe_dump(data, f, default_flow_style=False, sort_keys=False)
                
        class_delete_progress[progress_key] = 100.0
    except Exception as e:
        print(f"Error deleting class: {e}")
        class_delete_progress[progress_key] = -1.0

@app.post("/api/dataset/{dataset_name}/delete-class/{class_id}")
def start_delete_class(dataset_name: str, class_id: int):
    safe_dataset_path(dataset_name)
    t = threading.Thread(target=perform_class_deletion, args=(dataset_name, class_id))
    t.start()
    return {"success": True}

@app.get("/api/dataset/{dataset_name}/delete-class-progress/{class_id}")
def get_delete_class_progress(dataset_name: str, class_id: int):
    progress_key = f"{dataset_name}_{class_id}"
    progress = class_delete_progress.get(progress_key, 0.0)
    return {"progress": progress}


# ─────────────────────────────────────────────
# LLM Settings
# ─────────────────────────────────────────────

@app.get("/api/llm-settings")
def get_llm_settings():
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute("SELECT api_url, api_key, model, dataset_type, autosave, auto_layering FROM llm_settings WHERE id = 1;")
    row = cursor.fetchone()
    conn.close()
    if row:
        return {
            "api_url": row[0],
            "api_key": row[1],
            "model": row[2],
            "dataset_type": row[3],
            "autosave": bool(row[4]) if row[4] is not None else False,
            "auto_layering": bool(row[5]) if row[5] is not None else False
        }
    return {"api_url": "http://127.0.0.1:1234", "api_key": "", "model": "", "dataset_type": "object_detection", "autosave": False, "auto_layering": False}

@app.post("/api/llm-settings")
def save_llm_settings(settings: LLMSettings):
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute("""
        INSERT OR REPLACE INTO llm_settings (id, api_url, api_key, model, dataset_type, autosave, auto_layering)
        VALUES (1, ?, ?, ?, ?, ?, ?);
    """, (settings.api_url, settings.api_key, settings.model, settings.dataset_type, int(settings.autosave), int(settings.auto_layering)))
    conn.commit()
    conn.close()
    return {"success": True}

@app.get("/api/dataset/{dataset_name}/check-segment")
def check_segment_dataset(dataset_name: str, type: Optional[str] = None):
    """Scan dataset for images that have annotations mismatched with the dataset category."""
    if type:
        dataset_type = type
    else:
        cfg = _load_llm_settings_dict()
        dataset_type = cfg.get("dataset_type", "object_detection")
    
    dataset_path = safe_dataset_path(dataset_name)
    images_dir = os.path.join(dataset_path, 'images')
    labels_dir = os.path.join(dataset_path, 'labels')
    
    mismatched_images = []
    if os.path.exists(images_dir):
        for f in sorted(os.listdir(images_dir)):
            name, ext = os.path.splitext(f)
            if ext.lower() in {'.jpg', '.jpeg', '.png', '.bmp', '.webp'}:
                label_path = os.path.join(labels_dir, name + '.txt')
                if os.path.exists(label_path):
                    has_mismatch = False
                    try:
                        annotations = parse_label_file(label_path)
                        for ann in annotations:
                            points_count = len(ann.get("points", []))
                            if dataset_type == "segment":
                                # Finding bounding box (exactly 2 points) in a segment dataset is a mismatch
                                if points_count == 2:
                                    has_mismatch = True
                                    break
                            else:
                                # Finding segment/polygon (more than 2 points) in a BB dataset is a mismatch
                                if points_count > 2:
                                    has_mismatch = True
                                    break
                    except Exception as e:
                        print(f"Error parsing label {label_path}: {e}")
                    
                    if has_mismatch:
                        mismatched_images.append(f)
                        
    return {
        "count": len(mismatched_images), 
        "images": mismatched_images, 
        "dataset_type": dataset_type
    }

@app.post("/api/dataset/{dataset_name}/move-to-annotate")
def move_images_to_annotate(dataset_name: str, payload: MoveImagesRequest):
    """Move specified images and their labels to the annotate staging folder."""
    dataset_path = safe_dataset_path(dataset_name)
    src_images_dir = os.path.join(dataset_path, 'images')
    src_labels_dir = os.path.join(dataset_path, 'labels')
    dest_images_dir = os.path.join(dataset_path, 'annotate', 'images')
    dest_labels_dir = os.path.join(dataset_path, 'annotate', 'labels')
    
    os.makedirs(dest_images_dir, exist_ok=True)
    os.makedirs(dest_labels_dir, exist_ok=True)
    
    moved = []
    errors = []
    
    for f in payload.filenames:
        name, ext = os.path.splitext(f)
        src_img = os.path.join(src_images_dir, f)
        dest_img = os.path.join(dest_images_dir, f)
        src_lbl = os.path.join(src_labels_dir, name + '.txt')
        dest_lbl = os.path.join(dest_labels_dir, name + '.txt')
        
        try:
            if os.path.exists(src_img):
                shutil.move(src_img, dest_img)
            if os.path.exists(src_lbl):
                shutil.move(src_lbl, dest_lbl)
            moved.append(f)
        except Exception as e:
            errors.append({"filename": f, "error": str(e)})
            
    return {"moved": moved, "errors": errors}

# ─────────────────────────────────────────────
# SAM 3.1 Magic Selection
# ─────────────────────────────────────────────

class SamPredictRequest(BaseModel):
    filename: str
    points: list   # [{"x": float, "y": float, "label": int}, ...]  label=1 positive, label=0 negative
    model: Optional[str] = 'sam3'
    device: Optional[str] = 'cuda:0'
    imgsz: Optional[int] = 1024

# Lazy singleton models – loaded once, reused across requests
_sam_models = {}
_sam_model_lock = threading.Lock()

_sam_predictors = {}
_sam_predictor_lock = threading.Lock()
_sam_inference_lock = threading.Lock()

_yolo_models = {}
_yolo_model_lock = threading.Lock()

def _get_yolo_model(model_name, model_path, device):
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

def _download_model_file(url: str, output_path: str):
    import httpx
    print(f"Downloading model from {url} to {output_path}...")
    try:
        with httpx.stream("GET", url, follow_redirects=True, timeout=60.0) as r:
            if r.status_code != 200:
                raise Exception(f"HTTP error {r.status_code}")
            with open(output_path, "wb") as f:
                for chunk in r.iter_bytes(chunk_size=1024 * 1024):
                    if chunk:
                        f.write(chunk)
    except Exception as e:
        if os.path.exists(output_path):
            try:
                os.remove(output_path)
            except Exception:
                pass
        raise HTTPException(status_code=500, detail=f"Failed to download model weights: {str(e)}")

def _get_sam_model(model_name='sam3'):
    global _sam_models
    if model_name not in _sam_models:
        with _sam_model_lock:
            if model_name not in _sam_models:
                model_file = f"{model_name}.pt"
                model_path = os.path.join(BASE_DIR, model_file)
                if not os.path.exists(model_path):
                    if model_name == 'sam2.1_l':
                        url = "https://github.com/ultralytics/assets/releases/download/v8.3.0/sam2.1_l.pt"
                        _download_model_file(url, model_path)
                    else:
                        raise HTTPException(status_code=503, detail=f"{model_file} not found")
                from ultralytics import SAM
                _sam_models[model_name] = SAM(model_path)
    return _sam_models[model_name]

def _get_sam_predictor(model_name, model_path):
    global _sam_predictors
    if model_name not in _sam_predictors:
        with _sam_predictor_lock:
            if model_name not in _sam_predictors:
                from ultralytics.models.sam import SAM3SemanticPredictor
                overrides = dict(
                    conf=0.5,
                    task="segment",
                    mode="predict",
                    model=model_path,
                    save=False,
                    device="cuda",
                    half=False
                )
                _sam_predictors[model_name] = SAM3SemanticPredictor(overrides=overrides)
    return _sam_predictors[model_name]



@app.post("/api/dataset/{dataset_name}/sam-predict")
def sam_predict(dataset_name: str, payload: SamPredictRequest):
    """Run SAM point-to-segment on a single image and return normalized polygon points."""
    dataset_path = safe_dataset_path(dataset_name)

    # Resolve image path (annotate/images first, then images)
    image_path = None
    for subdir in [os.path.join("annotate", "images"), "images"]:
        candidate = os.path.normpath(os.path.join(dataset_path, subdir, payload.filename))
        if candidate.startswith(os.path.normpath(DATASET_DIR)) and os.path.isfile(candidate):
            image_path = candidate
            break

    if not image_path:
        raise HTTPException(status_code=404, detail="Image not found")

    if not payload.points:
        raise HTTPException(status_code=400, detail="At least one point required")

    try:
        import cv2
        import numpy as np

        model_name = payload.model if payload.model in ('sam3', 'sam2.1_l') else 'sam3'
        model = _get_sam_model(model_name)

        # Read image to get dimensions
        img = cv2.imread(image_path)
        if img is None:
            raise HTTPException(status_code=500, detail="Cannot read image")
        h, w = img.shape[:2]

        # Build point arrays (pixel coords)
        pt_coords = [[int(p["x"] * w), int(p["y"] * h)] for p in payload.points]
        pt_labels = [int(p["label"]) for p in payload.points]

        results = model(
            image_path, 
            points=[pt_coords], 
            labels=[pt_labels], 
            device=payload.device if payload.device else "cuda:0", 
            imgsz=payload.imgsz if (payload.imgsz and payload.imgsz > 0) else max(h, w),
            verbose=False
        )

        if not results or results[0].masks is None or len(results[0].masks) == 0:
            return {"success": False, "error": "No mask generated", "polygons": []}

        # Pick the mask with highest confidence
        masks_data = results[0].masks.data.cpu().numpy()  # shape (N, H, W)
        confs = results[0].boxes.conf.cpu().numpy() if results[0].boxes is not None and results[0].boxes.conf is not None else [1.0] * len(masks_data)
        best_idx = int(np.argmax(confs))
        mask = masks_data[best_idx].astype(np.uint8)

        # Resize mask to original image dimensions if needed
        if mask.shape[0] != h or mask.shape[1] != w:
            mask = cv2.resize(mask, (w, h), interpolation=cv2.INTER_NEAREST)

        # Find contours → polygon
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not contours:
            return {"success": False, "error": "No contour found", "polygons": []}

        # Use largest contour
        largest = max(contours, key=cv2.contourArea)

        # Normalize to [0,1]
        polygon = [[float(pt[0][0]) / w, float(pt[0][1]) / h] for pt in largest]

        if len(polygon) < 3:
            return {"success": False, "error": "Polygon too small", "polygons": []}

        return {"success": True, "polygons": [polygon]}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"SAM error: {str(e)}")


# ── Auto Annotate Settings & Endpoint ──

@app.get("/api/dataset/{dataset_name}/auto-annotate-settings")
def get_auto_annotate_settings(dataset_name: str):
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute("SELECT model, prompts, on_approved_tags, conf, iou, device, recheck, recheck_model, recheck_device, recheck_min_area, recheck_max_area, recheck_imgsz, magic_model, magic_device, magic_imgsz, yolo_entries FROM auto_annotate_settings WHERE dataset_name = ?;", (dataset_name,))
    row = cursor.fetchone()
    conn.close()
    if row:
        return {
            "model": row[0],
            "prompts": json.loads(row[1]),
            "on_approved_tags": json.loads(row[2]),
            "conf": row[3] if row[3] is not None else 0.25,
            "iou": row[4] if row[4] is not None else 0.85,
            "device": row[5] if row[5] is not None else 'cuda:0',
            "recheck": bool(row[6]) if row[6] is not None else False,
            "recheck_model": row[7] if row[7] is not None else 'sam3',
            "recheck_device": row[8] if row[8] is not None else 'cuda:0',
            "recheck_min_area": row[9] if row[9] is not None else 0.70,
            "recheck_max_area": row[10] if row[10] is not None else 1.20,
            "recheck_imgsz": row[11] if row[11] is not None else 1024,
            "magic_model": row[12] if row[12] is not None else 'sam3',
            "magic_device": row[13] if row[13] is not None else 'cuda:0',
            "magic_imgsz": row[14] if row[14] is not None else 1024,
            "yolo_entries": json.loads(row[15]) if (len(row) > 15 and row[15] is not None) else []
        }
    return {"model": "sam3.1", "prompts": [], "on_approved_tags": [], "conf": 0.25, "iou": 0.85, "device": 'cuda:0', "recheck": False, "recheck_model": 'sam3', "recheck_device": 'cuda:0', "recheck_min_area": 0.70, "recheck_max_area": 1.20, "recheck_imgsz": 1024, "magic_model": "sam3", "magic_device": "cuda:0", "magic_imgsz": 1024, "yolo_entries": []}


@app.post("/api/dataset/{dataset_name}/auto-annotate-settings")
def save_auto_annotate_settings(dataset_name: str, payload: AutoAnnotateSettingsUpdate):
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute("""
        INSERT INTO auto_annotate_settings (dataset_name, model, prompts, on_approved_tags, conf, iou, device, recheck, recheck_model, recheck_device, recheck_min_area, recheck_max_area, recheck_imgsz, magic_model, magic_device, magic_imgsz, yolo_entries)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(dataset_name) DO UPDATE SET 
            model=excluded.model, 
            prompts=excluded.prompts, 
            on_approved_tags=excluded.on_approved_tags,
            conf=excluded.conf,
            iou=excluded.iou,
            device=excluded.device,
            recheck=excluded.recheck,
            recheck_model=excluded.recheck_model,
            recheck_device=excluded.recheck_device,
            recheck_min_area=excluded.recheck_min_area,
            recheck_max_area=excluded.recheck_max_area,
            recheck_imgsz=excluded.recheck_imgsz,
            magic_model=excluded.magic_model,
            magic_device=excluded.magic_device,
            magic_imgsz=excluded.magic_imgsz,
            yolo_entries=excluded.yolo_entries;
    """, (dataset_name, payload.model, json.dumps(payload.prompts), json.dumps(payload.on_approved_tags), payload.conf, payload.iou, payload.device, int(payload.recheck), payload.recheck_model, payload.recheck_device, payload.recheck_min_area, payload.recheck_max_area, payload.recheck_imgsz, payload.magic_model, payload.magic_device, payload.magic_imgsz, json.dumps(payload.yolo_entries)))
    conn.commit()
    conn.close()
    return {"success": True}


def _polygon_iou(poly_a, poly_b):
    """Approximate IoU between two normalized polygons using pixel rasterization."""
    import numpy as np
    SIZE = 256
    import cv2
    def _raster(poly):
        pts = np.array([[int(p[0]*SIZE), int(p[1]*SIZE)] for p in poly], dtype=np.int32)
        mask = np.zeros((SIZE, SIZE), dtype=np.uint8)
        cv2.fillPoly(mask, [pts], 1)
        return mask
    ma, mb = _raster(poly_a), _raster(poly_b)
    inter = np.sum(ma & mb)
    union = np.sum(ma | mb)
    return float(inter) / max(float(union), 1.0)


@app.post("/api/dataset/{dataset_name}/sam-auto-annotate")
def sam_auto_annotate(dataset_name: str, payload: SamAutoAnnotateRequest):
    """Run SAM auto annotation with text prompts on a single image."""
    dataset_path = safe_dataset_path(dataset_name)

    # Resolve image path
    image_path = None
    for subdir in [os.path.join("annotate", "images"), "images"]:
        candidate = os.path.normpath(os.path.join(dataset_path, subdir, payload.filename))
        if candidate.startswith(os.path.normpath(DATASET_DIR)) and os.path.isfile(candidate):
            image_path = candidate
            break
    if not image_path:
        raise HTTPException(status_code=404, detail="Image not found")

    if not payload.prompts:
        raise HTTPException(status_code=400, detail="At least one prompt required")

    try:
        import cv2
        import numpy as np

        model_name = payload.model if payload.model in ('sam3', 'sam3.1') else 'sam3.1'
        model_file = f"{model_name}.pt"
        model_path = os.path.join(BASE_DIR, model_file)
        if not os.path.exists(model_path):
            raise HTTPException(status_code=503, detail=f"{model_file} not found")

        # Read image for dimensions
        img = cv2.imread(image_path)
        if img is None:
            raise HTTPException(status_code=500, detail="Cannot read image")
        h, w = img.shape[:2]

        # Group prompts by text
        text_prompts = [p["prompt"] for p in payload.prompts]
        class_map = {p["prompt"]: p["class_id"] for p in payload.prompts}

        # Resolve device for pass 1
        p1_device = payload.device if payload.device else 'cuda:0'

        # Setup SAM3 Semantic Predictor from cache
        predictor = _get_sam_predictor(model_name, model_path)
        with _sam_inference_lock:
            predictor.set_image(image_path)
            results = predictor(text=text_prompts, device=p1_device)

        if not results or len(results) == 0:
            return {"success": False, "error": "No results from SAM", "annotations": []}

        # Load existing annotations from disk to pre-seed IoU dedup
        # This ensures masks that overlap with already-saved annotations are rejected
        # BEFORE entering the expensive pass-2 recheck, not after.
        label_path = None
        for subdir in [os.path.join("annotate", "labels"), "labels"]:
            lp = os.path.normpath(os.path.join(dataset_path, subdir,
                 os.path.splitext(payload.filename)[0] + ".txt"))
            if lp.startswith(os.path.normpath(DATASET_DIR)) and os.path.isfile(lp):
                label_path = lp
                break
        existing_annotations = parse_label_file(label_path) if label_path else []
        # annotations list starts with existing ones so new masks can dedup against them
        # but we keep track of which index is the first "new" annotation
        annotations = list(existing_annotations)
        result = results[0]

        if result.masks is None or len(result.masks) == 0:
            return {"success": False, "error": "No masks generated", "annotations": []}

        masks_data = result.masks.data.cpu().numpy()
        # cls assignments from result (semantic labels per mask)
        cls_data = result.boxes.cls.cpu().numpy() if result.boxes is not None and result.boxes.cls is not None else None
        confs = result.boxes.conf.cpu().numpy() if (result.boxes is not None and result.boxes.conf is not None) else None
        print(f"[AutoAnnotate] Pass 1: {len(masks_data)} masks from SAM, {len(existing_annotations)} existing annotations loaded for IoU dedup")

        sam_model = None
        if payload.recheck:
            try:
                recheck_model_name = payload.recheck_model if payload.recheck_model in ('sam3', 'sam2.1_l') else 'sam3'
                sam_model = _get_sam_model(recheck_model_name)
            except Exception as e:
                print(f"Failed to load SAM model '{payload.recheck_model}' for recheck: {e}")

        for mi in range(len(masks_data)):
            # 1. Check confidence
            if confs is not None and mi < len(confs):
                conf_val = float(confs[mi])
                if conf_val < (payload.conf or 0.25):
                    continue

            mask = masks_data[mi].astype(np.uint8)
            if mask.shape[0] != h or mask.shape[1] != w:
                mask = cv2.resize(mask, (w, h), interpolation=cv2.INTER_NEAREST)

            contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            if not contours:
                continue

            largest = max(contours, key=cv2.contourArea)
            orig_polygon = [[float(pt[0][0]) / w, float(pt[0][1]) / h] for pt in largest]
            if len(orig_polygon) < 3:
                continue

            # Determine class_id from semantic label index
            if cls_data is not None and mi < len(cls_data):
                sem_idx = int(cls_data[mi])
                if sem_idx < len(text_prompts):
                    prompt_text = text_prompts[sem_idx]
                    class_id = class_map.get(prompt_text, 0)
                else:
                    class_id = 0
            else:
                class_id = payload.prompts[0]["class_id"] if payload.prompts else 0

            # 2. Check IoU against already-accepted annotations (dedup) before Pass 2
            is_dup = False
            iou_thresh = payload.iou if payload.iou is not None else 0.85
            for existing in annotations:
                iou_val = _polygon_iou(orig_polygon, existing["points"])
                if iou_val > iou_thresh:
                    is_dup = True
                    break
            if is_dup:
                continue

            # --- PASS 2: RECHECK (POINT PROMPT FROM CENTROID) ---
            polygon = None
            if payload.recheck and sam_model is not None:
                M = cv2.moments(largest)
                if M["m00"] != 0:
                    cX = int(M["m10"] / M["m00"])
                    cY = int(M["m01"] / M["m00"])
                    try:
                        with _sam_inference_lock:
                            sam_results = sam_model(
                                image_path,
                                points=[[cX, cY]],
                                labels=[1],
                                device=payload.recheck_device if payload.recheck_device else 'cuda:0',
                                imgsz=payload.recheck_imgsz if (payload.recheck_imgsz and payload.recheck_imgsz > 0) else max(h, w),
                                verbose=False
                            )
                        if sam_results and sam_results[0].masks is not None and len(sam_results[0].masks) > 0:
                            s_masks_data = sam_results[0].masks.data.cpu().numpy()
                            s_confs = sam_results[0].boxes.conf.cpu().numpy() if sam_results[0].boxes is not None and sam_results[0].boxes.conf is not None else [1.0] * len(s_masks_data)
                            s_best_idx = int(np.argmax(s_confs))
                            s_mask = s_masks_data[s_best_idx].astype(np.uint8)

                            # --- Compare Area Ratios ---
                            orig_area = float(np.sum(mask > 0))
                            s_area = float(np.sum(s_mask > 0))
                            if orig_area > 0:
                                ratio = s_area / orig_area
                                min_limit = payload.recheck_min_area if payload.recheck_min_area is not None else 0.70
                                max_limit = payload.recheck_max_area if payload.recheck_max_area is not None else 1.20
                                if min_limit <= ratio <= max_limit:
                                    if s_mask.shape[0] != h or s_mask.shape[1] != w:
                                        s_mask = cv2.resize(s_mask, (w, h), interpolation=cv2.INTER_NEAREST)
                                    s_contours, _ = cv2.findContours(s_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
                                    if s_contours:
                                        s_largest = max(s_contours, key=cv2.contourArea)
                                        polygon = [[float(pt[0][0]) / w, float(pt[0][1]) / h] for pt in s_largest]
                                else:
                                    print(f"SAM recheck index {mi}: Size ratio {ratio:.2f} outside [{min_limit:.2f}, {max_limit:.2f}], fallback to pass 1")

                    except Exception as e:
                        print(f"SAM recheck error on index {mi}: {e}")

            if polygon is None:
                polygon = orig_polygon

            if len(polygon) < 3:
                continue

            annotations.append({
                "class_id": class_id,
                "points": polygon,
                "type": "polygon"
            })

        new_annotations = annotations[len(existing_annotations):]
        return {"success": True, "annotations": new_annotations}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"SAM auto-annotate error: {str(e)}")



@app.get("/api/yolo-model-names")
def get_yolo_model_names(model: str):
    model_file = f"{model}.pt"
    model_path = os.path.join(BASE_DIR, model_file)
    if not os.path.exists(model_path):
        # Fallback to yolo11n.pt
        model_path = 'yolo11n.pt'
    try:
        yolo = _get_yolo_model(model, model_path, device='cpu')
        names = [yolo.names[i] for i in sorted(yolo.names.keys())]
        return {"success": True, "names": names}
    except Exception as e:
        return {"success": False, "error": str(e)}

@app.post("/api/dataset/{dataset_name}/yolo-detect")
def yolo_detect(dataset_name: str, payload: YoloDetectRequest):
    dataset_path = safe_dataset_path(dataset_name)
    image_path = None
    for subdir in [os.path.join("annotate", "images"), "images"]:
        candidate = os.path.normpath(os.path.join(dataset_path, subdir, payload.filename))
        if candidate.startswith(os.path.normpath(DATASET_DIR)) and os.path.isfile(candidate):
            image_path = candidate
            break
    if not image_path:
        raise HTTPException(status_code=404, detail="Image not found")

    try:
        model_name = payload.model if payload.model else 'yolov26x'
        model_file = f"{model_name}.pt"
        model_path = os.path.join(BASE_DIR, model_file)
        if not os.path.exists(model_path):
            model_path = 'yolo11n.pt'

        device = payload.device if payload.device else 'cuda:0'
        yolo = _get_yolo_model(model_name, model_path, device)
        results = yolo(image_path, conf=payload.conf, device=device)

        annotations = []
        if results and len(results) > 0:
            result = results[0]
            boxes = result.boxes
            if boxes is not None:
                pair_map = {p.yolo_class_id: p.ds_class_id for p in payload.pairs}
                h, w = result.orig_shape

                for box in boxes:
                    cls_id = int(box.cls[0].item())
                    if cls_id not in pair_map:
                        continue

                    xyxy = box.xyxy[0].cpu().numpy()
                    x1 = float(xyxy[0]) / w
                    y1 = float(xyxy[1]) / h
                    x2 = float(xyxy[2]) / w
                    y2 = float(xyxy[3]) / h

                    annotations.append({
                        "class_id": pair_map[cls_id],
                        "points": [[x1, y1], [x2, y2]],
                        "type": "bbox"
                    })
        return {"success": True, "annotations": annotations}
    except Exception as e:
        return {"success": False, "error": str(e)}


@app.get("/api/gpu/list")
def list_gpus():
    """List available CUDA GPUs."""
    try:
        import torch
        gpus = []
        if torch.cuda.is_available():
            for i in range(torch.cuda.device_count()):
                name = torch.cuda.get_device_name(i)
                mem_total = torch.cuda.get_device_properties(i).total_memory // (1024 ** 2)
                gpus.append({"id": f"cuda:{i}", "name": f"GPU {i}: {name} ({mem_total} MB)"})
        if not gpus:
            gpus.append({"id": "cpu", "name": "CPU (no CUDA)"})
        else:
            gpus.append({"id": "cpu", "name": "CPU"})
        return {"success": True, "gpus": gpus}
    except Exception as e:
        return {"success": False, "gpus": [{"id": "cpu", "name": "CPU"}], "error": str(e)}

@app.get("/api/sam/status")
def get_sam_status():
    global _sam_models, _sam_predictors, _yolo_models
    loaded_point = list(_sam_models.keys())
    loaded_auto = list(_sam_predictors.keys())
    loaded_yolo = [f"{k[0]} ({k[1]})" for k in _yolo_models.keys()]
    return {
        "success": True,
        "loaded_point_models": loaded_point,
        "loaded_auto_models": loaded_auto,
        "loaded_yolo_models": loaded_yolo
    }

@app.post("/api/sam/unload")
def unload_sam_models():
    global _sam_models, _sam_predictors, _yolo_models
    with _sam_model_lock:
        _sam_models.clear()
    with _sam_predictor_lock:
        _sam_predictors.clear()
    with _yolo_model_lock:
        _yolo_models.clear()
    import gc
    gc.collect()
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass
    return {"success": True, "message": "Models unloaded successfully"}


# ─────────────────────────────────────────────
# LLM Proxy (CORS transparent bridge)
# ─────────────────────────────────────────────

def _load_llm_settings_dict():
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute("SELECT api_url, api_key, model, dataset_type FROM llm_settings WHERE id = 1;")
    row = cursor.fetchone()
    conn.close()
    if row:
        return {
            "api_url": row[0],
            "api_key": row[1],
            "model": row[2],
            "dataset_type": row[3]
        }
    return {"api_url": "http://127.0.0.1:1234", "api_key": "", "model": "", "dataset_type": "object_detection"}

@app.get("/api/llm/models")
def proxy_llm_models():
    cfg = _load_llm_settings_dict()
    url = cfg.get("api_url", "http://127.0.0.1:1234").rstrip("/")
    headers = {"Content-Type": "application/json"}
    if cfg.get("api_key"):
        headers["Authorization"] = f"Bearer {cfg['api_key']}"
    try:
        r = httpx.get(f"{url}/v1/models", headers=headers, timeout=10)
        return r.json()
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))

@app.post("/api/llm/chat")
async def proxy_llm_chat(request: Request):
    cfg = _load_llm_settings_dict()
    url = cfg.get("api_url", "http://127.0.0.1:1234").rstrip("/")
    headers = {"Content-Type": "application/json"}
    if cfg.get("api_key"):
        headers["Authorization"] = f"Bearer {cfg['api_key']}"
    body = await request.body()

    async def stream_generator():
        async with httpx.AsyncClient(timeout=120) as client:
            async with client.stream("POST", f"{url}/v1/chat/completions",
                                     headers=headers, content=body) as resp:
                async for chunk in resp.aiter_bytes():
                    yield chunk

    return StreamingResponse(stream_generator(), media_type="text/event-stream")

@app.get("/api/dataset/{dataset_name}/image-base64/{filename:path}")
def get_image_base64(dataset_name: str, filename: str):
    dataset_path = safe_dataset_path(dataset_name)
    # check images dir first, then annotate/images
    for subdir in ['images', os.path.join('annotate', 'images')]:
        file_path = os.path.normpath(os.path.join(dataset_path, subdir, filename))
        if not file_path.startswith(os.path.normpath(DATASET_DIR)):
            raise HTTPException(status_code=403, detail="Access denied")
        if os.path.isfile(file_path):
            mime_type, _ = mimetypes.guess_type(file_path)
            mime_type = mime_type or "image/jpeg"
            with open(file_path, 'rb') as f:
                b64 = base64.b64encode(f.read()).decode('utf-8')
            return {"base64": b64, "mime_type": mime_type}
    raise HTTPException(status_code=404, detail="Image not found")


@app.post("/api/dataset/{dataset_name}/save-annotations")
def save_annotations(dataset_name: str, payload: SaveAnnotationsRequest):
    dataset_path = safe_dataset_path(dataset_name)
    filename = os.path.basename(payload.filename)
    
    label_dir = None
    if os.path.isfile(os.path.normpath(os.path.join(dataset_path, 'images', filename))):
        label_dir = os.path.join(dataset_path, 'labels')
    elif os.path.isfile(os.path.normpath(os.path.join(dataset_path, 'annotate', 'images', filename))):
        label_dir = os.path.join(dataset_path, 'annotate', 'labels')
        
    if not label_dir:
        raise HTTPException(status_code=404, detail="Image not found in dataset directories")
        
    os.makedirs(label_dir, exist_ok=True)
    label_filename = os.path.splitext(filename)[0] + '.txt'
    label_path = os.path.join(label_dir, label_filename)
    
    yaml_path = os.path.join(dataset_path, 'data.yaml')
    yaml_data = load_data_yaml(yaml_path)
    class_names = yaml_data.get('names', [])
    
    lines = []
    for ann in payload.annotations:
        cls_name = ann.get('class')
        x = ann.get('x')
        y = ann.get('y')
        if cls_name is None or x is None or y is None:
            continue
            
        try:
            class_id = class_names.index(cls_name)
        except ValueError:
            class_id = -1
            for idx, name in enumerate(class_names):
                if name.lower().strip() == cls_name.lower().strip():
                    class_id = idx
                    break
            if class_id == -1:
                continue
                
        lines.append(f"{class_id} {x:.6f} {y:.6f}")
        
    try:
        if lines:
            with open(label_path, 'w', encoding='utf-8') as f:
                f.write("\n".join(lines) + "\n")
        else:
            if os.path.exists(label_path):
                os.remove(label_path)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Gagal menulis file label: {e}")
        
    return {"success": True}


@app.get("/api/dataset/{dataset_name}/auto-preview")
def get_auto_preview(dataset_name: str, filename: str, detections: str):
    import cv2
    import numpy as np
    import io
    import json
    
    dataset_path = safe_dataset_path(dataset_name)
    
    file_path = None
    for subdir in ['images', os.path.join('annotate', 'images')]:
        temp_path = os.path.normpath(os.path.join(dataset_path, subdir, filename))
        if temp_path.startswith(os.path.normpath(DATASET_DIR)) and os.path.isfile(temp_path):
            file_path = temp_path
            break
            
    if not file_path:
        raise HTTPException(status_code=404, detail="Image not found")
        
    try:
        with open(file_path, "rb") as f:
            file_bytes = np.frombuffer(f.read(), dtype=np.uint8)
        img = cv2.imdecode(file_bytes, cv2.IMREAD_COLOR)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Gagal membaca gambar: {e}")
        
    if img is None:
        raise HTTPException(status_code=500, detail="Gagal men-decode gambar")
        
    h, w, _ = img.shape
    
    try:
        dets = json.loads(detections)
    except Exception:
        dets = []
        
    color_map = {
        "merah": (68, 68, 239),
        "kuning": (11, 158, 245),
        "biru": (246, 130, 59),
        "hitam": (30, 30, 30),
        "putih": (255, 255, 255)
    }
    
    for idx, d in enumerate(dets, 1):
        try:
            x = float(d.get("x", 0))
            y = float(d.get("y", 0))
            color_str = str(d.get("color", "biru")).lower()
            rgb = (59, 130, 246)
            if color_str.startswith("#"):
                hex_val = color_str.lstrip("#")
                if len(hex_val) == 3:
                    hex_val = "".join(c*2 for c in hex_val)
                try:
                    rgb = tuple(int(hex_val[i:i+2], 16) for i in (0, 2, 4))
                    bgr = (rgb[2], rgb[1], rgb[0])
                except Exception:
                    bgr = (246, 130, 59)
            else:
                bgr = color_map.get(color_str, (246, 130, 59))
                if color_str == "merah": rgb = (239, 68, 68)
                elif color_str == "kuning": rgb = (245, 158, 11)
                elif color_str == "biru": rgb = (59, 130, 246)
                elif color_str == "hitam": rgb = (30, 30, 30)
                elif color_str == "putih": rgb = (255, 255, 255)
            
            px = int(x * w)
            py = int(y * h)
            
            min_dim = min(h, w)
            radius = max(10, int(min_dim * 0.02))
            
            p1 = (px - radius, py - radius)
            p2 = (px + radius, py + radius)
            cv2.rectangle(img, p1, p2, bgr, -1)
            
            text = str(idx)
            font = cv2.FONT_HERSHEY_SIMPLEX
            font_scale = max(0.35, min_dim * 0.0006)
            thickness = max(1, int(min_dim * 0.0015))
            
            if sum(rgb) > 380:
                text_col = (0, 0, 0)
            else:
                text_col = (255, 255, 255)
                
            text_size = cv2.getTextSize(text, font, font_scale, thickness)[0]
            tx = px - text_size[0] // 2
            ty = py + text_size[1] // 2
            cv2.putText(img, text, (tx, ty), font, font_scale, text_col, thickness, cv2.LINE_AA)
        except Exception:
            pass
            
    _, encoded_img = cv2.imencode('.jpg', img)
    return StreamingResponse(
        io.BytesIO(encoded_img.tobytes()), 
        media_type="image/jpeg",
        headers={"Cache-Control": "no-cache"}
    )



# ─────────────────────────────────────────────
# Devlogs & Update routes
# ─────────────────────────────────────────────
DEVLOGS_DIR = os.path.join(BASE_DIR, 'devlogs')

@app.get("/api/devlogs")
def get_devlogs_list():
    if not os.path.exists(DEVLOGS_DIR):
        os.makedirs(DEVLOGS_DIR, exist_ok=True)
    files = []
    for f in sorted(os.listdir(DEVLOGS_DIR)):
        if f.endswith(".md"):
            fp = os.path.join(DEVLOGS_DIR, f)
            size = os.path.getsize(fp) if os.path.isfile(fp) else 0
            mtime = os.path.getmtime(fp) if os.path.isfile(fp) else 0
            files.append({
                "filename": f,
                "title": f.replace(".md", "").capitalize(),
                "size": size,
                "mtime": mtime
            })
    return files

@app.get("/api/devlogs/{filename}")
def get_devlog_content(filename: str):
    if ".." in filename or "/" in filename or "\\" in filename:
        raise HTTPException(status_code=400, detail="Invalid filename")
    fp = os.path.join(DEVLOGS_DIR, filename)
    if not os.path.isfile(fp):
        raise HTTPException(status_code=404, detail="Devlog file not found")
    try:
        with open(fp, 'r', encoding='utf-8') as f:
            content = f.read()
        return {
            "filename": filename,
            "content": content
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/update")
def get_update_page():
    update_path = os.path.join(BASE_DIR, 'update.html')
    if os.path.exists(update_path):
        return FileResponse(update_path, media_type="text/html")
    raise HTTPException(status_code=404, detail="update.html not found")


# ─────────────────────────────────────────────
# SPA catch-all — serve index.html for any
# non-API path so browser router can restore state
# ─────────────────────────────────────────────

@app.get("/{full_path:path}")
def serve_spa_fallback(full_path: str):
    if full_path.startswith("api/"):
        raise HTTPException(status_code=404, detail="API route not found")
    if full_path:
        file_path = os.path.normpath(os.path.join(BASE_DIR, full_path))
        if not file_path.startswith(os.path.normpath(BASE_DIR)):
            raise HTTPException(status_code=403, detail="Access denied")
        if os.path.isfile(file_path):
            mime_type, _ = mimetypes.guess_type(file_path)
            return FileResponse(file_path, media_type=mime_type or "application/octet-stream")
    index_path = os.path.join(BASE_DIR, 'index.html')
    if os.path.exists(index_path):
        return FileResponse(index_path, media_type="text/html")
    raise HTTPException(status_code=404, detail="index.html not found")


if __name__ == '__main__':
    if not os.path.exists(DATASET_DIR):
        os.makedirs(DATASET_DIR, exist_ok=True)
    uvicorn.run("datasetcreator:app", host="127.0.0.1", port=8000, reload=True)
