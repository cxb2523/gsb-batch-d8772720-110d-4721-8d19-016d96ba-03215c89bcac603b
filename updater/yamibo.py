from .subscription import SubscriptionUpdater


class YamiboUpdater(SubscriptionUpdater):
    SITE_NAME = 'yamibo'
    ID_FIELD = 'keyword'

    def get_chapters(self, record):
        from plugins.yamibo.client import YamiboClient
        with YamiboClient() as client:
            return client.chapters(record['keyword'])
