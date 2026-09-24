# Node 20 on Debian slim, plus ffmpeg and a bundled bold font for drawtext.
FROM node:20-slim

# Install ffmpeg and the DejaVu fonts (provides DejaVuSans-Bold.ttf used by the renderer).
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first for better layer caching.
COPY package.json ./
RUN npm install --omit=dev

# Copy source.
COPY src ./src

# Render sets PORT; default to 10000 locally.
ENV PORT=10000
EXPOSE 10000

CMD ["node", "src/server.js"]
