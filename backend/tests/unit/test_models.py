import pytest

from app.models import Company, Job, http_url


class TestHttpUrl:
    @pytest.mark.parametrize("url", ["https://example.com/jobs?id=1", "HTTP://Example.com"])
    def test_accepts_http_and_https(self, url):
        assert http_url(url) == url

    @pytest.mark.parametrize(
        "value",
        [
            "javascript:alert(1)",
            " JavaScript:alert(1)",
            "data:text/html,<script>alert(1)</script>",
            "//example.com",
            "https:no-host",
            "",
            None,
            123,
        ],
    )
    def test_rejects_everything_else(self, value):
        assert http_url(value) is None

    def test_strips_whitespace(self):
        assert http_url("  https://example.com  ") == "https://example.com"


class TestModelUrlValidators:
    def test_job_source_url_falls_back_to_empty(self):
        assert Job(title="Engineer", source_url="javascript:alert(1)").source_url == ""
        assert Job(title="Engineer", source_url="https://x.com/1").source_url == "https://x.com/1"

    def test_company_url_fields(self):
        company = Company(name="Acme", slug="acme", website="javascript:alert(1)")
        company.logo_url = "https://example.com/logo.png"
        assert company.website is None
        assert company.logo_url == "https://example.com/logo.png"

    def test_social_links_drops_unsafe_entries(self):
        company = Company(
            name="Acme",
            slug="acme",
            social_links={"twitter": "https://twitter.com/acme", "website": "javascript:x"},
        )
        assert company.social_links == {"twitter": "https://twitter.com/acme"}

        company.social_links = {"website": "javascript:x"}
        assert company.social_links is None
