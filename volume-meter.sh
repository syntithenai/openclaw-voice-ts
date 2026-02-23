#!/usr/bin/env bash
set -euo pipefail

DEVICE="${AUDIO_CAPTURE_DEVICE:-${AUDIO_DEVICE:-default}}"
RATE="${AUDIO_SAMPLE_RATE:-16000}"
CHANNELS=1
WINDOW_SAMPLES=${WINDOW_SAMPLES:-1600} # ~100ms at 16kHz
DURATION_SECONDS=${DURATION_SECONDS:-15}
RECOMMENDATIONS_FILE=${RECOMMENDATIONS_FILE:-volume-meter-recommendations.txt}
APPLY=false
RUN_CAPTURE=true
TMP_RMS_FILE=""

for arg in "$@"; do
  case "$arg" in
    --apply)
      APPLY=true
      RUN_CAPTURE=false
      ;;
    *)
      echo "Unknown option: $arg" >&2
      echo "Usage: $0 [--apply]" >&2
      exit 1
      ;;
  esac
done

if command -v parecord >/dev/null 2>&1; then
  CAPTURE_CMD=(parecord --raw --format=s16le --channels=${CHANNELS} --rate=${RATE} --device="${DEVICE}")
elif command -v arecord >/dev/null 2>&1; then
  CAPTURE_CMD=(arecord -q -f S16_LE -c ${CHANNELS} -r ${RATE} -t raw -D "${DEVICE}")
else
  echo "Error: parecord/arecord not found in PATH." >&2
  exit 1
fi

if [ "$RUN_CAPTURE" = "true" ]; then
  echo "[volume-meter] device=${DEVICE} rate=${RATE}Hz window=${WINDOW_SAMPLES} samples duration=${DURATION_SECONDS}s"
  echo "[volume-meter] writing recommendations to ${RECOMMENDATIONS_FILE}"

  TMP_RMS_FILE=$(mktemp -t volume-meter-rms.XXXXXX)
  trap 'rm -f "$TMP_RMS_FILE"' EXIT

  if command -v timeout >/dev/null 2>&1; then
    CAPTURE_PREFIX=(timeout "${DURATION_SECONDS}s")
  else
    CAPTURE_PREFIX=()
    echo "[volume-meter] warning: 'timeout' not found; will run until interrupted" >&2
  fi

  "${CAPTURE_PREFIX[@]}" "${CAPTURE_CMD[@]}" \
    | stdbuf -oL od -An -t d2 -w2 \
    | awk -v window=${WINDOW_SAMPLES} -v rmsfile="${TMP_RMS_FILE}" '
      BEGIN { count=0; sumsq=0; }
      {
        for (i=1; i<=NF; i++) {
          s=$i;
          sumsq += s*s;
          count++;
          if (count >= window) {
            rms = sqrt(sumsq / count);
            db = (rms > 0) ? 20*log(rms/32768)/log(10) : -120;
            printf("RMS=%8.2f  dBFS=%7.2f\n", rms, db);
            print rms >> rmsfile;
            count=0; sumsq=0;
          }
        }
      }
    '

  if [ ! -s "$TMP_RMS_FILE" ]; then
    echo "[volume-meter] no samples collected" > "$RECOMMENDATIONS_FILE"
    exit 1
  fi

  TOTAL_SAMPLES=$(wc -l < "$TMP_RMS_FILE" | tr -d ' ')
  SORTED_FILE=$(mktemp -t volume-meter-sorted.XXXXXX)
  trap 'rm -f "$TMP_RMS_FILE" "$SORTED_FILE"' EXIT
  sort -n "$TMP_RMS_FILE" > "$SORTED_FILE"

  pick_percentile() {
    local p="$1"
    awk -v p="$p" -v n="$TOTAL_SAMPLES" 'BEGIN {
      if (n < 1) { print 0; exit }
      idx = int(p * (n - 1) + 0.5) + 1;
      print idx;
    }'
  }

  P10_LINE=$(pick_percentile 0.10)
  P50_LINE=$(pick_percentile 0.50)
  P90_LINE=$(pick_percentile 0.90)
  P95_LINE=$(pick_percentile 0.95)

  P10=$(sed -n "${P10_LINE}p" "$SORTED_FILE")
  P50=$(sed -n "${P50_LINE}p" "$SORTED_FILE")
  P90=$(sed -n "${P90_LINE}p" "$SORTED_FILE")
  P95=$(sed -n "${P95_LINE}p" "$SORTED_FILE")

  noise_rms=${P10:-0}
  speech_rms=${P90:-0}
  if [ -z "$speech_rms" ] || [ "$speech_rms" = "0" ]; then
    speech_rms=${P95:-0}
  fi
  if [ -z "$speech_rms" ] || [ "$speech_rms" = "0" ]; then
    speech_rms=${P50:-0}
  fi

  clamp() {
    awk -v val="$1" -v lo="$2" -v hi="$3" 'BEGIN {
      if (val < lo) val = lo;
      if (val > hi) val = hi;
      printf "%.6f", val;
    }'
  }

  vad_abs=$(clamp "$(awk -v s="$speech_rms" 'BEGIN { printf "%.6f", (s * 0.55 / 32768) }')" 0.0006 0.02)
  vad_silence=$(clamp "$(awk -v n="$noise_rms" 'BEGIN { printf "%.6f", (n * 0.85 / 32768) }')" 0.0002 0.02)
  cutin_abs=$(awk -v v="$vad_abs" 'BEGIN { printf "%.6f", v * 1.5 }')

  {
    echo "# Volume meter recommendations"
    echo "samples=${TOTAL_SAMPLES}"
    echo "rms_p10=${P10}"
    echo "rms_p50=${P50}"
    echo "rms_p90=${P90}"
    echo "rms_p95=${P95}"
    echo ""
    echo "# Suggested .env updates"
    echo "VAD_ABSOLUTE_RMS=${vad_abs}"
    echo "VAD_ABSOLUTE_SILENCE_RMS=${vad_silence}"
    echo "# If cut-in is too sensitive, set CUTIN_ABSOLUTE_RMS to ~1.5x VAD_ABSOLUTE_RMS"
    echo "CUTIN_ABSOLUTE_RMS=${cutin_abs}"
  } > "$RECOMMENDATIONS_FILE"
else
  if [ ! -f "$RECOMMENDATIONS_FILE" ]; then
    echo "[volume-meter] no prior recommendations found; nothing to apply" >&2
    exit 0
  fi
fi

if [ "$APPLY" = "true" ]; then
  if [ ! -f "$RECOMMENDATIONS_FILE" ]; then
    echo "[volume-meter] recommendations file not found: $RECOMMENDATIONS_FILE" >&2
    exit 1
  fi

  VAD_ABS=$(awk -F= '/^VAD_ABSOLUTE_RMS=/{print $2}' "$RECOMMENDATIONS_FILE")
  VAD_SILENCE=$(awk -F= '/^VAD_ABSOLUTE_SILENCE_RMS=/{print $2}' "$RECOMMENDATIONS_FILE")
  CUTIN_ABS=$(awk -F= '/^CUTIN_ABSOLUTE_RMS=/{print $2}' "$RECOMMENDATIONS_FILE")

  if [ -z "$VAD_ABS" ] || [ -z "$VAD_SILENCE" ] || [ -z "$CUTIN_ABS" ]; then
    echo "[volume-meter] missing values in recommendations file; aborting apply" >&2
    exit 1
  fi

  ENV_FILE=".env"
  if [ ! -f "$ENV_FILE" ]; then
    echo "[volume-meter] .env not found in current directory" >&2
    exit 1
  fi

  apply_env() {
    local key="$1"
    local value="$2"
    if grep -qE "^${key}=" "$ENV_FILE"; then
      sed -i "s/^${key}=.*/${key}=${value}/" "$ENV_FILE"
    else
      printf "\n%s=%s\n" "$key" "$value" >> "$ENV_FILE"
    fi
  }

  apply_env "VAD_ABSOLUTE_RMS" "$VAD_ABS"
  apply_env "VAD_ABSOLUTE_SILENCE_RMS" "$VAD_SILENCE"
  apply_env "CUTIN_ABSOLUTE_RMS" "$CUTIN_ABS"

  echo "[volume-meter] applied recommendations to $ENV_FILE"
fi
