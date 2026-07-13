import httpx
import os
import sys

URL = "https://huggingface.co/AEmotionStudio/sam3.1/resolve/main/sam3.1_multiplex.pt"
OUTPUT_FILE = "sam3.1.pt"


def download_file():
    print(f"Starting download from {URL}...")
    print(f"Saving to {OUTPUT_FILE}...")
    
    with httpx.stream("GET", URL, follow_redirects=True, timeout=60.0) as r:
        if r.status_code != 200:
            print(f"Error: status code {r.status_code}")
            sys.exit(1)
            
        total_size = int(r.headers.get("content-length", 0))
        downloaded = 0
        
        with open(OUTPUT_FILE, "wb") as f:
            for chunk in r.iter_bytes(chunk_size=1024 * 1024):  # 1MB chunks
                if chunk:
                    f.write(chunk)
                    downloaded += len(chunk)
                    if total_size > 0:
                        percent = (downloaded / total_size) * 100
                        print(f"Downloaded: {downloaded / (1024 * 1024):.2f} MB / {total_size / (1024 * 1024):.2f} MB ({percent:.2f}%)", end="\r")
                    else:
                        print(f"Downloaded: {downloaded / (1024 * 1024):.2f} MB (size unknown)", end="\r")
                        
    print("\nDownload completed successfully!")

if __name__ == "__main__":
    download_file()
