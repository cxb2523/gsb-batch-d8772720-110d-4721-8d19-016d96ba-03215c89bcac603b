import re

def clean_filename(filename):
    invalid_chars = r'[\\/:*?"<>|]'
    return re.sub(invalid_chars, "_", filename)
