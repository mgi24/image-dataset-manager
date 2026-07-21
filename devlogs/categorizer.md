# Fitur Baru: Categorizer & LLM Settings

Dokumen ini merangkum perubahan major yang baru saja diimplementasikan pada sistem manajemen dataset untuk menambahkan tab **CATEGORIZE** dan **SETTINGS**.

---

## 1. Arsitektur Backend & API Proxy
Karena LM Studio (secara default) tidak menyertakan header CORS pada API lokalnya (`http://127.0.0.1:1234`), dibuatlah mekanisme proxy di backend FastAPI (`datasetcreator.py`) agar browser dapat melakukan request secara aman tanpa diblokir oleh kebijakan browser:

*   **Penyimpanan Konfigurasi (`llm_settings.json`)**: Menyimpan URL API, API Key, dan model terpilih secara permanen di server lokal.
*   **Endpoint `/api/llm-settings` (GET/POST)**: Mengambil dan menyimpan konfigurasi LLM.
*   **Endpoint Proxy `/api/llm/models` (GET)**: Meneruskan permintaan pencarian list model aktif ke LM Studio.
*   **Endpoint Proxy `/api/llm/chat` (POST)**: Meneruskan chat completions dengan fitur **streaming (SSE)** untuk memantau proses berpikir (*thinking*) dan jawaban secara real-time dari browser.
*   **Endpoint `/api/dataset/{name}/image-base64/{filename}` (GET)**: Mengonversi file gambar dataset lokal menjadi format **Base64** secara dinamis agar bisa dikirimkan ke LLM Vision API.
*   **Penambahan Library (`requirements.txt`)**: Menggunakan `httpx` untuk mendukung penanganan request HTTP asinkronus ke LM Studio.

---

## 2. Tab SETTINGS (Konfigurasi API)
Tab baru ini digunakan untuk menghubungkan sistem dengan API LLM lokal atau cloud yang kompatibel dengan format OpenAI:
*   **Form Input**: Mengatur API URL, API Key, dan Model ID.
*   **Test Connection**: Menghubungi endpoint `/v1/models` melalui proxy backend. Jika sukses, status koneksi berubah menjadi hijau dan memuat daftar model yang sedang aktif di LM Studio.
*   **Model Selection**: Setiap model yang aktif ditampilkan dalam bentuk *card/chip* yang bisa langsung diklik untuk memilih model secara instan tanpa perlu mengetik manual.

---

## 3. Tab CATEGORIZE (Mode Setup & Filter)
Tab utama untuk mengkategorikan gambar secara otomatis menggunakan kecerdasan buatan (LLM):
*   **Opsi Metode**: Dibuat sebagai tombol besar berlabel **LLM**.
*   **Add Tags (Interaktif)**: Pengguna dapat mengetik tag baru lalu menekan `Enter` atau `,` untuk memasukkan tag dalam bentuk chip visual. Tombol `Backspace` pada input kosong akan menghapus chip terakhir.
*   **Tags Description**: Input opsional untuk memberikan instruksi kontekstual tambahan kepada model LLM mengenai tag-tag yang dicari.
*   **System Prompt Editor**: System prompt dibuat secara otomatis (auto-generated) untuk menginstruksikan LLM agar mengembalikan output dalam format JSON ketat:
    `{"tags": ["tag1", "tag2"]}`.
    Terdapat tombol **Edit/Lock** agar pengguna dapat memodifikasi isi system prompt secara manual jika diinginkan.
*   **Batch Size Control**: Input angka (harus `> 0`) untuk menentukan berapa banyak gambar yang akan di-hit ke LLM secara paralel (default: `4`).
*   **Filter & Image Grid**: Memiliki filter berbasis kategori kelas objek (YOLO) sama seperti halaman dataset. Ditambahkan tombol **Select All** dan **Clear** untuk mempermudah pemilihan batch gambar yang akan diproses.
*   **Tombol Start**: Hanya aktif jika konfigurasi LLM lengkap, terdapat tag yang dimasukkan, dan ada gambar yang dipilih.

---

## 4. Mode Monitor (Proses Berjalan)
Ketika tombol **Start Categorize** ditekan, semua layout setup disembunyikan dan berganti ke antarmuka **Monitor View** yang interaktif:
*   **Progress Tracker**: Menampilkan progress bar visual, persentase total, dan counter jumlah gambar yang berhasil diselesaikan secara real-time.
*   **Parallel Workers Grid**: Jumlah baris worker disesuaikan dengan nilai *Batch Size*. Setiap slot worker menampilkan:
    *   Thumbnail gambar yang sedang diproses.
    *   Badge status (`Idle`, `Processing`, `Done`, `Failed`).
    *   Nama file gambar.
    *   **Live Stream Thinking**: Menampilkan cuplikan proses berpikir model (*reasoning content*) secara dinamis (jika fitur thinking di model aktif).
    *   **Live Stream Answer**: Menampilkan respon jawaban teks mentah dari LLM saat sedang di-stream.
    *   **Result Tags**: Menampilkan tag hasil akhir yang sukses ter-parse, atau label `PARSE FAIL` jika JSON rusak.
*   **Tombol Stop**: Untuk membatalkan proses antrean yang tersisa kapan saja secara aman.

---

## 5. Laporan Akhir & Mekanisme Retry
Setelah semua antrean gambar selesai diproses, antarmuka monitor akan menampilkan statistik laporan akhir:
*   **Berhasil**: Jumlah gambar yang sukses dianalisis dan mendapatkan tag baru (langsung disimpan ke database).
*   **Kosong**: Jumlah gambar yang dianalisis namun model menyatakan tidak memiliki tag yang relevan.
*   **Gagal Parse**: Jumlah gambar yang gagal karena LLM tidak mengembalikan format JSON yang valid atau terjadi error jaringan.
*   **Daftar Error & Raw Text**: Gambar yang gagal parse akan masuk ke daftar khusus di bagian bawah, lengkap dengan cuplikan teks mentah yang dikembalikan oleh LLM sebagai bahan evaluasi.
*   **Tombol Retry Gagal**: Memungkinkan pengguna untuk langsung memproses ulang hanya pada gambar-gambar yang sempat gagal dengan sekali klik (tanpa harus memilih ulang secara manual).
