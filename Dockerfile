# ---------------------------------------------------------------------------
# rizin-auto-comment-pin
#
# Build arg INSTALL_BROWSER controls whether Chromium (for the Playwright
# pin/comment automation) is baked into the image.
#   true  -> ~1GB image, browser automation available (default)
#   false -> small image, API-only mode (YouTube commenting + notifications)
# On Railway set it under Settings -> Build -> Build Args if you want to
# change it.
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim

ARG INSTALL_BROWSER=true
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    TZ=Asia/Tokyo

WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tzdata \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./

# Skip the automatic browser download during install; we do it explicitly
# below so that only Chromium (not Firefox/WebKit) is fetched.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm install --include=dev --no-audit --no-fund

COPY . .
RUN npm run build

RUN if [ "$INSTALL_BROWSER" = "true" ]; then \
      PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD= npx playwright install --with-deps chromium; \
    else \
      echo "skipping browser install (INSTALL_BROWSER=$INSTALL_BROWSER)"; \
    fi

RUN npm prune --omit=dev

EXPOSE 3000
CMD ["node", "dist/index.js"]
