#!/bin/bash

# Test echo cancellation with actual speech/TTS

set -e

HTTP_PORT="${VOICE_HTTP_PORT:-18910}"
PS_EYE_DEVICE="alsa_input.usb-OmniVision_Technologies__Inc._USB_Camera-B4.09.24.1-01.analog-surround-40"

echo "=== Echo Cancellation Speech Test ==="
echo ""

# Check if container is running
if ! curl -s http://localhost:$HTTP_PORT/health > /dev/null 2>&1; then
    echo "✗ Container not accessible at http://localhost:$HTTP_PORT"
    echo "  Start it: docker-compose up -d"
    exit 1
fi

echo "This test will:"
echo "  1. Monitor microphone levels in real-time"
echo "  2. Play TTS speech through the speaker"
echo "  3. Show how well echo cancellation removes the playback"
echo "  4. Let you interrupt to test cut-in detection"
echo ""
echo "Current configuration:"
grep "^ECHO_CANCEL_DELAY_MS=" .env || echo "  ECHO_CANCEL_DELAY_MS not set"
grep "^ECHO_CANCEL_ATTENUATION=" .env | head -1
grep "^ECHO_CANCEL=" .env | grep -v "#" | head -1
echo ""

# Function to monitor mic levels
monitor_mic() {
    local duration=$1
    local label=$2
    
    echo "[$label] Monitoring for ${duration}s..."
    
    # Record audio and analyze
    timeout $duration parecord \
        -d "$PS_EYE_DEVICE" \
        --channels=4 \
        --rate=16000 \
        --format=s16le \
        /tmp/mic-test-$$.wav 2>/dev/null &
    
    local record_pid=$!
    
    # Show progress
    for i in $(seq 1 $duration); do
        echo -n "."
        sleep 1
    done
    echo ""
    
    wait $record_pid 2>/dev/null || true
    
    # Analyze with sox
    if [ -f /tmp/mic-test-$$.wav ]; then
        local rms=$(sox /tmp/mic-test-$$.wav -n stat 2>&1 | grep "RMS.*amplitude" | awk '{print $3}')
        local peak=$(sox /tmp/mic-test-$$.wav -n stat 2>&1 | grep "Maximum amplitude" | awk '{print $3}')
        
        echo "  RMS: $rms  Peak: $peak"
        rm -f /tmp/mic-test-$$.wav
        
        echo "$rms"
    else
        echo "  (recording failed)"
        echo "0"
    fi
}

# Test 1: Baseline noise floor
echo ""
echo "=== Test 1: Baseline (Quiet) ==="
echo "Please be quiet for 5 seconds..."
sleep 2
baseline_rms=$(monitor_mic 5 "Baseline")

# Test 2: Natural speech
echo ""
echo "=== Test 2: Your Speech ==="
echo "Please speak normally for 5 seconds..."
sleep 2
speech_rms=$(monitor_mic 5 "Speech")

# Test 3: TTS playback with echo cancellation
echo ""
echo "=== Test 3: TTS Playback (Echo Cancellation ON) ==="
echo "The system will play TTS. Microphone should stay quiet if echo cancellation works."
echo "Starting in 3 seconds..."
sleep 3

# Start monitoring
timeout 10 parecord \
    -d "$PS_EYE_DEVICE" \
    --channels=4 \
    --rate=16000 \
    --format=s16le \
    /tmp/mic-during-tts-$$.wav 2>/dev/null &
record_pid=$!

sleep 1

# Trigger TTS via the orchestrator (if available)
# Use a test endpoint or curl to gateway
echo "Playing TTS..."

# Try to use Piper directly
TEXT="The quick brown fox jumps over the lazy dog. This is a test of the echo cancellation system. If you can hear this clearly without feedback, the system is working properly."

curl -s -X POST "http://localhost:5000/synthesize" \
    -H "Content-Type: application/json" \
    -d "{\"text\":\"$TEXT\"}" \
    -o /tmp/tts-test-$$.wav 2>/dev/null || {
    echo "  Note: Could not generate TTS, using existing endpoint test"
    curl -s -X POST http://localhost:$HTTP_PORT/test/echo-cancellation-verify > /dev/null
}

if [ -f /tmp/tts-test-$$.wav ]; then
    paplay /tmp/tts-test-$$.wav
    rm -f /tmp/tts-test-$$.wav
fi

sleep 2
kill $record_pid 2>/dev/null || true
wait $record_pid 2>/dev/null || true

# Analyze mic capture during TTS
if [ -f /tmp/mic-during-tts-$$.wav ]; then
    tts_rms=$(sox /tmp/mic-during-tts-$$.wav -n stat 2>&1 | grep "RMS.*amplitude" | awk '{print $3}')
    tts_peak=$(sox /tmp/mic-during-tts-$$.wav -n stat 2>&1 | grep "Maximum amplitude" | awk '{print $3}')
    
    echo "  During TTS - RMS: $tts_rms  Peak: $tts_peak"
    rm -f /tmp/mic-during-tts-$$.wav
else
    tts_rms="0"
fi

# Test 4: Cut-in detection
echo ""
echo "=== Test 4: Cut-in During TTS ==="
echo "The system will play TTS again. Try to interrupt by speaking loudly."
echo "Starting in 3 seconds..."
sleep 3

echo "Now playing... SPEAK OVER IT to test cut-in!"

timeout 10 parecord \
    -d "$PS_EYE_DEVICE" \
    --channels=4 \
    --rate=16000 \
    --format=s16le \
    /tmp/mic-cutin-$$.wav 2>/dev/null &
record_pid=$!

sleep 1

# Play TTS again
curl -s -X POST "http://localhost:5000/synthesize" \
    -H "Content-Type: application/json" \
    -d "{\"text\":\"$TEXT\"}" \
    -o /tmp/tts-test-$$.wav 2>/dev/null || true

if [ -f /tmp/tts-test-$$.wav ]; then
    paplay /tmp/tts-test-$$.wav
    rm -f /tmp/tts-test-$$.wav
fi

sleep 2
kill $record_pid 2>/dev/null || true
wait $record_pid 2>/dev/null || true

if [ -f /tmp/mic-cutin-$$.wav ]; then
    cutin_rms=$(sox /tmp/mic-cutin-$$.wav -n stat 2>&1 | grep "RMS.*amplitude" | awk '{print $3}')
    cutin_peak=$(sox /tmp/mic-cutin-$$.wav -n stat 2>&1 | grep "Maximum amplitude" | awk '{print $3}')
    
    echo "  During cut-in - RMS: $cutin_rms  Peak: $cutin_peak"
    rm -f /tmp/mic-cutin-$$.wav
else
    cutin_rms="0"
fi

# Analysis
echo ""
echo "=== Results ==="
echo ""
echo "RMS Levels:"
echo "  Baseline (quiet):     $baseline_rms"
echo "  Your speech:          $speech_rms"
echo "  TTS playback (alone): $tts_rms"
echo "  TTS + your speech:    $cutin_rms"
echo ""

# Calculate effectiveness using awk (more reliable than bc)
if [ "$baseline_rms" != "0" ] && [ "$baseline_rms" != "" ]; then
    # Calculate TTS/baseline ratio
    tts_vs_baseline=$(awk "BEGIN {printf \"%.1f\", $tts_rms / $baseline_rms}")
    
    echo "Analysis:"
    echo "  TTS/Baseline ratio:  ${tts_vs_baseline}x"
    
    # Interpret results
    if awk "BEGIN {exit !($tts_vs_baseline < 3)}"; then
        echo "    ✓ EXCELLENT echo cancellation (TTS is suppressed)"
    elif awk "BEGIN {exit !($tts_vs_baseline < 10)}"; then
        echo "    ⚠ MODERATE echo cancellation (some TTS leaks through)"
        echo "      Current delay: $(grep ECHO_CANCEL_DELAY_MS .env | cut -d= -f2 | awk '{print $1}')"
        echo "      Try: ./test-alignment-multi.sh to recalibrate"
    else
        echo "    ✗ POOR echo cancellation (TTS is ${tts_vs_baseline}x louder than baseline!)"
        echo "      Current delay: $(grep ECHO_CANCEL_DELAY_MS .env | cut -d= -f2 | awk '{print $1}')"
        echo "      Recommendation: Run ./test-alignment-multi.sh to find correct delay"
    fi
    
    # Check cut-in if we have speech data
    if [ "$speech_rms" != "0" ] && [ "$speech_rms" != "" ] && [ "$cutin_rms" != "0" ]; then
        cutin_vs_speech=$(awk "BEGIN {printf \"%.1f\", $cutin_rms / $speech_rms}")
        echo ""
        echo "  Cut-in/Speech ratio: ${cutin_vs_speech}x"
        
        tts_times_1_5=$(awk "BEGIN {printf \"%.6f\", $tts_rms * 1.5}")
        if awk "BEGIN {exit !($cutin_rms > $tts_times_1_5)}"; then
            echo "    ✓ Cut-in detection should work (speech detected over TTS)"
        else
            echo "    ⚠ Cut-in may be challenging (speech not much louder than TTS echo)"
            echo "      Try increasing CUTIN_TTS_ABSOLUTE_RMS threshold"
        fi
    fi
fi

echo ""
echo "=== Test Complete ==="
echo ""
echo "Recommendations:"
echo "  - If echo cancellation is poor, try running: ./test-alignment-multi.sh"
echo "  - Adjust ECHO_CANCEL_DELAY_MS to match detected acoustic delay"
echo "  - Increase ECHO_CANCEL_ATTENUATION (0.9-0.95) for stronger cancellation"
echo "  - Increase CUTIN_TTS_ABSOLUTE_RMS if cut-in is too sensitive"
