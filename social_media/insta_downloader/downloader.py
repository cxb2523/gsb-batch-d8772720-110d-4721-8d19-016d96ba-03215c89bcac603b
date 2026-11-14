import requests

"""
Python Automation Hub - Simple Image Dowloader 
A tool to download images from a given URL.
"""

def dowload_image(url,file_name):
    try:
        response = requests.get(url,stream=True)
        if response.status_code == 200:
            with open(file_name ,'wb') as f:
              f.write(response.content)
            print(f"[✔] Successfully downloaded: {file_name}")
        else:
            print(f"[!] Could not dowload. Status code : {response.status_code}")
    except Exception as e:
        print(f"[!] Error : {e}")

if __name__  == "__main__":
    img_url = input("Enter Image URL :")
    name = input("Save as (exapmle.jpg) :")
    dowload_image(img_url,name)