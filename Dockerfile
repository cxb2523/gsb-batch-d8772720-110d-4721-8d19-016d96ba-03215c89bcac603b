FROM mcr.microsoft.com/playwright:v1.62.1-noble

WORKDIR /app

RUN groupadd --system publisher \
    && useradd --system --gid publisher --create-home --home-dir /home/publisher publisher

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY --chown=publisher:publisher . ./
RUN mkdir -p profiles downloads screenshots workspace .local-state \
    && chown -R publisher:publisher /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3300
ENV DOUYIN_HEADLESS=true
ENV DOUYIN_DRY_RUN=true

EXPOSE 3300

USER publisher

CMD ["npm", "start"]
