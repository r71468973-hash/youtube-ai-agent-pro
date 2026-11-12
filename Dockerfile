FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg fontconfig fonts-dejavu-core fonts-noto-core \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
COPY server.js ./
COPY lib ./lib
COPY public ./public
ENV NODE_ENV=production PORT=3000 DATA_DIR=/app/data
VOLUME /app/data
EXPOSE 3000
USER node
RUN mkdir -p /app/data && chown node:node /app/data
CMD ["node", "server.js"]
