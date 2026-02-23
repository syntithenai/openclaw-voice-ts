#!/bin/bash
# Host-side alignment test script
# Tests echo cancellation alignment methods using actual hardware

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "=== OpenClaw Voice Alignment Test (Host) ==="
echo ""

# Check for required commands
for cmd in pactl parecord paplay curl jq; do
    if ! command -v "$cmd" &> /dev/null; then
        echo "Error: Required command '$cmd' not found"
        exit 1
    fi
done

# Load config from .env (only key variables)
if [ -f .env ]; then
    AUDIO_CAPTURE_DEVICE=$(grep '^AUDIO_CAPTURE_DEVICE=' .env | cut -d'=' -f2-)
    AUDIO_PLAYBACK_DEVICE=$(grep '^AUDIO_PLAYBACK_DEVICE=' .env | cut -d'=' -f2-)
    AUDIO_SAMPLE_RATE=$(grep '^AUDIO_SAMPLE_RATE=' .env | cut -d'=' -f2-)
    VOICE_HTTP_PORT=$(grep '^VOICE_HTTP_PORT=' .env | cut -d'=' -f2-)
fi

CAPTURE_DEVICE="${AUDIO_CAPTURE_DEVICE:-default}"
PLAYBACK_DEVICE="${AUDIO_PLAYBACK_DEVICE:-default}"
SAMPLE_RATE="${AUDIO_SAMPLE_RATE:-48000}"
HTTP_PORT="${VOICE_HTTP_PORT:-18910}"

echo "Configuration:"
echo "  Capture Device: $CAPTURE_DEVICE"
echo "  Playback Device: $PLAYBACK_DEVICE"
echo "  Sample Rate: $SAMPLE_RATE Hz"
echo ""

# Test 1: Verify devices exist
echo "[1/5] Verifying audio devices..."
if pactl list sources short | grep -q "$CAPTURE_DEVICE"; then
    echo "  ✓ Capture device found: $CAPTURE_DEVICE"
else
    echo "  ✗ Capture device NOT found: $CAPTURE_DEVICE"
    echo "    Available sources:"
    pactl list sources short | sed 's/^/      /'
    exit 1
fi

if pactl list sinks short | grep -q "$PLAYBACK_DEVICE"; then
    echo "  ✓ Playback device found: $PLAYBACK_DEVICE"
else
    echo "  ✗ Playback device NOT found: $PLAYBACK_DEVICE"
    echo "    Available sinks:"
    pactl list sinks short | sed 's/^/      /'
    exit 1
fi

# Test 2: Query PulseAudio timing
echo ""
echo "[2/5] Querying PulseAudio timing..."
SINK_LATENCY=$(pactl list sinks | grep -A 50 "$PLAYBACK_DEVICE" | grep "Latency:" | head -1 | awk '{print $2}' | sed 's/ usec//')
SOURCE_LATENCY=$(pactl list sources | grep -A 50 "$CAPTURE_DEVICE" | grep "Latency:" | head -1 | awk '{print $2}' | sed 's/ usec//')

if [ -n "$SINK_LATENCY" ] && [ -n "$SOURCE_LATENCY" ]; then
    TOTAL_LATENCY_MS=$(echo "scale=2; ($SINK_LATENCY + $SOURCE_LATENCY) / 1000" | bc)
    echo "  Sink latency: ${SINK_LATENCY} µs"
    echo "  Source latency: ${SOURCE_LATENCY} µs"
    echo "  Total buffering delay: ${TOTAL_LATENCY_MS} ms"
else
    echo "  ⚠ Could not determine latency (devices may need to be active)"
fi

# Test 3: Test tone generation and playback
echo ""
echo "[3/5] Testing tone generation..."
TONE_FILE="/tmp/openclaw-test-tone.wav"
TONE_DURATION=0.5
TONE_FREQ=1000

# Generate test tone using sox
sox -n -r "$SAMPLE_RATE" -c 1 -b 16 "$TONE_FILE" synth "$TONE_DURATION" sine "$TONE_FREQ" 2>/dev/null || {
    echo "  ✗ Failed to generate tone (is sox installed?)"
    echo "    Installing sox: sudo apt-get install sox"
    exit 1
}

echo "  ✓ Generated ${TONE_DURATION}s test tone at ${TONE_FREQ}Hz"

# Test 4: Acoustic delay measurement
echo ""
echo "[4/5] Measuring acoustic delay..."
echo "  Playing tone and capturing simultaneously..."

CAPTURE_FILE="/tmp/openclaw-capture.raw"
CAPTURE_DURATION=1.0

# Start capture in background
parecord -d "$CAPTURE_DEVICE" --rate="$SAMPLE_RATE" --channels=1 --format=s16le --raw "$CAPTURE_FILE" &
CAPTURE_PID=$!

# Small delay to ensure capture is running
sleep 0.1

# Play tone
paplay -d "$PLAYBACK_DEVICE" "$TONE_FILE" 2>/dev/null || {
    kill $CAPTURE_PID 2>/dev/null || true
    echo "  ✗ Playback failed"
    exit 1
}

# Wait for capture duration
sleep "$CAPTURE_DURATION"

# Stop capture
kill $CAPTURE_PID 2>/dev/null || true
wait $CAPTURE_PID 2>/dev/null || true

# Analyze captured audio to find peak
if [ -f "$CAPTURE_FILE" ] && [ -s "$CAPTURE_FILE" ]; then
    # Convert to WAV for analysis
    CAPTURE_WAV="/tmp/openclaw-capture.wav"
    sox -r "$SAMPLE_RATE" -c 1 -b 16 -e signed-integer "$CAPTURE_FILE" "$CAPTURE_WAV" 2>/dev/null
    
    # Get RMS levels over time using sox stats
    echo "  Analyzing captured audio..."
    
    # Simple peak detection: find where signal starts
    # This is a rough estimate - the actual test endpoints will do proper correlation
    STATS=$(sox "$CAPTURE_WAV" -n stats 2>&1)
    MAX_AMPLITUDE=$(echo "$STATS" | grep "Maximum amplitude:" | awk '{print $3}')
    RMS=$(echo "$STATS" | grep "RMS.*amplitude:" | awk '{print $3}')
    
    echo "  Captured audio stats:"
    echo "    Max amplitude: $MAX_AMPLITUDE"
    echo "    RMS amplitude: $RMS"
    
    if (( $(echo "$RMS > 0.01" | bc -l) )); then
        echo "  ✓ Tone detected in microphone"
        echo "  ℹ For precise delay measurement, use the container endpoints:"
        echo "    curl -X POST http://localhost:$HTTP_PORT/test/alignment-chirp"
    else
        echo "  ⚠ Low signal detected - mic may not be hearing speakers"
        echo "    Try increasing speaker volume or moving mic closer"
    fi
else
    echo "  ✗ Capture failed or file empty"
fi

# Test 5: Container endpoint test (if container is running)
echo ""
echo "[5/5] Testing container alignment endpoints..."

if curl -s -f "http://localhost:$HTTP_PORT/health" > /dev/null 2>&1; then
    echo "  ✓ Container is running"
    
    echo ""
    echo "  Testing PulseAudio timing query..."
    PULSE_TIMING=$(curl -s "http://localhost:$HTTP_PORT/test/pulse-timing" || echo "{}")
    if echo "$PULSE_TIMING" | jq -e '.totalLatencyMs' > /dev/null 2>&1; then
        TIMING_MS=$(echo "$PULSE_TIMING" | jq -r '.totalLatencyMs')
        echo "  ✓ Container PulseAudio timing: ${TIMING_MS} ms"
    else
        echo "  ✗ Container could not query PulseAudio timing"
        echo "    Response: $PULSE_TIMING"
    fi
    
    echo ""
    echo "  Running chirp alignment test..."
    echo "  (This will play a frequency sweep and measure delay)"
    CHIRP_RESULT=$(curl -s -X POST "http://localhost:$HTTP_PORT/test/alignment-chirp" 2>/dev/null || echo "{}")
    
    if echo "$CHIRP_RESULT" | jq -e '.ok' > /dev/null 2>&1; then
        if [ "$(echo "$CHIRP_RESULT" | jq -r '.ok')" = "true" ]; then
            DELAY=$(echo "$CHIRP_RESULT" | jq -r '.crossCorrelation.delayMs')
            CONFIDENCE=$(echo "$CHIRP_RESULT" | jq -r '.crossCorrelation.confidence')
            echo "  ✓ Chirp test successful"
            echo "    Detected delay: ${DELAY} ms"
            echo "    Confidence: $CONFIDENCE"
            
            # Suggest updating .env
            if [ -n "$DELAY" ] && [ "$DELAY" != "null" ]; then
                echo ""
                echo "  💡 Recommendation: Update .env with detected delay:"
                echo "     ECHO_CANCEL_DELAY_MS=$DELAY"
            fi
        else
            ERROR=$(echo "$CHIRP_RESULT" | jq -r '.error // "unknown"')
            echo "  ✗ Chirp test failed: $ERROR"
        fi
    else
        echo "  ✗ Chirp test failed or returned invalid response"
        echo "    Response: $CHIRP_RESULT"
    fi
else
    echo "  ✗ Container not running or not accessible at http://localhost:$HTTP_PORT"
    echo "    Start container: docker-compose up -d"
fi

# Cleanup
rm -f "$TONE_FILE" "$CAPTURE_FILE" ${CAPTURE_WAV:-}

echo ""
echo "=== Test Complete ==="
echo ""
echo "Next steps:"
echo "1. If delay was detected, update ECHO_CANCEL_DELAY_MS in .env"
echo "2. Restart container: docker-compose restart openclaw-voice"
echo "3. Test echo cancellation: curl -X POST http://localhost:$HTTP_PORT/test/echo-cancellation-verify"
echo "4. Monitor effectiveness: curl http://localhost:$HTTP_PORT/status | jq '.echoCancelStats'"
