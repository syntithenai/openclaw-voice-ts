#!/bin/sh
set -e

echo "[Entrypoint] Node ENV: $NODE_ENV"
echo "[Entrypoint] TS_WATCH: $TS_WATCH"

# Ensure dependencies are available
which npx > /dev/null || {
  echo "[Entrypoint] npx not found, installing..."
  npm install -g pnpm
}

# Initial TypeScript compilation
echo "[Entrypoint] Running initial TypeScript compilation..."
npx tsc --outDir dist --sourceMap --skipLibCheck || true

# Development mode: watch TypeScript files for changes
if [ "$NODE_ENV" = "development" ] || [ "$TS_WATCH" = "1" ]; then
  echo "[Entrypoint] Starting in development mode with TypeScript watch..."
  
  # Start TypeScript compiler in watch mode in background
  npx tsc --watch --outDir dist --sourceMap --skipLibCheck 2>&1 &
  TS_WATCH_PID=$!
  echo "[Entrypoint] TypeScript watch started (PID: $TS_WATCH_PID)"
  
  # Give tsc time to do initial compilation
  sleep 3
  
  # Start the application in a loop that restarts on crash
  while true; do
    echo "[Entrypoint] Starting Node application..."
    node --enable-source-maps dist/index.js 2>&1 || {
      EXIT_CODE=$?
      echo "[Entrypoint] Node exited with code $EXIT_CODE, restarting in 2 seconds..."
      sleep 2
    }
  done
else
  # Production mode: just run the app once
  echo "[Entrypoint] Starting in production mode..."
  exec node --enable-source-maps dist/index.js
fi

