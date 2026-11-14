import random

def generate_hashtags(category):
    """
    Generates a set of trending hashtags based on the selected category.
    """
    # Our local hashtag database
    hashtag_bank = {
        "python": ["#python", "#coding", "#programming", "#software", "#developer", "#ai", "#machinelearning"],
        "web": ["#html", "#css", "#javascript", "#webdesign", "#frontend", "#backend", "#reactjs"],
        "lifestyle": ["#daily", "#vlog", "#life", "#goals", "#motivation", "#lifestyle", "#mindset"],
        "tech": ["#technology", "#gadgets", "#future", "#innovation", "#cybersecurity", "#techworld"]
    }

    category = category.lower()

    if category in hashtag_bank:
        tags = hashtag_bank[category]
        # Randomly shuffle and pick 5 tags to make it look organic
        selected_tags = random.sample(tags, k=min(len(tags), 5))
        return " ".join(selected_tags)
    else:
        return "ERROR: Category not found! Please try: python, web, lifestyle, or tech."

if __name__ == "__main__":
    print("--- Instagram Hashtag Generator ---")
    user_input = input("Enter a category (e.g., python, tech): ")
    
    print("\nDEBUG: Generating hashtags...")
    result = generate_hashtags(user_input)
    
    print(f"\nSUCCESS: Your Hashtags:\n{result}")