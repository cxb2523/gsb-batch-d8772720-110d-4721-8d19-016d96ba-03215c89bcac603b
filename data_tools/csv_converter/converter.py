import csv 
import json 

"""
Python Automation Hub - CSV to JSON Convverter
Easily convert your date files for web projects.
"""

def convert(csv_file, json_file):
    data =[]
    try:
        with open(csv_file, encoding='utf-8-sig') as f:
            reader = csv.DictReader(f)
            for rows in reader:
                data.append(rows)
        with open(json_file, 'w', encoding='utf-8') as f:
            f.write(json.dumps(data,indent=4))
        print(f"[✔] Conversion complete: {json_file}")
    except Exception as e:
       print(f"[!] Error: {e}")
    
if __name__ == "__main__" :
    print("Place your 'data.csv in this folder to convert.")
    convert('data.csv', 'data.json')