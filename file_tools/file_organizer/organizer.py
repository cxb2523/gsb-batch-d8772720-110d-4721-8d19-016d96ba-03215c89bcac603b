import os
import shutil

def organize_folder(target_path):
    # File extension mappings
    extensions = {
        'Images': ['.jpg', '.jpeg', '.png', '.gif'],
        'Documents': ['.pdf', '.docx', '.txt', '.xlsx'],
        'Videos': ['.mp4', '.mkv', '.mov'],
        'Archives': ['.zip', '.rar', '.7z'],
        'Music': ['.mp3', '.wav', '.aac', '.flac', '.ogg'],    
        'Design': ['.psd', '.ai', '.eps', '.sketch', '.fig'] 
    }

    try:
        for file in os.listdir(target_path):
            file_path = os.path.join(target_path, file)
            
            # If it's a file (not a folder)
            if os.path.isfile(file_path):
                ext = os.path.splitext(file)[1].lower()
                
                for folder, exts in extensions.items():
                    if ext in exts:
                        dest_folder = os.path.join(target_path, folder)
                        os.makedirs(dest_folder, exist_ok=True)
                        shutil.move(file_path, os.path.join(dest_folder, file))
                        print(f"Moved: {file} -> {folder}")
        
        print("Organization complete!")
    except Exception as e:
        print(f"An error occurred: {e}")

if __name__ == "__main__":
    # You can enter the path to the folder you want to test here
    #organize_folder('C:/Users/your_name/Desktop/deneme')
    print("Please specify a folder path in the code to start.")