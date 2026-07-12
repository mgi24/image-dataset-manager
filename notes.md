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

### ADD Ultralytics GPU