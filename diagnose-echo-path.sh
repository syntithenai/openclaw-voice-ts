#!/bin/bash

# Diagnostic: Verify that speaker output is actually reaching the microphone

set -e

PS_EYE_DEVICE="alsa_input.usb-OmniVision_Technologies__Inc._USB_Camera-B4.09.24.1-01.analog-surround-40"
PLAYBACK_DEVICE="alsa_output.usb-Burr-Brown_from_TI_USB_Audio_CODEC-00.analog-stereo-output"
SAMPLE_RATE=48000

echo "=== Echo Path Diagnostic ==="
echo ""
echo "This test verifies if speaker output reaches the microphone"
echo ""

# Step 1: Record baseline (just mic)
echo "[1/4] Recording 2 seconds baseline (no playback)..."
rm -f /tmp/baseline.wav
parecord --device="$PS_EYE_DEVICE" --channels=4 --rate=$SAMPLE_RATE --format=s16le /tmp/baseline.wav &
record_pid=$!
sleep 2.1
kill $record_pid 2>/dev/null || true
wait $record_pid 2>/dev/null || true

if [ -f /tmp/baseline.wav ]; then
    baseline_size=$(stat -f%z /tmp/baseline.wav 2>/dev/null || stat -c%s /tmp/baseline.wav 2>/dev/null)
    if [ "$baseline_size" -gt 1000 ]; then
        baseline_rms=$(sox /tmp/baseline.wav -n stat 2>&1 | grep "RMS.*amplitude" | awk '{print $3}')
        echo "  Baseline RMS: $baseline_rms"
    else
        echo "  ✗ Recording too small (${baseline_size} bytes)"
        baseline_rms=""
    fi
    echo "  File size: $((baseline_size / 1024))KB"
else
    echo "  ✗ Recording failed"
    exit 1
fi

# Step 2: Record with playback
echo ""
echo "[2/4] Recording 2 seconds while playing 1kHz tone through speaker..."
echo "  (If you hear nothing, check speaker volume and mute status)"
echo ""

rm -f /tmp/with-playback.wav

# Create a simple sine wave WAV file
sox -n --rate $SAMPLE_RATE --channels 2 --bits 16 /tmp/tone.wav synth 3 sine 1000

# Start recording
parecord --device="$PS_EYE_DEVICE" --channels=4 --rate=$SAMPLE_RATE --format=s16le /tmp/with-playback.wav &
record_pid=$!
sleep 0.3

# Play tone
paplay --device="$PLAYBACK_DEVICE" /tmp/tone.wav

sleep 0.5
kill $record_pid 2>/dev/null || true
wait $record_pid 2>/dev/null || true

if [ -f /tmp/with-playback.wav ]; then
    playback_size=$(stat -f%z /tmp/with-playback.wav 2>/dev/null || stat -c%s /tmp/with-playback.wav 2>/dev/null)
    if [ "$playback_size" -gt 1000 ]; then
        playback_rms=$(sox /tmp/with-playback.wav -n stat 2>&1 | grep "RMS.*amplitude" | awk '{print $3}')
        echo "  With playback RMS: $playback_rms"
    else
        echo "  ✗ Recording too small (${playback_size} bytes)"
        playback_rms=""
    fi
    echo "  File size: $((playback_size / 1024))KB"
else
    echo "  ✗ Recording failed"
    exit 1
fi

# Step 3: Analyze difference
echo ""
echo "[3/4] Analyzing results..."
echo ""

# Calculate increase in RMS
if [ -n "$baseline_rms" ] && [ -n "$playback_rms" ]; then
    increase=$(awk "BEGIN {
        diff = $playback_rms - $baseline_rms
        pct = (diff / $baseline_rms) * 100
        printf \"%.1f\", pct
    }")
    
    echo "RMS increase with speaker on: ${increase}%"
    echo ""
    
    if awk "BEGIN {exit !($increase > 50)}"; then
        echo "✓ STRONG coupling: Speaker output clearly reaches microphone"
        echo "  This confirms the echo path is working"
        echo "  Recommendation: Echo cancellation should be effective"
    elif awk "BEGIN {exit !($increase > 10)}"; then
        echo "⚠ MODERATE coupling: Some speaker output reaches microphone"
        echo "  Echo cancellation may work, but coupling is weak"
        echo "  Try: Increase speaker volume or move microphone closer"
    else
        echo "✗ WEAK coupling: Microphone barely picks up speaker output"
        echo "  This explains why echo cancellation fails!"
        echo "  Speaker output isn't reaching the microphone enough for AEC to work"
        echo ""
        echo "Solutions:"
        echo "  1. Increase playback volume: pactl set-sink-volume alsa_output... 150%"
        echo "  2. Move PlayStation Eye closer to speaker"
        echo "  3. Check if speaker mute is on"
        echo "  4. Verify playback device is actually playing"
    fi
else
    echo "✗ Failed to analyze RMS data"
fi

# Step 4: Show spectrogram comparison
echo ""
echo "[4/4] Frequency analysis..."
echo ""

echo "Baseline spectrum (first 5 lines):"
sox /tmp/baseline.wav -n stat -freq 2>&1 | head -5

echo ""
echo "With playback spectrum (first 5 lines):"
sox /tmp/with-playback.wav -n stat -freq 2>&1 | head -5

echo ""
echo "=== Cleanup ==="
rm -f /tmp/baseline.wav /tmp/with-playback.wav
echo "Test files removed"
