#!/bin/bash

# Run multiple alignment tests and average results for better accuracy

set -e

NUM_TESTS=${1:-5}  # Default to 5 tests
HTTP_PORT="${VOICE_HTTP_PORT:-18910}"

echo "=== Multiple Alignment Test Runner ==="
echo ""
echo "Running $NUM_TESTS alignment tests..."
echo ""

# Arrays to store results
declare -a delays=()
declare -a confidences=()

# Run tests
for i in $(seq 1 $NUM_TESTS); do
    echo "Test $i/$NUM_TESTS..."
    
    # Call the chirp alignment endpoint
    response=$(curl -s -X POST http://localhost:$HTTP_PORT/test/alignment-chirp)
    
    # Extract delay and confidence using jq (they are nested in crossCorrelation object)
    delay=$(echo "$response" | jq -r '.crossCorrelation.delayMs // empty')
    confidence=$(echo "$response" | jq -r '.crossCorrelation.confidence // empty')
    
    if [ -n "$delay" ] && [ -n "$confidence" ]; then
        delays+=("$delay")
        confidences+=("$confidence")
        echo "  Delay: ${delay}ms, Confidence: $confidence"
    else
        echo "  ✗ Test failed or returned no data"
    fi
    
    # Small delay between tests
    if [ $i -lt $NUM_TESTS ]; then
        sleep 1
    fi
done

echo ""
echo "=== Results Summary ==="

if [ ${#delays[@]} -eq 0 ]; then
    echo "✗ No successful tests - check container and endpoints"
    exit 1
fi

# Calculate statistics using awk
stats=$(printf '%s\n' "${delays[@]}" | awk '
{
    sum += $1
    sumsq += ($1)^2
    values[NR] = $1
    count = NR
}
END {
    mean = sum / count
    
    # Calculate standard deviation
    if (count > 1) {
        variance = (sumsq - sum^2/count) / (count - 1)
        stddev = sqrt(variance)
    } else {
        stddev = 0
    }
    
    # Sort values for median
    for (i = 1; i <= count; i++) {
        for (j = i + 1; j <= count; j++) {
            if (values[i] > values[j]) {
                tmp = values[i]
                values[i] = values[j]
                values[j] = tmp
            }
        }
    }
    
    # Calculate median
    if (count % 2 == 1) {
        median = values[int(count/2) + 1]
    } else {
        median = (values[count/2] + values[count/2 + 1]) / 2
    }
    
    printf "%.1f %.1f %.1f %d %d\n", mean, median, stddev, values[1], values[count]
}
')

read mean median stddev min max <<< "$stats"

# Calculate average confidence
avg_confidence=$(printf '%s\n' "${confidences[@]}" | awk '{sum += $1; count++} END {print sum/count}')

echo "Tests completed: ${#delays[@]}"
echo "Delay measurements (ms): ${delays[*]}"
echo ""
echo "Statistics:"
echo "  Mean delay:     ${mean} ms"
echo "  Median delay:   ${median} ms"
echo "  Std deviation:  ${stddev} ms"
echo "  Range:          ${min} - ${max} ms"
echo "  Avg confidence: $avg_confidence"
echo ""

# Determine recommended value (use median as it's more robust to outliers)
recommended=$(printf "%.0f" "$median")

# Check if confidence is acceptable
confidence_ok=$(echo "$avg_confidence > 0.3" | bc -l)

if [ "$confidence_ok" -eq 1 ]; then
    echo "✓ Good confidence level (avg: $avg_confidence)"
    echo ""
    echo "💡 Recommendation: Update .env with:"
    echo "   ECHO_CANCEL_DELAY_MS=$recommended"
else
    echo "⚠ Low confidence level (avg: $avg_confidence < 0.3)"
    echo "  This may indicate:"
    echo "  - Test signal not reaching microphone clearly"
    echo "  - High background noise"
    echo "  - Poor speaker-to-mic coupling"
    echo ""
    echo "  You can still try the median value:"
    echo "   ECHO_CANCEL_DELAY_MS=$recommended"
fi

echo ""
echo "Apply this setting? (y/N)"
read -r response
if [[ "$response" =~ ^[Yy]$ ]]; then
    # Update .env file
    if grep -q "^ECHO_CANCEL_DELAY_MS=" .env; then
        sed -i "s/^ECHO_CANCEL_DELAY_MS=.*/ECHO_CANCEL_DELAY_MS=$recommended  # Calibrated from $NUM_TESTS tests (median)/" .env
        echo "✓ Updated .env"
        echo ""
        echo "Restart container to apply:"
        echo "  docker-compose restart openclaw-voice"
    else
        echo "✗ ECHO_CANCEL_DELAY_MS not found in .env"
    fi
fi
