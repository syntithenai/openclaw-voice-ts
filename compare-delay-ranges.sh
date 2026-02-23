#!/bin/bash

# Test delay values 200-300ms and compare to previous results

set -e

HTTP_PORT="${VOICE_HTTP_PORT:-18910}"

echo "=== Echo Cancellation Delay Range Comparison ==="
echo ""
echo "Testing 200-300ms range and comparing to previous 10-190ms results"
echo ""

if ! curl -s http://localhost:$HTTP_PORT/health > /dev/null 2>&1; then
    echo "✗ Container not running"
    exit 1
fi

# Test delays 200-300 in 10ms increments
echo "Delay(ms) | Reduction%"
echo "----------|----------"

# Store results for comparison
declare -A new_results
declare -A all_results

# Previous results from 10-190ms
all_results[10]="-143.9"
all_results[30]="-176.5"
all_results[50]="-160.9"
all_results[70]="-129.7"
all_results[90]="-183.5"
all_results[110]="-167.5"
all_results[130]="-254.7"
all_results[150]="-195.6"
all_results[170]="-167.4"
all_results[190]="-116.6"

echo "=== Testing 200-300ms range ==="
for delay in 200 210 220 230 240 250 260 270 280 290 300; do
    # Update config
    sed -i "s/^ECHO_CANCEL_DELAY_MS=.*/ECHO_CANCEL_DELAY_MS=$delay/" .env
    
    # Restart
    docker-compose restart openclaw-voice > /dev/null 2>&1
    sleep 2
    
    # Check health
    if ! curl -s http://localhost:$HTTP_PORT/health > /dev/null 2>&1; then
        echo "    $delay    |   ERROR"
        new_results[$delay]="ERROR"
        continue
    fi
    
    # Test
    response=$(curl -s -X POST http://localhost:$HTTP_PORT/test/echo-cancellation-verify 2>/dev/null || echo '{}')
    reduction=$(echo "$response" | jq -r '.reductionRatio // empty' 2>/dev/null)
    
    if [ -z "$reduction" ]; then
        echo "    $delay    |   FAIL"
        new_results[$delay]="FAIL"
        continue
    fi
    
    reduction_pct=$(awk "BEGIN {printf \"%.1f\", $reduction * 100}")
    printf "%9d | %10s\n" "$delay" "${reduction_pct}%"
    
    new_results[$delay]=$reduction_pct
    all_results[$delay]=$reduction_pct
done

echo ""
echo "=== Full Comparison (10-300ms) ==="
echo ""
echo "Delay(ms) | Reduction% | Trend"
echo "----------|------------|--------"

prev_value=0
for delay in 10 30 50 70 90 110 130 150 170 190 200 210 220 230 240 250 260 270 280 290 300; do
    if [ -n "${all_results[$delay]}" ]; then
        value=${all_results[$delay]}
        
        # Determine trend
        if awk "BEGIN {exit !($value > $prev_value)}"; then
            trend="↑ improving"
        elif awk "BEGIN {exit !($value < $prev_value)}"; then
            trend="↓ worsening"
        else
            trend="→ stable"
        fi
        
        printf "%9d | %10s | %s\n" "$delay" "${value}%" "$trend"
        prev_value=$value
    fi
done

echo ""
echo "=== Analysis ==="
echo ""

# Find best (least negative or most positive)
best_delay=0
best_value=-999

for delay in 10 30 50 70 90 110 130 150 170 190 200 210 220 230 240 250 260 270 280 290 300; do
    if [ -n "${all_results[$delay]}" ] && [ "${all_results[$delay]}" != "ERROR" ] && [ "${all_results[$delay]}" != "FAIL" ]; then
        value=${all_results[$delay]}
        if awk "BEGIN {exit !($value > $best_value)}"; then
            best_delay=$delay
            best_value=$value
        fi
    fi
done

echo "Best (least negative): ${best_delay}ms with ${best_value}%"
echo ""

# Check for positive values
positive_count=0
for delay in 10 30 50 70 90 110 130 150 170 190 200 210 220 230 240 250 260 270 280 290 300; do
    if [ -n "${all_results[$delay]}" ] && [ "${all_results[$delay]}" != "ERROR" ] && [ "${all_results[$delay]}" != "FAIL" ]; then
        value=${all_results[$delay]}
        if awk "BEGIN {exit !($value > 0)}"; then
            positive_count=$((positive_count + 1))
            echo "✓ Positive: ${delay}ms = ${value}%"
        fi
    fi
done

if [ $positive_count -eq 0 ]; then
    echo "⚠ No positive reduction ratios found in entire 10-300ms range"
    echo ""
    echo "This indicates:"
    echo "  1. Echo cancellation algorithm may not be working correctly"
    echo "  2. The test signal path may not have real echo"
    echo "  3. Microphone/speaker coupling may be ineffective"
    echo ""
    echo "Recommendation:"
    echo "  Use best value we found: ${best_delay}ms (least negative)"
    echo "  But also investigate why all values are making things worse"
fi

echo ""
echo "=== Recommendation ==="
echo "Apply best value found: ${best_delay}ms"
echo ""
echo "  sed -i 's/^ECHO_CANCEL_DELAY_MS=.*/ECHO_CANCEL_DELAY_MS=${best_delay}/' .env"
echo "  docker-compose restart openclaw-voice"
