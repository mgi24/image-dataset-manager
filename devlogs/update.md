# System Update & Devlog Documentation Viewer (`/update`)

Dokumen ini menjelaskan spesifikasi teknis, arsitektur, dan alur kerja dari modul **Devlog Viewer & System Update (`/update`)** pada aplikasi Vehicle Detection Dataset Manager.

---

## 🏛️ 1. Ringkasan Fitur `/update`

- **GitHub Dark Mode UI**: Tampilan antarmuka bergaya GitHub Dark Theme (`#0d1117`, `#161b22`, `#30363d`) dengan sidebar navigasi untuk menjelajahi file dokumentasi `.md` di folder `devlogs/`.
- **Dynamic File Loader**: Membaca secara otomatis seluruh dokumen `.md` yang ada di direktori `devlogs/` tanpa perlu mendaftarkannya secara manual.
- **Client-Side Markdown Rendering**: Menggunakan **Marked.js** untuk memproses sintaks Markdown secara lengkap (headers, tables, code blocks, callouts, badges).
- **Interactive Mermaid Node Renderer**: Mengidentifikasi blok kode ` ```mermaid ` dan merender diagram graf/flowchart secara otomatis menggunakan **Mermaid.js**.
- **Vector High-Resolution Zoom & Pan Modal**: Modal zoom *fullscreen* interaktif dengan perenderan vektor langsung (sharp text/lines 100% tanpa pixelation/blur), dukungan scroll wheel zoom, drag pan 60 FPS, serta tombol reset/close (`Esc`).

---

## 📊 2. Diagram Alur Sistem (Flowchart)

```mermaid
flowchart TD
    subgraph Client ["Browser Frontend (SPA / update.html)"]
        Nav_Tab["Sidebar Menu: UPDATE"]
        Doc_List["Devlog File Selector"]
        MD_Parser["Marked.js Engine"]
        MM_Renderer["Mermaid.js Node Renderer"]
        Zoom_Modal["Fullscreen Vector Zoom & Pan Modal"]
    end

    subgraph Server ["Backend Server (datasetcreator.py)"]
        API_Devlogs_List["GET /api/devlogs\n(Scan folder devlogs/*.md)"]
        API_Devlog_Content["GET /api/devlogs/{filename}\n(Read Raw Markdown)"]
        Route_Update["GET /update\n(Serve update.html)"]
    end

    subgraph FileSystem ["Physical Storage"]
        Devlog_Folder[/"devlogs/ Directory\n(*.md files)"/]
    end

    Nav_Tab -- "Access /update" --> Route_Update
    Route_Update -- "Render UI" --> Doc_List

    Doc_List -- "Fetch List" --> API_Devlogs_List
    API_Devlogs_List -- "Read Files" --> Devlog_Folder

    Doc_List -- "Select File" --> API_Devlog_Content
    API_Devlog_Content -- "Return Text" --> MD_Parser

    MD_Parser -- "Generate HTML" --> MM_Renderer
    MM_Renderer -- "Click Diagram" --> Zoom_Modal
```

---

## 🔄 3. Diagram Sekuensial Eksekusi (Sequence Diagram)

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant Web as Browser (update.html)
    participant API as FastAPI (datasetcreator.py)
    participant FS as File System (devlogs/*.md)
    participant Mermaid as Mermaid.js Engine

    User->>Web: Akses /update atau klik menu UPDATE
    Web->>API: GET /api/devlogs
    API->>FS: Scan file *.md di devlogs/
    FS-->>API: Return list file (name, size, mtime)
    API-->>Web: JSON [{ filename: "annotate2.md", ... }]

    Web->>Web: Render daftar file di sidebar
    User->>Web: Klik file "update.md"
    Web->>API: GET /api/devlogs/update.md
    API->>FS: Baca file devlogs/update.md
    FS-->>API: Content teks markdown
    API-->>Web: JSON { content: "..." }

    Web->>Web: Marked.js parse markdown ke HTML
    Web->>Mermaid: mermaid.run({ nodes: graphs })
    Mermaid-->>Web: Render SVG diagram di canvas

    User->>Web: Klik Diagram Mermaid
    Web->>Web: Open Fullscreen Zoom Modal (Vector Scaling)
    User->>Web: Scroll Wheel / Mouse Drag (Pan)
    Web->>Web: Render ulang vektor SVG secara murni (Sharp & Crisp)
```

---

## ⚡ 4. Detail Teknis Penanganan Zoom Vektor Tajam (Sharp Vector Fix)

Untuk mencegah gambar diagram menjadi buram/pixelated saat diperbesar (yang biasa terjadi jika memperbesar grafik dengan CSS `transform: scale()` pada elemen berukuran kecil):
1. **Atribut Dimensi SVG**: Atribut `width` dan `height` bawaan SVG dihapus sehingga SVG dapat mengekspansi resolusi vektor secara murni berdasarkan `viewBox`.
2. **Skala Dimensi Vektor Langsung**: Skala zoom diterapkan langsung pada dimensi `svg.style.width` dan `svg.style.height` (misal `baseWidth * zoomScale`).
3. **Pergerakan 60 FPS Smooth**: Efek geser (pan) menggunakan `translate3d(x, y, 0)` tanpa animasi CSS transition yang bertabrakan, menghasilkan pergerakan murni 1-to-1 yang sangat halus tanpa jitter.
