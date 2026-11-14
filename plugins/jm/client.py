def account_name():
    from utils import config
    username = str(config.get_setting('jm_username', 'CMNAS_JM_USERNAME', '')).strip()
    if not username:
        raise ValueError('JM 收藏夹同步必须配置用户名和密码')
    return username


def create_client():
    import jmcomic
    from utils import config
    option_file = config.get_setting('jm_option_file', 'CMNAS_JM_OPTION_FILE', '')
    option = jmcomic.create_option_by_file(option_file) if option_file else jmcomic.JmOption.default()
    client = option.new_jm_client()
    username = account_name()
    password = config.get_setting('jm_password', 'CMNAS_JM_PASSWORD', '')
    if not password:
        raise ValueError('JM 收藏夹同步必须配置密码')
    client.login(username, password)
    return client
