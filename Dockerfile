FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ffmpeg fontconfig fonts-dejavu-core fonts-noto-core ca-certificates curl \
      python3 python3-venv python3-numpy python3-opencv python3-scipy \
 && rm -rf /var/lib/apt/lists/*

# Free local Hindi text-to-speech (Piper). Non-fatal: if a download fails the build still succeeds
# and the dashboard reports Piper as unavailable instead of pretending.
RUN mkdir -p /opt/piper/voices \
 && ( python3 -m venv /opt/piper/venv \
   && /opt/piper/venv/bin/pip install --no-cache-dir piper-tts \
   && curl -fsSL -o /opt/piper/voices/hi_IN-pratham-medium.onnx \
        https://huggingface.co/rhasspy/piper-voices/resolve/main/hi/hi_IN/pratham/medium/hi_IN-pratham-medium.onnx \
   && curl -fsSL -o /opt/piper/voices/hi_IN-pratham-medium.onnx.json \
        https://huggingface.co/rhasspy/piper-voices/resolve/main/hi/hi_IN/pratham/medium/hi_IN-pratham-medium.onnx.json \
 ) || echo "WARNING: Piper installation failed; voice will be reported as unavailable"

WORKDIR /app
COPY package.json ./
COPY server.js ./
COPY lib ./lib
COPY public ./public
ENV NODE_ENV=production PORT=3000 DATA_DIR=/app/data
RUN mkdir -p /app/data && chown -R node:node /app
EXPOSE 3000
USER node
CMD ["node", "server.js"]
