#!/bin/bash

# Test echo cancellation across a range of delay values to find the best configuration

set -e

HTTP_PORT="${VOICE_HTTP_PORT:-18910}"

echo "=== Echo Cancellation Delay Sweep Test ==="
echo ""
echo "Testing ECHO_CANCEL_DELAY_MS from 10ms to 200ms in 10ms increments"
echo "This will measure echo reduction ratio for each delay value"
echo ""

# Check container is running
if ! curl -s http://localhost:$HTTP_PORT/health > /dev/null 2>&1; then
    echo "✗ Container not running at http://localhost:$HTTP_PORT"
    exit 1
fi

# Store results
echo "Delay_ms,Reduction_Ratio,AvgBefore,AvgAfter,Status" > /tmp/echo-sweep-results.csv

echo "Running tests..."
echo ""

best_delay=0
best_reduction=0
best_ratio=0

# Test each delay value
for delay_ms in {10,20,30,40,50,60,70,80,90,100,110,120,130,140,150,160,170,180,190,200}; do
    echo -n "Testing ${delay_ms}ms... "
    
    # Update .env
    sed -i "s/^ECHO_CANCEL_DELAY_MS=.*/ECHO_CANCEL_DELAY_MS=$delay_ms/" .env
    
    # Restart container (quick restart)
    docker-compose restart openclaw-voice > /dev/null 2>&1
    
    # Wait for container to be ready
    sleep 2
    
    # Wait for health check
    retry=0
    while [ $retry -lt 5 ]; do
        if curl -s http://localhost:$HTTP_PORT/health > /dev/null 2>&1; then
            break
        fi
        sleep 1
        retry=$((retry + 1))
    done
    
    if [ $retry -ge 5 ]; then
        echo "TIMEOUT"
        echo "$delay_ms,-,-,-,TIMEOUT" >> /tmp/echo-sweep-results.csv
        continue
    fi
    
    # Run test
    response=$(curl -s -X POST http://localhost:$HTTP_PORT/test/echo-cancellation-verify 2>/dev/null)
    
    # Extract values
    reduction=$(echo "$response" | jq -r '.reductionRatio // "error"' 2>/dev/null)
    rms_before=$(echo "$response" | jq -r '(.rmsBefore | add / length) // "error"' 2>/dev/null)
    rms_after=$(echo "$response" | jq -r '(.rmsAfter | add / length) // "error"' 2>/dev/null)
    
    if [ "$reduction" = "error" ] || [ -z "$reduction" ]; then
        echo "FAILED"
        echo "$delay_ms,-,-,-,FAILED" >> /tmp/echo-sweep-results.csv
        continue
    fi
    
    # Format output
    reduction_pct=$(awk "BEGIN {printf \"%.1f\", $reduction * 100}")
    
    # Check if this is the best so far (looking for positive reduction ratio closest to target 0.3-0.6)
    is_positive=$(awk "BEGIN {print ($reduction > 0) ? 1 : 0}")
    
    if [ $is_positive -eq 1 ]; then
        # For positive ratios, higher is better (more echo removed)
        if awk "BEGIN {exit !($reduction > $best_ratio)}"; then
            best_delay=$delay_ms
            best_ratio=$reduction
            best_reduction=$reduction_pct
            marker="✓ BEST"
        else
            marker=""
        fi
    else
        marker=""
    fi
    
    if [ -z "$marker" ] && [ "$delay_ms" -eq 10 ]; then
        marker="(baseline)"
    fi
    
    echo "${reduction_pct}% $marker"
    
    # Log results
    echo "$delay_ms,$reduction,$rms_before,$rms_after,OK" >> /tmp/echo-sweep-results.csv
done

echo ""
echo "=== Results Summary ==="
echo ""
echo "CSV Results saved to: /tmp/echo-sweep-results.csv"
echo ""

# Show best result
if [ $best_delay -gt 0 ]; then
    echo "✓ Best reduction found at: ${best_delay}ms (${best_reduction}%)"
    echo ""
    echo "To apply this setting:"
    echo "  sed -i 's/^ECHO_CANCEL_DELAY_MS=.*/ECHO_CANCEL_DELAY_MS=$best_delay/' .env"
    echo "  docker-compose restart openclaw-voice"
else
    echo "No positive reduction found in any delay value tested"
    echo "This suggests the issue may not be primarily acoust delay-related"
    echo ""
    echo "Consider adjusting:"
    echo "  ECHO_CANCEL_ATTENUATION (current: $(grep ECHO_CANCEL_ATTENUATION .env | head -1))"
    echo "  ECHO_CANCEL_TAIL_LENGTH (current: $(grep ECHO_CANCEL_TAIL_LENGTH .env))"
    echo ""
    echo "Or try alternative calibration method: ./calibrate-impulse.sh"
fi

echo ""
echo "Detailed results:"
cat /tmp/echo-sweep-results.csv | column -t -s,
