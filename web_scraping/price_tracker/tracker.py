import requests
from bs4 import BeautifulSoup

def get_web_data(url, tag, attribute, value):
    """
    Fetches specific text data from a website using a tag and its attribute.
    """
    # Realistic User-Agent to avoid being blocked by servers
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
    }

    try:
        # Sending a GET request to the URL
        response = requests.get(url, headers=headers)
        response.raise_for_status() # Raise an error for bad status codes (404, 500 etc.)
        
        # Parse the HTML content using BeautifulSoup
        soup = BeautifulSoup(response.content, "html.parser")

        # Search for the specific element
        target_element = soup.find(tag, {attribute: value})
        
        if target_element:
            return target_element.get_text().strip()
        else:
            return "DATA NOT FOUND: Check the tag or attribute values."

    except requests.exceptions.RequestException as e:
        return f"NETWORK ERROR: {e}"
    except Exception as e:
        return f"ERROR: {e}"

if __name__ == "__main__":
    # Test: Fetching the main heading of a Wikipedia page
    target_url = "https://en.wikipedia.org/wiki/Python_(programming_language)"
    
    print(f"DEBUG: Fetching data from {target_url}...")
    
    # Parameters: tag='h1', attribute='id', value='firstHeading'
    result = get_web_data(target_url, "h1", "id", "firstHeading")
    
    print(f"RESULT: Found Title -> {result}")