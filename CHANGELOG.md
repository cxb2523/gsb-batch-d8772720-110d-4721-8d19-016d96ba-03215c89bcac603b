# Changelog

## Unreleased

- Added an optional `closed_to_public` boolean to `Meeting` for closed or executive sessions. It defaults to `False` and is exported as `extras["cityscrapers/closed_to_public"]` in the Open Civic Data output
- `CityScrapersSpider._get_status` no longer treats `Rescheduled from <date>` in a meeting title or the `text` argument as cancelled, since that phrase marks the new, active meeting. Bare "rescheduled", "postponed" and "cancel" still return `CANCELLED`, as do `Rescheduled from X to Y` and any of these words in the description. Meeting IDs are unchanged
- `LegistarSpider` now retries each year's event request independently instead of aborting the whole year loop on the first failure. The retry count comes from the `legistar_max_retries` spider attribute, then the `LEGISTAR_MAX_RETRIES` setting, then a default of 3. Each year is recorded as successful, retry-successful or failed, unparseable pages are skipped and counted, and a per-year summary is logged when the spider closes

## [v0.10.0](https://github.com/City-Bureau/city-scrapers-core/releases/tag/v0.10.0)

- Added support for Google Cloud Storage

## [v0.9.0](https://github.com/City-Bureau/city-scrapers-core/releases/tag/v0.9.0)

- Replaced Legistar scraper from [`python-legistar-scraper`](https://github.com/opencivicdata/python-legistar-scraper) with scrapy-based implementation
