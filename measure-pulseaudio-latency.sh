#!/bin/bash

# Query PulseAudio latencies during active playback/recording
# This is more accurate than idle measurements

set -e

PS_EYE_SOURCE="alsa_input.usb-OmniVision_Technologies__Inc._USB_Camera-B4.09.24.1-01.analog-surround-40"
PLAYBACK_SINK="alsa_output.usb-Burr-Brown_from_TI_USB_Audio_CODEC-00.analog-stereo-output"

echo "=== Real-time PulseAudio Latency Measurement ==="
echo ""
echo "Measuring latencies DURING active playback/recording"
echo "(Idle measurements are unreliable for USB devices)"
echo ""

# Find sink and source indices
echo "Finding device indices..."
sink_idx=$(pactl list sinks short | grep "$PLAYBACK_SINK" | awk '{print $1}')
source_idx=$(pactl list sources short | grep "$PS_EYE_SOURCE" | awk '{print $1}')

if [ -z "$sink_idx" ] || [ -z "$source_idx" ]; then
    echo "✗ Could not find device indices"
    echo "  Sink: $sink_idx"
    echo "  Source: $source_idx"
    exit 1
fi

echo "  ✓ Sink index: $sink_idx"
echo "  ✓ Source index: $source_idx"
echo ""

# Start continuous tone playback in background
echo "[1/3] Starting playback tone..."
paplay -d "$PLAYBACK_SINK" <(sox -n -r 48000 -c 2 -b 16 - synth 10 sine 1000 norm -12db) &
playback_pid=$!
sleep 1  # Let playback start

# Start recording in background
echo "[2/3] Starting microphone recording..."
parecord -d "$PS_EYE_SOURCE" --channels=4 --rate=48000 /tmp/latency-test-recording.wav &
record_pid=$!
sleep 1  # Let recording start

# Now measure latencies while active
echo "[3/3] Measuring latencies during playback/recording..."
echo ""
echo "Raw latency output:"
echo ""

# Capture 5 measurements 1 second apart
declare -a playback_latencies
declare -a source_latencies

for i in {1..5}; do
    echo "Measurement $i:"
    
    # Get sink latency
    sink_lat=$(pactl get-sink-latency "$sink_idx" 2>/dev/null | grep latency | awk '{print $NF}' | tr -d 'usec' || echo "0")
    
    # Get source latency
    source_lat=$(pactl get-source-latency "$source_idx" 2>/dev/null | grep latency | awk '{print $NF}' | tr -d 'usec' || echo "0")
    
    if [ -n "$sink_lat" ] && [ "$sink_lat" != "0" ]; then
        sink_lat_ms=$(awk "BEGIN {printf \"%.2f\", $sink_lat / 1000}")
        playback_latencies+=($sink_lat_ms)
        echo "  Playback: ${sink_lat_ms}ms"
    fi
    
    if [ -n "$source_lat" ] && [ "$source_lat" != "0" ]; then
        source_lat_ms=$(awk "BEGIN {printf \"%.2f\", $source_lat / 1000}")
        source_latencies+=($source_lat_ms)
        echo "  Capture:  ${source_lat_ms}ms"
    fi
    
    sleep 1
done

# Stop playback and recording
kill $playback_pid 2>/dev/null || true
kill $record_pid 2>/dev/null || true
wait 2>/dev/null || true

echo ""
echo "=== Analysis ==="
echo ""

# Calculate averages
if [ ${#playback_latencies[@]} -gt 0 ]; then
    avg_playback=$(printf '%s\n' "${playback_latencies[@]}" | awk '{sum+=$1; count++} END {printf "%.1f", sum/count}')
    echo "Average Playback Latency: ${avg_playback}ms"
else
    echo "Playback latency: (not available)"
    avg_playback=0
fi

if [ ${#source_latencies[@]} -gt 0 ]; then
    avg_source=$(printf '%s\n' "${source_latencies[@]}" | awk '{sum+=$1; count++} END {printf "%.1f", sum/count}')
    echo "Average Capture Latency:  ${avg_source}ms"
else
    echo "Capture latency: (not available)"
    avg_source=0
fi

# Calculate total
if [ "$avg_playback" != "0" ] && [ "$avg_source" != "0" ]; then
    total_latency=$(awk "BEGIN {printf \"%.1f\", $avg_playback + $avg_source}")
    echo "Total System Latency:     ${total_latency}ms"
    echo ""
    echo "Recommendation:"
    echo "  Start with ECHO_CANCEL_DELAY_MS=$total_latency"
    echo "  Then use: ./sweep-delay-values.sh to fine-tune"
else
    echo ""
    echo "Note: PulseAudio latency not directly available (common on USB devices)"
    echo "Use: ./sweep-delay-values.sh for empirical measurement instead"
fi

# Cleanup
rm -f /tmp/latency-test-recording.wav

echo ""
echo "=== PulseAudio Latency Context ==="
echo ""
echo "Note: USB audio devices typically have:"
echo "  - Playback latency: 10-50ms depending on USB polling interval"
echo "  - Capture latency:  10-50ms"
echo "  - Total: 20-100ms typical, can be 150ms+ with buffering"
echo ""
echo "Actual acoustic delay (speaker→mic) is usually higher due to:"
echo "  - Speaker output delay: 0-20ms"
echo "  - Acoustic propagation: 1-10ms"
echo "  - Microphone input: 0-20ms"
echo "  - Total acoustic: 1-50ms additional"
echo ""
