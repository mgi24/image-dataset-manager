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

class LLMSettings(BaseModel):
    api_url: str
    api_key: Optional[str] = ""
    model: Optional[str] = ""
    dataset_type: Optional[str] = "object_detection"

class SaveAnnotationsRequest(BaseModel):
    filename: str
    annotations: list

LLM_SETTINGS_PATH = os.path.join(BASE_DIR, 'llm_settings.json')

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

@app.delete("/api/tags/{tag_name}")
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
    if os.path.exists(LLM_SETTINGS_PATH):
        with open(LLM_SETTINGS_PATH, 'r', encoding='utf-8') as f:
            data = json.load(f)
            if "dataset_type" not in data:
                data["dataset_type"] = "object_detection"
            return data
    return {"api_url": "http://127.0.0.1:1234", "api_key": "", "model": "", "dataset_type": "object_detection"}

@app.post("/api/llm-settings")
def save_llm_settings(settings: LLMSettings):
    with open(LLM_SETTINGS_PATH, 'w', encoding='utf-8') as f:
        json.dump(settings.dict(), f, indent=2)
    return {"success": True}

# ─────────────────────────────────────────────
# LLM Proxy (CORS transparent bridge)
# ─────────────────────────────────────────────

def _load_llm_settings_dict():
    if os.path.exists(LLM_SETTINGS_PATH):
        with open(LLM_SETTINGS_PATH, 'r', encoding='utf-8') as f:
            data = json.load(f)
            if "dataset_type" not in data:
                data["dataset_type"] = "object_detection"
            return data
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
    print("=" * 60)
    print("  Antigravity Dataset Manager")
    print("  http://127.0.0.1:5000")
    print("=" * 60)
    uvicorn.run("datasetcreator:app", host="127.0.0.1", port=5000, reload=True)
