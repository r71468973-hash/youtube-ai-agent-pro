FROM node:22-bookworm-slim
# ffmpeg: rendering. chromium: headless 3D animation renderer (WebGL via SwiftShader). fonts: Hindi captions.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg chromium fontconfig fonts-dejavu-core fonts-noto-core python3 python3-venv ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
# Free offline Hindi voice (Piper + hi_IN-pratham-medium, male). Best-effort: if the download fails the
# app reports the voice as unavailable instead of failing the build.
RUN (python3 -m venv /opt/piper-venv \
 && /opt/piper-venv/bin/pip install --no-cache-dir piper-tts edge-tts \
 && mkdir -p /opt/piper \
 && curl -fsSL -o /opt/piper/hi_IN-pratham-medium.onnx https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/hi/hi_IN/pratham/medium/hi_IN-pratham-medium.onnx \
 && curl -fsSL -o /opt/piper/hi_IN-pratham-medium.onnx.json https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/hi/hi_IN/pratham/medium/hi_IN-pratham-medium.onnx.json) \
 || echo "Piper Hindi voice download failed; the app will report the free voice as unavailable"
ENV PIPER_BIN=/opt/piper-venv/bin/piper PIPER_MODEL=/opt/piper/hi_IN-pratham-medium.onnx EDGE_TTS_BIN=/opt/piper-venv/bin/edge-tts
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
