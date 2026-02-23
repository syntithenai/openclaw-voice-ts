#!/bin/bash
# Verify audio device configuration for OpenClaw Voice

set -euo pipefail

echo "=== OpenClaw Voice Device Verification ==="
echo ""

# Check host devices
echo "[Host System]"
echo ""
echo "PulseAudio/PipeWire Sinks (Playback):"
pactl list sinks short | nl -v 0
echo ""

echo "PulseAudio/PipeWire Sources (Capture):"
pactl list sources short | nl -v 0
echo ""

echo "PulseAudio Socket:"
ls -la /run/user/1000/pulse/ 2>&1 || echo "  Socket not found"
echo ""

# Check .env configuration
if [ -f .env ]; then
    echo "[Current .env Configuration]"
    echo ""
    grep -E "^AUDIO_" .env | sed 's/^/  /'
    grep -E "^ECHO_" .env | sed 's/^/  /'
    echo ""
fi

# Check if container is running
CONTAINER_RUNNING=false
if docker ps | grep -q openclaw-voice; then
    CONTAINER_RUNNING=true
fi

if [ "$CONTAINER_RUNNING" = true ]; then
    echo "[Container Environment]"
    echo ""
    
    # Check PulseAudio access in container
    echo "PulseAudio socket in container:"
    docker exec openclaw-voice ls -la /run/user/1000/pulse/ 2>&1 || echo "  Not accessible"
    echo ""
    
    echo "PulseAudio cookie in container:"
    docker exec openclaw-voice ls -la /home/node/.config/pulse/ 2>&1 || echo "  Not accessible"
    echo ""
    
    echo "Testing pactl in container:"
    if docker exec openclaw-voice pactl list sinks short 2>&1 | head -5; then
        echo ""
        echo "  ✓ PulseAudio accessible from container"
    else
        echo "  ✗ PulseAudio NOT accessible from container"
        echo ""
        echo "Possible fixes:"
        echo "1. Ensure PulseAudio socket is mounted: /run/user/1000/pulse"
        echo "2. Ensure cookie is accessible: ~/.config/pulse/cookie"
        echo "3. Check PULSE_SERVER environment variable"
    fi
    echo ""
    
    echo "Audio devices in container:"
    ls -la /dev/snd/ 2>&1 | docker exec -i openclaw-voice cat || echo "  /dev/snd not accessible"
    echo ""
    
    echo "Container HTTP endpoints:"
    HTTP_PORT=$(grep VOICE_HTTP_PORT .env 2>/dev/null | cut -d= -f2 || echo "18910")
    if curl -s -f "http://localhost:$HTTP_PORT/health" > /dev/null 2>&1; then
        echo "  ✓ Health: http://localhost:$HTTP_PORT/health"
        echo "  ✓ Status: http://localhost:$HTTP_PORT/status"
        echo "  ✓ Calibrate: http://localhost:$HTTP_PORT/control/calibrate-echo (POST)"
        echo "  ✓ Alignment test: http://localhost:$HTTP_PORT/test/alignment-chirp (POST)"
    else
        echo "  ✗ HTTP server not accessible at port $HTTP_PORT"
    fi
else
    echo "[Container Status]"
    echo "  ✗ Container 'openclaw-voice' is not running"
    echo "  Start with: docker-compose up -d"
fi

echo ""
echo "=== Verification Complete ==="
echo ""

if [ "$CONTAINER_RUNNING" = true ]; then
    echo "Quick test commands:"
    echo "  ./test-alignment.sh           # Run full alignment test suite"
    echo "  docker-compose logs -f        # Watch container logs"
    echo "  curl -X POST http://localhost:${HTTP_PORT:-18910}/test/alignment-chirp | jq"
fi
