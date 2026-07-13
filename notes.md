# Log Perubahan (Changelog)

## [2026-07-12] Split Monolithic index.html into Modular Files

### Deskripsi
Melakukan refaktorisasi pada file frontend utama `index.html` yang sebelumnya sangat panjang (~3000 baris) dengan membaginya menjadi beberapa file modular yang lebih kecil.

### Perubahan Detail

1. **Pemisahan File HTML Halaman (Partials)**
   Mengekstrak konten inner HTML dari masing-masing halaman/tab pada layout utama menjadi file HTML tersendiri:
   - [dataset.html](dataset.html) (Tab DATASET)
   - [class.html](class.html) (Tab CLASS SETTINGS & TAGS)
   - [annotation.html](annotation.html) (Tab ANNOTATION)
   - [categorize.html](categorize.html) (Tab CATEGORIZE & MONITOR)
   - [settings.html](settings.html) (Tab SETTINGS)

2. **Penyesuaian [datasetcreator.py](datasetcreator.py)**
   - Memodifikasi route `serve_spa_fallback` agar menyajikan file statis (`index.css`, `index.js`, dan partials HTML) jika file tersebut ada di disk.

## [2026-07-13] Integration and Validation of SAM 3.1 (Segment Anything Model 3.1)

### Deskripsi
Melakukan instalasi dependencies dan integrasi model segmentasi terbaru Meta **SAM 3.1** (Segment Anything Model 3.1) menggunakan framework `ultralytics`.

### Perubahan Detail

1. **Instalasi Dependencies & Unduh Weights Model**
   - Menggunakan package manager `ultralytics` yang telah mendukung SAM 3.1 natively.
   - Mengunduh file checkpoint model `sam3.1.pt` (~3.26 GB / 3340 MB) dari mirror publik Hugging Face `AEmotionStudio/sam3.1` (menggunakan script pembantu `download_sam3.py`) karena official checkpoint di gated oleh Meta.

2. **Pembuatan Script Uji Coba ([samtest.py](samtest.py))**
   - Menambahkan file [samtest.py](samtest.py) yang memindai dataset lokal di `dataset/v1/annotate/images`.
   - Secara otomatis membaca file anotasi polygon YOLO (jika tersedia di subfolder `labels`), mencari bounding box minimum/maksimum dalam pixel, dan menjadikannya sebagai *prompt box* untuk input SAM 3.1.
   - Melakukan inference menggunakan GPU/CUDA (dengan CUDA 12.8 pada virtual environment) yang membutuhkan waktu sekitar ~2.5 detik per gambar.
   - Menampilkan hasil visualisasi segmentasi mask menggunakan window OpenCV (`cv2.imshow`) yang interaktif.