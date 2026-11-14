import yt_dlp
import os
from datetime import datetime

def log_download(url, status):
    # Bu dosya değiştikçe Git 'update' olduğunu anlayacak
    with open("download_history.txt", "a", encoding="utf-8") as f:
        f.write(f"{datetime.now()} - {status}: {url}\n")

def download_video(url, download_path='downloads', only_audio=False):
    if not os.path.exists(download_path):
        os.makedirs(download_path)

    ydl_opts = {
        'outtmpl': f'{download_path}/%(title)s.%(ext)s',
        # Eğer ffmpeg exe'lerini klasöre attıysan alt satırı aktif et:
        # 'ffmpeg_location': '.', 
    }

    if only_audio:
        ydl_opts.update({
            'format': 'm4a/bestaudio/best',
            'postprocessors': [{
                'key': 'FFmpegExtractAudio',
                'preferredcodec': 'm4a',
            }],
        })

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.download([url])
            log_download(url, "SUCCESS")
            print("✅ Bitti babuş, dosya klasörde!")
    except Exception as e:
        log_download(url, f"ERROR: {str(e)}")
        print(f"❌ Hata: {e}")

if __name__ == "__main__":
    url = input("Link patlat: ")
    choice = input("1-Video / 2-Ses: ")
    download_video(url, only_audio=(choice == '2'))