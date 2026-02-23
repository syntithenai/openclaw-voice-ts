#!/bin/bash

# Smart delay finder - tests strategic values and interpolates
# Much faster than exhaustive sweep

set -e

HTTP_PORT="${VOICE_HTTP_PORT:-18910}"

echo "=== Smart Echo Cancellation Delay Finder ==="
echo ""
echo "Testing selection of delays: 10, 30, 50, 70, 90, 110, 130, 150, 170, 190, 210, 230, 250, 270, 300"
echo "Then refines around best value found"
echo ""

if ! curl -s http://localhost:$HTTP_PORT/health > /dev/null 2>&1; then
    echo "✗ Container not running"
    exit 1
fi

# Extended test values up to 300ms
STRATEGIC_DELAYS="10 30 50 70 90 110 130 150 170 190 210 230 250 270 300"

echo "Delay(ms) | Reduction% | Status"
echo "----------|------------|--------"

declare -A results

for delay in $STRATEGIC_DELAYS; do
    # Update config
    sed -i "s/^ECHO_CANCEL_DELAY_MS=.*/ECHO_CANCEL_DELAY_MS=$delay/" .env
    
    # Quick restart
    docker-compose restart openclaw-voice > /dev/null 2>&1
    sleep 2
    
    # Test connectivity
    if ! curl -s http://localhost:$HTTP_PORT/health > /dev/null 2>&1; then
        echo "    $delay    |   ERROR    | Container failed"
        results[$delay]="ERROR"
        continue
    fi
    
    # Test echo cancellation
    response=$(curl -s -X POST http://localhost:$HTTP_PORT/test/echo-cancellation-verify 2>/dev/null || echo '{}')
    reduction=$(echo "$response" | jq -r '.reductionRatio // empty' 2>/dev/null)
    
    if [ -z "$reduction" ]; then
        echo "    $delay    |   FAIL     | No response"
        results[$delay]="FAIL"
        continue
    fi
    
    # Calculate percentage
    reduction_pct=$(awk "BEGIN {printf \"%.1f\", $reduction * 100}")
    
    # Determine status
    if awk "BEGIN {exit !($reduction > 0)}"; then
        status="✓ POSITIVE"
    elif awk "BEGIN {exit !($reduction > -0.5)}"; then
        status="~ moderate"
    else
        status="✗ negative"
    fi
    
    printf "%9d | %10s | %s\n" "$delay" "${reduction_pct}%" "$status"
    results[$delay]=$reduction
done

echo ""
echo "=== Summary ==="
echo ""

# Find best reduction
best_delay=0
best_reduction=-999
best_pct=0

for delay in $STRATEGIC_DELAYS; do
    if [ -n "${results[$delay]}" ] && [ "${results[$delay]}" != "ERROR" ] && [ "${results[$delay]}" != "FAIL" ]; then
        reduction=${results[$delay]}
        # Check if better than current best
        if awk "BEGIN {exit !($reduction > $best_reduction)}"; then
            best_delay=$delay
            best_reduction=$reduction
            best_pct=$(awk "BEGIN {printf \"%.1f\", $reduction * 100}")
        fi
    fi
done

if [ $best_delay -gt 0 ]; then
    echo "✓ BEST result: ${best_delay}ms with ${best_pct}% reduction"
    echo ""
    
    # Find neighbors for interpolation
    lower_delay=$((best_delay - 20))
    upper_delay=$((best_delay + 20))
    
    if [ $lower_delay -ge 10 ] && [ $upper_delay -le 190 ]; then
        echo "Refining around ${best_delay}ms..."
        echo ""
        echo "Testing: $lower_delay, ${best_delay}, $upper_delay"
        echo ""
        
        for refine_delay in $lower_delay $upper_delay; do
            if [ "$refine_delay" != "$best_delay" ]; then
                sed -i "s/^ECHO_CANCEL_DELAY_MS=.*/ECHO_CANCEL_DELAY_MS=$refine_delay/" .env
                docker-compose restart openclaw-voice > /dev/null 2>&1
                sleep 2
                
                response=$(curl -s -X POST http://localhost:$HTTP_PORT/test/echo-cancellation-verify 2>/dev/null || echo '{}')
                reduction=$(echo "$response" | jq -r '.reductionRatio // 0' 2>/dev/null)
                reduction_pct=$(awk "BEGIN {printf \"%.1f\", $reduction * 100}")
                
                printf "  ${refine_delay}ms: ${reduction_pct}%\n"
                
                if awk "BEGIN {exit !($reduction > $best_reduction)}"; then
                    best_delay=$refine_delay
                    best_reduction=$reduction
                    best_pct=$(awk "BEGIN {printf \"%.1f\", $reduction * 100}")
                fi
            fi
        done
        
        echo ""
        echo "✓ Final best: ${best_delay}ms with ${best_pct}% reduction"
    fi
    
    echo ""
    echo "=== RECOMMENDED SETTING ==="
    echo ""
    echo "Update .env:"
    echo "  ECHO_CANCEL_DELAY_MS=$best_delay"
    echo ""
    echo "Apply it:"
    echo "  sed -i 's/^ECHO_CANCEL_DELAY_MS=.*/ECHO_CANCEL_DELAY_MS=$best_delay/' .env"
    echo "  docker-compose restart openclaw-voice"
else
    echo "✗ No positive reduction found at any tested delay"
    echo ""
    echo "Next steps:"
    echo "  1. Check if echo cancellation is actually enabled:"
    echo "     grep -E '^ECHO_CANCEL=' .env"
    echo ""
    echo "  2. Try adjusting attenuation:"
    echo "     ECHO_CANCEL_ATTENUATION=0.95  (stronger cancellation)"
    echo ""
    echo "  3. Check if microphone is actually picking up echo:"
    echo "     ./test-speech-echo.sh"
    echo ""
    echo "  4. Try alternative approach:"
    echo "     ./calibrate-impulse.sh"
fi

echo ""
echo "All results stored in .env at current setting"
