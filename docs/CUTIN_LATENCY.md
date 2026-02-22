# Cut-In Latency Explanation

## 📊 What Is Cut-In Latency?

Cut-in latency is the **time delay between when you start speaking and when the system detects your speech while playing a TTS response**. It's logged in the orchestrator as:

```
[CUT-IN-LATENCY] Synthesis took 559.82ms
[CUT-IN] Starting TTS playback (payload: 12345 bytes)
```

---

## ⏱️ Latency Components (Typical Example)

```
User speaks ─────────────┐
                         ├─ TTS Synthesis: ~400-600ms
                         ├─ Frame buffer accumulation: ~50-100ms  
                         ├─ RMS calculation & VAD: ~20-50ms
                         ├─ Interrupt detection: ~10-20ms
                         │
Total Round-Trip: ~500-800ms
```

### 1. **TTS Synthesis Latency** (Biggest Factor)

```typescript
// orchestrator.ts:704
logger.info(`[CUT-IN-LATENCY] Synthesis took ${synDurationMS.toFixed(2)}ms`);

// This is where Piper generates the full audio buffer BEFORE playback starts
```

**What happens:**
- TTS request sent to Piper service (HTTP)
- Piper runs inference (phoneme→spectrogram→audio)
- Full audio buffer returned (~10-100KB for typical utterance)
- Only then playback begins

**Typical duration:**
- **Piper `medium` model**: 400-800ms (server GPU: faster, RPi network: slower)
- **Piper `fast` model**: 200-400ms (newer, optimized for real-time)
- **Network latency**: +10-50ms if remote (Whisper/Piper not local)

### 2. **Playback & VAD Monitoring**

```typescript
// orchestrator.ts:719-726
const raceDuration = raceDurationMicros / 1000;
logger.info(`[CUT-IN] Starting TTS playback (${audioBuffer.length} bytes)`);
logger.info(`Race finished at ${raceDuration.toFixed(2)}ms`);

// Promise.race() between:
// A) Audio finishes playing (normal completion)
// B) User speech detected over threshold (cut-in detected)
```

**What happens:**
- PulseAudio starts playing audio buffer
- `monitorForCutIn()` continuously samples microphone
- RMS (audio energy) calculated every ~20ms
- When RMS exceeds `CUTIN_ABSOLUTE_RMS` threshold, interruption detected

**Typical duration:**
- Frame collection: ~20-50ms (depends on sample rate)
- RMS calculation: ~5-10ms
- Detection: <5ms (threshold comparison)
- **Total during playback: 20-100ms**

### 3. **Audio Buffer Accumulation**

```typescript
// vad.ts - samples are accumulated in 16kHz chunks
// At 16kHz: 1 sample = 0.0625ms
// 512 samples = 32ms frame
// Typically 2-3 frames accumulated before processing
```

**What happens:**
- Microphone captures 16-bit, 16kHz mono audio
- Frames accumulated until threshold size (512-1024 samples)
- VAD processes batch
- **Total: 20-50ms of buffering**

---

## 📈 Why This Matters

### Total Latency Breakdown:

```
Scenario 1: Piper Synthesis Optimized
├─ Synthesis (fast model): 250ms
├─ Buffer accumulation: 30ms
├─ VAD processing: 15ms
└─ Total: ~295ms

Scenario 2: Piper Synthesis Realistic
├─ Synthesis (medium model): 500ms
├─ Buffer accumulation: 40ms
├─ VAD processing: 20ms
└─ Total: ~560ms  ← This is typical for your logs

Scenario 3: Remote Services (Slower Network)
├─ Synthesis (network latency): +100ms
├─ Buffer accumulation: 40ms
├─ VAD processing: 20ms
└─ Total: ~660ms  ← Expected on RPi with remote Piper
```

---

## 🔍 How to Measure Cut-In Latency

Enable debug logging in your `.env`:

```dotenv
VAD_DEBUG=true
TTS_DEDUPE_WINDOW_MS=800
```

Then watch the logs:

```
[CUT-IN-LATENCY] Synthesis took 559.82ms ← TTS generation
[CUT-IN] Starting TTS playback (payload: 12345 bytes) ← Playback started
[CUTIN-RMS] sample_count=512 rms=0.00043 threshold=0.004 ← Audio being monitored
[CUTIN-RMS] sample_count=512 rms=0.00041 threshold=0.004
[CUTIN-RMS] sample_count=512 rms=0.02100 threshold=0.004 ← DETECTED!
Race finished at 82.45ms ← Time from start to cut-in
```

**Calculation:**
- Synthesis: 559.82ms
- Race (detection): 82.45ms  
- **Total: 642ms** from voice start to system responding

---

## 🎯 Why Is Synthesis the Bottleneck?

```typescript
// orchestrator.ts:704 - TTS happens SEQUENTIALLY
async playWithCutIn() {
  // Step 1: Generate audio (WAIT FOR FULL AUDIO)
  const audioBuffer = await ttsClient.synthesize(text);  // 500-800ms ⏳
  
  // Step 2: Only then monitor during playback
  Promise.race([
    audioPlayback(),      // Parallel: playing audio
    monitorForCutIn()     // Parallel: listening for interruption
  ]);
}
```

**Why sequential?**
- Piper must generate complete audio before playback (no streaming)
- PulseAudio needs full buffer to play smoothly
- Partial audio = choppy playback = bad UX

**Alternative approaches (not implemented):**
- Streaming TTS (generate on-the-fly) = complex, not supported by Piper
- Pre-synthesis common responses (cache) = only works for fixed phrases
- Parallel synthesis for next utterance (while playing current) = memory intensive

---

## ⚙️ Configuration: Tuning Cut-In Latency

### 1. Reduce Synthesis Latency

```dotenv
# Use faster TTS model
PIPER_VOICE_ID=en_US-amy-low    # Instead of en_US-amy-medium
# Trade-off: Lower voice quality but 30-50% faster synthesis

# Or use faster TTS service
# Piper "fast" models: en_US-amy-low = ~250ms vs medium = ~500ms
```

### 2. Reduce VAD Processing Latency

```dotenv
# Increase RMS threshold (detect speech sooner)
CUTIN_ABSOLUTE_RMS=0.01    # From 0.004, less sensitive = faster detection
# Trade-off: May miss quiet speech

# Reduce buffer size for faster processing
VAD_MIN_SPEECH_MS=100      # From 150, accumulate less audio
# Trade-off: More false positives on noise
```

### 3. Reduce Network Latency (for remote services)

```dotenv
# Option A: Use local Piper service on same machine
# Move Piper from cloud/server to same host
PIPER_URL=http://localhost:5002  # Instead of remote IP

# Option B: Use edge deployment
# Deploy small Piper model on network-local machine
# Typical improvement: 200ms reduction (300ms → 100ms)
```

### 4. Aggressive Optimization (Not Recommended - Bad UX)

```dotenv
# WARNING: These settings may cause false cut-ins on noise

CUTIN_ABSOLUTE_RMS=0.02        # Very low threshold = too sensitive
CUTIN_MIN_SPEECH_MS=80         # Very short minimum
VAD_MIN_SPEECH_MS=100
AUDIO_SAMPLE_RATE=8000          # Lower quality = faster processing (not recommended)

# Result: System interrupts on background noise, static, etc.
```

---

## 📊 Typical Measurements by Hardware

### Desktop (Linux + Local Piper GPU)
```
Synthesis: 50-150ms
Detection: 30-50ms
Total: 80-200ms
```

### Server (Remote Piper CPU)
```
Synthesis: 200-400ms
Network RTT: 10-20ms
Detection: 30-50ms
Total: 240-470ms
```

### Raspberry Pi (Remote Services, WiFi)
```
Synthesis: 400-800ms (network + slower inference)
Network RTT: 20-50ms
Detection: 40-80ms
Total: 460-930ms
```

---

## ❓ Is This Latency a Problem?

**No, this is expected and acceptable for voice interfaces.**

### UX Perception:
- **< 200ms**: Feels instant (ideal but hard to achieve)
- **200-500ms**: Natural, acceptable (like phone conversation)
- **500-1000ms**: Noticeable but OK (like talking to a slow person)
- **> 1000ms**: Feels broken (needs optimization)

Your current **~600ms is well within acceptable range** for a natural conversation.

### Real-World Comparison:
- Human response time: 300-500ms (think + speak)
- Phone conversation: 200-400ms (transmission delay)
- Voice assistant (Alexa/Google): 300-800ms (synthesis + network)
- **OpenClaw = 500-800ms: Competitive!**

---

## 🚀 Reducing Latency for Production

If you want to optimize below 300ms:

### Option 1: Use Faster Piper Model
```bash
# Install fast models (if not already present)
docker exec piper /app/piper \
  --voice en_US-amy-low \
  --length_scale 1.0
  
# Result: 250-350ms synthesis
```

### Option 2: Pre-Synthesize Common Responses
```typescript
// Cache common TTS outputs
const cache = {
  "i don't understand": <audio buffer>,
  "can you repeat that": <audio buffer>,
};

// On request, check cache first (~10ms) before synthesis
```

### Option 3: Stream TTS (Advanced)
```typescript
// Send audio chunks as they generate (no wait for full audio)
// Requires streaming support from Piper (not standard)
// Could reduce latency to 100-200ms but adds complexity
```

---

## 📋 Summary Table

| Metric | Your System | Good Target | Excellent |
|--------|-------------|-------------|-----------|
| Synthesis | 400-800ms | <400ms | <200ms |
| VAD Detection | 30-60ms | <50ms | <20ms |
| Total Latency | 500-900ms | 300-500ms | <200ms |
| Perceptual Feel | Natural | Natural | Instant-like |

---

## 🔗 Related Configuration

See [.env.example](/.env.example) for:
- `CUTIN_ABSOLUTE_RMS`: Cut-in threshold
- `CUTIN_MIN_SPEECH_MS`: Minimum speech duration  
- `VAD_MIN_SPEECH_MS`: VAD processing window
- `PRE_ROLL_MS`: Audio buffered before TTS starts

See [RASPBERRY_PI_INSTALL.md](RASPBERRY_PI_INSTALL.md) for RPi-specific latency tuning.
