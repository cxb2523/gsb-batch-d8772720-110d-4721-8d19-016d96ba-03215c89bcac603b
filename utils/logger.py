import logging
import os

def setup_logger(name, log_file='automation_hub.log', level=logging.INFO):
    """Profesyonel log yapılandırması."""
    
    
    if not os.path.exists('logs'):
        os.makedirs('logs')
        
    full_path = os.path.join('logs', log_file)

    formatter = logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s')

    
    file_handler = logging.FileHandler(full_path, encoding='utf-8')
    file_handler.setFormatter(formatter)

    
    console_handler = logging.StreamHandler()
    console_handler.setFormatter(formatter)

    logger = logging.getLogger(name)
    logger.setLevel(level)
    logger.addHandler(file_handler)
    logger.addHandler(console_handler)

    return logger