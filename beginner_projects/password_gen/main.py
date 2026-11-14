import random
import string 

def generate_password(length = 12):
    chars = string.ascii_letters + string.digits + string.punctuation
    password = ''.join(random.choice(chars) for i in range(length))
    return password

print("---Secure Password Generator ---")
print(f"Your New Password : {generate_password()}")