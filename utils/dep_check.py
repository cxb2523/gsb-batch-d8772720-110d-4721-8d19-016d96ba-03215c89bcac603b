import importlib
import logging

log = logging.getLogger(__name__)

def require_package(package_name: str, import_name: str = None):
    """
    Checks if a package is available and returns the imported module.
    If not available, logs an error and returns None.
    
    :param package_name: The name of the package to check (e.g., 'bilibili-api-dev')
    :param import_name: The name used to import the package (e.g., 'bilibili_api'). 
                         Defaults to package_name if not provided.
    """
    if import_name is None:
        import_name = package_name.replace('-', '_')
        
    try:
        module = importlib.import_module(import_name)
        return module
    except ImportError:
        log.error(f"缺少可选依赖: {package_name} ({import_name})")
        log.error(f"请运行 'pip install -r requirements-plugins.txt' 来安装所需的插件依赖。")
        return None

def is_available(import_name: str) -> bool:
    """
    Checks if a package is available without logging errors.
    """
    try:
        importlib.import_module(import_name)
        return True
    except ImportError:
        return False
