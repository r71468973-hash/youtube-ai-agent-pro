FROM node:22-bookworm-slim
# ffmpeg: rendering. chromium: headless 3D animation renderer (WebGL via SwiftShader). fonts: Hindi captions.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg chromium fontconfig fonts-dejavu-core fonts-noto-core \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
COPY server.js ./
COPY lib ./lib
COPY public ./public
COPY test ./test
ENV NODE_ENV=production PORT=3000 DATA_DIR=/app/data CHROME_PATH=/usr/bin/chromium
RUN mkdir -p /app/data && chown -R node:node /app
EXPOSE 3000
USER node
CMD ["node", "server.js"]
