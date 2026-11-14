"""Site metadata without importing optional SDKs."""
from collections.abc import Mapping
from importlib import import_module

SITES = {
    'copymanga': 'CopyMangaUpdater',
    'terra_historicus': 'TerraHistoricusUpdater',
    'antbyw': 'AntbywUpdater',
    'ganganonline': 'GanganOnlineUpdater',
    'bilibili': 'BilibiliUpdater',
    'jm': 'JmUpdater',
    'yamibo': 'YamiboUpdater',
}


class LazyUpdaters(Mapping):
    def __iter__(self):
        return iter(SITES)

    def __len__(self):
        return len(SITES)

    def __getitem__(self, site):
        class_name = SITES[site]
        return getattr(import_module(f'updater.{site}'), class_name)


SITE_MAPPING = LazyUpdaters()
SITE_MODULES = {site: f'plugins.{site}.main' for site in SITES}
