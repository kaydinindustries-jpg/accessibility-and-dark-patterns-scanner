# Use Node 20 base image
FROM node:20-bookworm

# Install Chromium and dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libexpat1 \
    libgbm1 \
    libgcc1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libx11-6 \
    libx11-xcb1 \
    libxau6 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    xdg-utils && \
    rm -rf /var/lib/apt/lists/*

# Pin headless chrome for Puppeteer
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    CHROME_PATH=/usr/bin/chromium \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app
# Copy lockfile to ensure deterministic install
COPY package.json package-lock.json tsconfig.json ./
# Install with dev deps for build, then prune
RUN npm install && npm cache clean --force
COPY src ./src
RUN npm run build && npm prune --omit=dev && npm cache clean --force

EXPOSE 3000
CMD ["node", "dist/index.js"]
