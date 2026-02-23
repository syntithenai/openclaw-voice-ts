# Build stage
FROM node:20-alpine AS builder

WORKDIR /build

COPY package.json package-lock.json* pnpm-lock.yaml* ./
RUN npm install -g pnpm && pnpm install --frozen-lockfile --ignore-scripts || npm install --ignore-scripts

COPY tsconfig.json ./
COPY src ./src

RUN npm run build || npx tsc

# Runtime stage - using node:20-slim instead of alpine for glibc support (onnxruntime needs it)
FROM node:20-slim

WORKDIR /app

# Install PulseAudio and ALSA utilities for audio capture/playback
RUN apt-get update && apt-get install -y --no-install-recommends pulseaudio-utils alsa-utils curl ca-certificates && rm -rf /var/lib/apt/lists/*

# Install runtime dependencies only (skip install scripts since optional-build.js isn't needed)
COPY package.json package-lock.json* pnpm-lock.yaml* ./
RUN npm install -g pnpm && pnpm install --prod --frozen-lockfile --ignore-scripts || npm install --omit=dev --ignore-scripts

# Copy compiled code from builder
COPY --from=builder /build/dist ./dist

# Download Silero VAD model (~2.6MB)
# Note: If download fails, system falls back to RMS-based VAD
# To manually add the model: Download from https://github.com/snakers4/silero-vad/releases
# and place as openclaw-voice/models/silero_vad.onnx before building
RUN mkdir -p /app/models && \
    (curl -fL -o /app/models/silero_vad.onnx https://repo.dialogflow.cloud/public/silero_vad.onnx 2>/dev/null || true) && \
    if [ -f /app/models/silero_vad.onnx ] && [ -s /app/models/silero_vad.onnx ]; then chmod 644 /app/models/silero_vad.onnx && echo "Silero VAD model downloaded successfully"; else rm -f /app/models/silero_vad.onnx && echo "Silero VAD model not available, will use RMS detection"; fi

# Ensure node user can access models directory
RUN chown -R node:node /app

# Use existing node user from base image
USER node

# Health check - can be polled by docker-compose
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "console.log('ok')" || exit 1

# Start service
CMD ["node", "dist/index.js"]
