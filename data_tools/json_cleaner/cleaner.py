import json 

def clean_empty_values(data):
    """Recursively remove None or empty strings from dict/list."""
    if isinstance(data, dict):
        return {k: clean_empty_values(v) for k, v in data.items() if v not in [None, "", [], {}]}
    elif isinstance(data, list):
        return [clean_empty_values(v) for v in data if v not in [None, "", [], {}]]
    return data 

def main():
    # Example of dirty data
    dirty_json = '{"name": "Emine", "age": null, "skills": ["Python", ""], "meta": {}}'
    data = json.loads(dirty_json)
    
    print(f"Original: {dirty_json}")
    
    
    cleaned_data = clean_empty_values(data)
    
    
    print("Cleaned JSON:", json.dumps(cleaned_data, indent=4))


if __name__ == "__main__":
    main()