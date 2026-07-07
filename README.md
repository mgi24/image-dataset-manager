# YOLO Segment Dataset Manager

A premium, dark-themed Single Page Application (SPA) dashboard to visualize, filter, rename, tag, and manage YOLO segment datasets. Powered by a lightweight **FastAPI** backend and **Vanilla JS** frontend, storing custom metadata tags in **SQLite** and configuration in YOLO `data.yaml` files.

---

## 🚀 Key Features

1. **SPA Routing**: Catch-all server routing support enabling full browser-level refreshes on routes like `/v1/dataset`, `/v1/class`, or `/v1/annotation` without `404 Not Found` errors.
2. **Metadata Tagging System**:
   - Save custom tags (e.g. `CCTV`, `JALAN`, `MALAM`) to a local SQLite database (`dataset_manager.db`).
   - Filter images by multiple tags using a checkbox dropdown menu (`TAGS ▾`) in the header.
   - Bulk assign/remove tags using the select mode action bar with indeterminate checkbox states.
   - Database tags automatically update or delete when images are renamed or deleted.
3. **Advanced Renaming Modes**:
   - **Rename**: Complete filename overwrite with incremental indexing (`base_0.jpg`, `base_1.jpg`).
   - **Add Name**: Prepends prefixes to original filenames (`prefix_0_originalName.jpg`).
   - **Live Preview**: Real-time side-by-side previews for both modes inside the modal.
4. **Class Management & Deletion**:
   - Color pickers and text fields to update class settings and write to `data.yaml`.
   - Adding and deleting classes directly from the interface.
   - Class deletion counts the annotations affected, displays a warning, runs in a background thread to update files without timeout, and decrements subsequent class IDs inside the `.txt` label files to preserve YOLO indices.
   - Live percentage progress bar displayed while rewriting labels.
5. **Image Grid & Infinite Scroll**:
   - Loads images in batches of 40 dynamically.
   - Inserts beautiful dividers every 100 images to aid visual orientation.
   - Supports single click selection, Shift + Click range selection, and click-drag sweep selection.
   - Toggle polygon mask overlays ON/OFF.

---

## 📁 Directory Structure

Place your YOLO datasets in the `dataset/` directory. Each subfolder is treated as a separate dataset:

```text
vehicledetect/
├── dataset/
│   └── v1/
│       ├── images/
│       │   ├── image1.jpg
│       │   └── image2.jpg
│       ├── labels/
│       │   ├── image1.txt
│       │   └── image2.txt
│       └── data.yaml
├── datasetcreator.py  # FastAPI server
├── index.html         # Frontend SPA
├── requirements.txt   # Dependencies
└── dataset_manager.db # SQLite database (created automatically)
```

---

## 🛠️ Installation & Setup

### 1. Prerequisites
Make sure you have **Python 3.8+** installed.

### 2. Virtual Environment Setup
Clone the repository and set up a virtual environment:

```bash
# Clone repository
git clone https://github.com/mgi24/image-dataset-manager.git
cd vehicledetect

# Create a virtual environment
python -m venv venv

# Activate virtual environment
# On Windows (Command Prompt)
venv\Scripts\activate.bat
# On Windows (PowerShell)
.\venv\Scripts\Activate.ps1
# On macOS/Linux
source venv/bin/activate
```

### 3. Install Dependencies
Install the required packages listed in `requirements.txt`:

```bash
pip install -r requirements.txt
```
*(Note: SQLite is part of Python's standard library and does not require manual pip installation.)*

### 4. Run the Server
Launch the FastAPI development server:

```bash
python datasetcreator.py
```

The application will run at **`http://127.0.0.1:5000`**. Open this URL in your web browser.
