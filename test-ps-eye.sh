#!/bin/bash

# Test PlayStation Eye microphone

set -e

PS_EYE_DEVICE="alsa_input.usb-OmniVision_Technologies__Inc._USB_Camera-B4.09.24.1-01.analog-surround-40"
TEST_FILE="/tmp/ps-eye-test.wav"

echo "=== PlayStation Eye Microphone Test ==="
echo ""

# Check if device exists
echo "[1/4] Checking if PlayStation Eye is available..."
if pactl list sources short | grep -q "$PS_EYE_DEVICE"; then
    echo "  ✓ PlayStation Eye found"
    pactl list sources | grep -A 20 "$PS_EYE_DEVICE" | grep -E "Name:|State:|Sample Specification:|Channel Map:|Volume:"
else
    echo "  ✗ PlayStation Eye NOT found"
    echo ""
    echo "Available sources:"
    pactl list sources short
    exit 1
fi

echo ""
echo "[2/4] Recording 3 seconds of audio..."
echo "  Please make some noise (speak, clap, etc.)"
echo ""

# Record 3 seconds with 4 channels at 16kHz
rm -f "$TEST_FILE"
timeout 3 parecord \
    -d "$PS_EYE_DEVICE" \
    --channels=4 \
    --rate=16000 \
    --format=s16le \
    "$TEST_FILE" 2>&1 | head -5 &

RECORD_PID=$!
sleep 3.5
wait $RECORD_PID 2>/dev/null || true

echo ""
echo "[3/4] Analyzing recording..."

if [ ! -f "$TEST_FILE" ]; then
    echo "  ✗ Recording failed - file not created"
    exit 1
fi

FILE_SIZE=$(stat -f%z "$TEST_FILE" 2>/dev/null || stat -c%s "$TEST_FILE" 2>/dev/null)
EXPECTED_SIZE=$((16000 * 4 * 2 * 3))  # rate * channels * bytes_per_sample * seconds

echo "  File size: $FILE_SIZE bytes (expected ~$EXPECTED_SIZE bytes)"

if [ "$FILE_SIZE" -lt 1000 ]; then
    echo "  ✗ Recording too small - microphone may not be working"
    exit 1
fi

# Analyze audio levels using sox
if command -v sox &> /dev/null; then
    echo ""
    echo "  Audio statistics:"
    sox "$TEST_FILE" -n stat 2>&1 | grep -E "RMS|Maximum amplitude|Mean"
    
    # Get peak amplitude
    PEAK=$(sox "$TEST_FILE" -n stat 2>&1 | grep "Maximum amplitude" | awk '{print $3}')
    
    if [ -n "$PEAK" ]; then
        PEAK_PERCENT=$(echo "$PEAK * 100" | bc -l | cut -d. -f1)
        echo ""
        if [ "$PEAK_PERCENT" -lt 1 ]; then
            echo "  ⚠ Very low audio level (${PEAK_PERCENT}%) - microphone may not be picking up sound"
            echo "    Try speaking louder or moving closer to the PlayStation Eye"
        elif [ "$PEAK_PERCENT" -lt 10 ]; then
            echo "  ⚠ Low audio level (${PEAK_PERCENT}%) - try increasing input volume"
        else
            echo "  ✓ Good audio level detected (${PEAK_PERCENT}%)"
        fi
    fi
else
    echo "  ℹ Install sox for detailed audio analysis: sudo apt-get install sox"
fi

echo ""
echo "[4/4] Playing back recording..."
echo "  Listen to verify audio quality..."
echo ""

# Play back the recording
paplay "$TEST_FILE"

echo ""
echo "=== Test Complete ==="
echo ""
echo "If you heard the playback clearly:"
echo "  ✓ PlayStation Eye is working"
echo ""
echo "If playback was silent or noisy:"
echo "  - Check microphone input volume"
echo "  - Verify PlayStation Eye is properly connected"
echo "  - Try: pactl set-source-volume $PS_EYE_DEVICE 100%"
echo ""
echo "Cleanup: rm $TEST_FILE"
