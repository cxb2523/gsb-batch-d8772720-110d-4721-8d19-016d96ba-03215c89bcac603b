# librecrawl-technical-seo-audit-mcp — the MCP server that drives LibreCrawl.
# Runs standalone; pair it with the LibreCrawl engine via docker-compose.yml.
FROM python:3.12-slim

# WeasyPrint (PDF report pipeline) needs these system libraries at runtime.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libpango-1.0-0 libpangocairo-1.0-0 libcairo2 \
        libgdk-pixbuf-2.0-0 libffi-dev libharfbuzz0b libfribidi0 \
        fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Container defaults. Override per-deployment in docker-compose.yml or `-e`.
ENV MCP_TRANSPORT=http \
    MCP_HOST=0.0.0.0 \
    MCP_PORT=5081 \
    LIBRECRAWL_URL=http://librecrawl:5000 \
    REPORTS_DIR=/reports \
    LIBRECRAWL_UPSTREAM_DB=/librecrawl-data/users.db

EXPOSE 5081
CMD ["python", "server.py"]
