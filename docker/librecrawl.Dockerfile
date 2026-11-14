# Upstream LibreCrawl engine (github.com/PhialsBasement/LibreCrawl), built with the
# session-persistence patch applied. This is the crawler the MCP server drives.
FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Pin to a branch/tag/commit at build time: --build-arg LIBRECRAWL_REF=<ref>
ARG LIBRECRAWL_REF=main

WORKDIR /opt
RUN git clone --depth 1 --branch "${LIBRECRAWL_REF}" \
        https://github.com/PhialsBasement/LibreCrawl.git librecrawl

WORKDIR /opt/librecrawl

# Apply the session-persistence patch (see docker/patch-librecrawl.py for why).
COPY docker/patch-librecrawl.py /tmp/patch-librecrawl.py
RUN python3 /tmp/patch-librecrawl.py main.py

RUN pip install --no-cache-dir -r requirements.txt
# Playwright/Chromium powers JS rendering. Default audits run JS-off, so a failed
# browser download must not break the build — it degrades gracefully.
RUN python3 -m playwright install --with-deps chromium || \
    echo "playwright chromium install skipped — JS rendering unavailable, HTTP crawl still works"

# Local mode = single admin user, no auth, no rate limits. Correct for a
# self-hosted backend that only the co-located MCP talks to.
ENV LOCAL_MODE=true \
    HOST_BINDING=0.0.0.0 \
    REGISTRATION_DISABLED=false

EXPOSE 5000
CMD ["python", "main.py"]
