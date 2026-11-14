import pytest
import os
import sys


current_dir = os.path.dirname(os.path.abspath(__file__))
project_root = os.path.join(current_dir, "..")
sys.path.insert(0, project_root)


from social_media.youtube_downloader.downloader import download_video

def test_directory_creation():
    """Fonksiyon çağrıldığında klasör oluşuyor mu?"""
    test_path = "test_downloads"
    
   
    try:
        download_video("https://invalid-url", download_path=test_path)
    except:
      
        pass
    
    # Kontrol
    exists = os.path.exists(test_path)
    
 
    if exists:
        os.rmdir(test_path)
        
    assert exists is True