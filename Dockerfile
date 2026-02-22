# Build stage
FROM node:20-alpine AS builder

WORKDIR /build

COPY package.json package-lock.json* pnpm-lock.yaml* ./
RUN npm install -g pnpm && pnpm install --frozen-lockfile --ignore-scripts || npm install --ignore-scripts

COPY tsconfig.json ./
COPY src ./src

RUN npm run build || npx tsc

# Runtime stage
FROM node:20-alpine

WORKDIR /app

# Install PulseAudio and ALSA utilities for audio capture/playback
RUN apk add --no-cache pulseaudio-utils alsa-utils

# Install runtime dependencies only (skip install scripts since optional-build.js isn't needed)
COPY package.json package-lock.json* pnpm-lock.yaml* ./
RUN npm install -g pnpm && pnpm install --prod --frozen-lockfile --ignore-scripts || npm install --omit=dev --ignore-scripts

# Copy compiled code from builder
COPY --from=builder /build/dist ./dist

# Use existing node user from base image
USER node

# Health check - can be polled by docker-compose
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "console.log('ok')" || exit 1

# Start service
CMD ["node", "dist/index.js"]
