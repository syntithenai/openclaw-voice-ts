# OpenWakeWord vs Whisper Architecture

## Current Architecture (Whisper-Only)

```
┌───────────────────────────────────────────────────────────────┐
│ Audio Input (16kHz, 16-bit PCM)                              │
└─────────────────────┬─────────────────────────────────────────┘
                      │
                      ▼
         ┌────────────────────────┐
         │ VAD (Audio Energy)     │ ← Fast pre-filter
         └────────┬───────────────┘
                  │ (if speech detected)
                  ▼
      ┌───────────────────────────────────┐
      │ Whisper STT (Transcription)       │ ← SLOW (500-1500ms)
      │ "hey assistant start recording"   │
      └────────┬──────────────────────────┘
               │
               ▼
         ┌──────────────────────────┐
         │ Fuzzy Wake Word Matching │ ← Check if text contains "hey assistant"
         │ (Text comparison)        │
         └────────┬─────────────────┘
                  │ (if match)
                  ▼
         ┌──────────────────────────┐
         │ Send to Gateway          │ ← Activate conversation
         └──────────────────────────┘
```

**Problem**: Every audio frame goes through Whisper, even ambient noise. Wasteful and slow.

---

## New Architecture (With OpenWakeWord)

```
┌───────────────────────────────────────────────────────────────┐
│ Audio Input (16kHz, 16-bit PCM)                              │
└─────────────────────┬─────────────────────────────────────────┘
                      │
                      ▼
         ┌────────────────────────┐
         │ VAD (Audio Energy)     │ ← Fast pre-filter
         └────────┬───────────────┘
                  │
       ┌──────────┴──────────┐
       │                     │
       ▼                     ▼
  ┌──────────────┐    ┌──────────────────────────┐
  │ OpenWakeWord │    │ (Inactive - save CPU)    │
  │ Detection    │    │                          │
  │ <50ms ⚡     │    │ Monitor mode only        │
  └──────┬───────┘    └──────────────────────────┘
         │ (if match)
         ▼
  ┌──────────────────────────━━━━━━━━━━────────┐
  │ ✅ WAKE WORD DETECTED - Now capture command │
  └──────┬──────────────────────────────────────┘
         │
         ▼
  ┌──────────────────────┐
  │ Start audio capture  │ ← User speaks command
  │ (Max 2-4 seconds)    │
  └──────┬───────────────┘
         │
         ▼
  ┌──────────────────────────────┐
  │ Silence detected OR timeout  │
  └──────┬───────────────────────┘
         │
         ▼
  ┌──────────────────────────────┐
  │ Whisper Transcription        │ ← Only for command
  │ "<command>"                  │   FAST path now!
  └──────┬───────────────────────┘
         │
         ▼
  ┌──────────────────────┐
  │ Send to Gateway      │
  └──────────────────────┘
```

**Benefit**: OpenWakeWord runs continuously at negligible CPU cost. Whisper only starts after wake word detected.

---

## Configuration Modes

### Mode 1: OpenWakeWord (Recommended - Fast)

```dotenv
WAKE_WORD_ENGINE=openwakeword
OPENWAKEWORD_URL=http://localhost:8082
OPENWAKEWORD_CONFIDENCE_THRESHOLD=0.6
```

**Flow:**
1. Continuous openWakeWord monitoring (<5% CPU)
2. Wake word detected via audio fingerprint (<50ms)
3. Capture command audio
4. Transcribe command with Whisper
5. Send to gateway

**Timing:**
- Wake word detection: 50ms (audio-based)
- Command capture: 2-4 seconds (user speaking)
- Whisper transcription: 300-800ms
- Total: ~400-1100ms from end of speech

### Mode 2: Whisper (Current - Compatible)

```dotenv
WAKE_WORD_ENGINE=whisper
WHISPER_URL=http://localhost:8086
```

**Flow:**
1. Capture audio
2. Send to Whisper for transcription
3. Check if result contains wake word text
4. If match, process as command

**Timing:**
- Capture: 2-3 seconds (full utterance including wake word)
- Whisper transcription: 500-1500ms
- Text matching: <10ms
- Total: 700-2500ms

### Mode 3: Intelligent Fallback

```dotenv
WAKE_WORD_ENGINE=openwakeword
OPENWAKEWORD_URL=http://localhost:8082
WHISPER_URL=http://localhost:8086  # Fallback if openWakeWord offline
```

**Code logic:**
```typescript
async function detectWakeWord(text, audioBuffer) {
  // Try fast audio-based detection first
  if (usingOpenWakeWord) {
    try {
      const result = await openWakeWordClient.detectWakeWord(audioBuffer);
      if (result.detected) return true;  // ← Fast path
    } catch {
      logger.warn('openWakeWord unavailable, falling back to Whisper');
    }
  }
  
  // Fallback to text matching
  return containsWakeWord(text);
}
```

---

## Detailed Comparison Table

| Aspect | Whisper | OpenWakeWord | Best For |
|--------|---------|--------------|----------|
| **Wake Word Detection** | Text-based | Audio fingerprint | OpenWakeWord (10x faster) |
| **Latency** | 500-1500ms | <50ms | OpenWakeWord |
| **CPU (idle)** | 0% | 2-5% | Whisper (but acceptable) |
| **CPU (active)** | 100% (1 core) | 100% (during detection only) | OpenWakeWord |
| **Memory** | 400-800MB | 50-100MB | OpenWakeWord |
| **Accuracy (wake words)** | 95-98% | 95-99% | OpenWakeWord |
| **False positives** | ~2-3% | <1% | OpenWakeWord |
| **Transcription quality** | Excellent | N/A | Whisper |
| **Works offline** | Yes (if local) | Yes | Both |
| **Supported languages** | 100+ | 10+ | Whisper |
| **Multi-wake-word** | ✅ (via fuzzy) | ✅ (via config) | Both |

---

## Hybrid Approach Benefits

### Use openWakeWord For:
✅ Wake word detection (primary use case)
✅ Continuous monitoring during "listening" mode
✅ Low-latency interruption detection
✅ Reducing Whisper API calls/cost

### Use Whisper For:
✅ Actual command transcription
✅ Fallback wake word detection if openWakeWord unavailable
✅ Speech understanding/NLU
✅ Context retention across utterances

---

## Implementation Priority

### Phase 1 (MVP - 2-3 weeks)
- [ ] OpenWakeWord HTTP service wrapper
- [ ] Basic integration in orchestrator
- [ ] Configuration system
- [ ] Backward compatibility (Whisper default)

### Phase 2 (Optimization - 1-2 weeks)
- [ ] Performance benchmarking
- [ ] Fallback logic improvements
- [ ] Multi-model support
- [ ] Docker Compose setup

### Phase 3 (Polish - 1 week)
- [ ] Unit & integration tests
- [ ] Documentation
- [ ] Troubleshooting guide
- [ ] Migration guide for existing users

---

## Code Structure

```
openclaw-voice/
├── src/
│   ├── stt/
│   │   ├── whisper.ts           (existing)
│   │   ├── openwakeword.ts      (NEW)
│   │   └── index.ts
│   ├── orchestrator/
│   │   └── orchestrator.ts      (updated: add engine selection)
│   └── index.ts                 (updated: load config)
│
├── docker/
│   ├── openwakeword-wrapper/    (NEW)
│   │   ├── Dockerfile
│   │   └── app.py
│   ├── whisper-wrapper/         (existing)
│   └── piper-wrapper/           (existing)
│
├── docker-compose.yml           (add openwakeword service)
├── .env.example                 (add WAKE_WORD_ENGINE)
└── OPENWAKEWORD_INTEGRATION_PLAN.md  (this plan)
```

---

## Migration Path for Existing Users

### Step 1: No Changes Required (Default)
- Existing setups continue using Whisper
- `WAKE_WORD_ENGINE` defaults to `whisper`

### Step 2: Opt-In to OpenWakeWord (Optional)
```bash
# Add to .env
WAKE_WORD_ENGINE=openwakeword
OPENWAKEWORD_URL=http://localhost:8082

# Restart service
docker-compose restart openclaw-voice
```

### Step 3: Monitor Performance
```bash
# Watch VAD debug logs
docker logs -f openclaw-voice | grep "WAKE-WORD\|OWW-DETECT"
```

### Step 4: Rollback (if needed)
```bash
# Remove WAKE_WORD_ENGINE from .env
# Restart service → defaults to Whisper
```

---

## Success Metrics

After implementation, measure:

```
Baseline (Whisper):
- Wake word latency: ~1000ms average
- CPU during detection: 95-100%
- Memory: ~600MB

Target (OpenWakeWord):
- Wake word latency: <50ms
- CPU baseline: 5-10%
- CPU during detection: 50-60%
- Memory: ~100MB

Expected Improvement:
- Speed: 20x faster wake word detection
- CPU: 50-60% power savings
- UX: System feels more responsive
```

---

## Next Steps

1. ✅ Create this plan
2. → Evaluate openWakeWord models and licensing
3. → Build HTTP wrapper service
4. → Implement client library
5. → Integrate with orchestrator
6. → Test with real audio
7. → Deploy and monitor

See `OPENWAKEWORD_INTEGRATION_PLAN.md` for detailed implementation steps.
