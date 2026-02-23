# Echo Cancellation Plan for OpenClaw Voice

## Executive Summary

This document outlines a comprehensive plan for implementing acoustic echo cancellation (AEC) in the OpenClaw voice system to prevent TTS playback from triggering false cut-in detections. The core challenge is time-aligning playback frames with microphone capture frames to subtract the known playback signal from the incoming microphone signal.

## Problem Statement

**Current Situation:**
- TTS playback leaks into the microphone via acoustic coupling (speaker → room → microphone)
- The voice activity detector (VAD) sees this leaked audio as "speech"
- Cut-in detection triggers on the system's own TTS output, causing premature interruption
- Current workaround: TTS-aware gate with stricter thresholds (simple but brittle)

**Why Echo Cancellation?**
- Proper AEC allows normal cut-in sensitivity during TTS playback
- Enables user to interrupt TTS without requiring louder/longer speech
- Provides cleaner audio to Whisper by removing playback artifacts from recordings
- Industry-standard approach used in phones, conferencing systems, smart speakers

## Core Concept

Echo cancellation works by:
1. **Recording what we play**: Capture the actual PCM samples sent to the speaker
2. **Time-aligning**: Determine the delay between playback and when it reaches the microphone
3. **Subtracting**: Remove the time-delayed playback signal from the microphone input
4. **Residual processing**: What remains is (ideally) only the user's voice

The output is "echo-cancelled microphone audio" that can be fed to VAD and Whisper.

## Architecture Options

### Option A: In-Process AEC (Recommended for Prototyping)

**Location:** Inside `openclaw-voice` orchestrator  
**Library:** Use WebRTC AEC3 (via `rnnoise-wasm` or native bindings)

**Data Flow:**
```
Piper TTS → playbackBuffer[] → PulseAudio Sink → [acoustic path] → PulseAudio Source → 
micBuffer[] → AEC(micBuffer, playbackBuffer) → cleanBuffer[] → VAD → Whisper
```

**Pros:**
- Full control over both playback and capture streams
- Can time-align using buffer timestamps
- No external dependencies
- Can log/debug alignment in real-time

**Cons:**
- Requires capturing "loopback" of playback stream (what actually went to speaker)
- May need to handle sample rate conversion if playback ≠ capture rate
- CPU overhead from AEC processing

### Option B: PulseAudio Module (System-Level)

**Location:** PulseAudio daemon inside Docker container  
**Module:** `module-echo-cancel`

**Data Flow:**
```
Piper TTS → PulseAudio Sink (original) → [module-echo-cancel] → 
PulseAudio Source (echo-cancelled) → openclaw-voice captures cleaned audio
```

**Pros:**
- OS-level solution, no application changes needed
- Well-tested implementation (Speex or WebRTC AEC)
- Automatic time-alignment handled by PulseAudio

**Cons:**
- Less visibility into what's happening
- Harder to debug/tune from application layer
- Configuration requires PulseAudio expertise
- May not work well in Docker environment without careful device mapping

### Option C: Hybrid Approach

Use PulseAudio `module-echo-cancel` to provide a cleaned source, but also keep application-level monitoring to detect when AEC is struggling (high residual energy) and temporarily raise cut-in thresholds.

## Time-Alignment Challenge

The hardest part of AEC is determining **when** the playback signal reaches the microphone.

### The Problem

```
Time:   0ms      50ms     100ms    150ms    200ms
TTS:    [frame0] [frame1] [frame2] [frame3] [frame4]
        ↓ (delay = ?)
Mic:              [frame0'] [frame1'] [frame2'] [frame3']
```

The delay includes:
- **Playback buffering:** TTS API → socket → PulseAudio → kernel → driver → DAC
- **Acoustic propagation:** Speaker → air → microphone (typically 1-3ms indoors)
- **Capture buffering:** ADC → driver → kernel → PulseAudio → socket → app

**Total typical delay:** 20-100ms (varies by system load, buffer sizes, hardware)

### Solution: Cross-Correlation Method

**Approach:**
1. Keep a sliding window of recent playback frames (e.g., last 200ms)
2. When new mic frame arrives, cross-correlate it with the playback window
3. Find the offset that produces maximum correlation
4. Use that offset to select which playback frame to subtract

**Algorithm:**
```
For each mic frame:
  maxCorr = 0
  bestOffset = 0
  
  For offset in [0ms to 200ms]:
    corr = correlate(micFrame, playbackBuffer[offset])
    if corr > maxCorr:
      maxCorr = corr
      bestOffset = offset
  
  # Now we know playback[bestOffset] is in micFrame
  cleanFrame = micFrame - α * playbackBuffer[bestOffset]
  
  # α is attenuation factor (0.5 to 1.0)
```

**Optimizations:**
- Once offset is found, assume it's stable for ~10 seconds (track drift slowly)
- Use FFT-based correlation for speed (O(n log n) vs O(n²))
- Only recalculate when correlation drops below threshold

### Alternative: Timestamp-Based Alignment

**Approach:**
1. Timestamp each playback frame when sent to PulseAudio
2. Timestamp each mic frame when captured from PulseAudio
3. Use PulseAudio's timing API (`pa_stream_get_timing_info`) to estimate latency
4. Align based on: `micTimestamp - playbackTimestamp - estimatedLatency`

**Pros:**
- Faster than cross-correlation (no iterative search)
- Works even when playback and mic have no overlap

**Cons:**
- Requires accurate clock sync (usually fine within one machine)
- PulseAudio timing can be unreliable under load
- Doesn't adapt to real-world acoustic delays

## Implementation Strategy

### Phase 1: Loopback Capture (Foundation)

**Goal:** Record what's actually being played before attempting cancellation

**Changes:**
- Modify TTS client to open *two* PulseAudio connections:
  - Sink: playback stream (existing)
  - Source: loopback of that sink
- Store loopback frames in `playbackRingBuffer: BufferedFrame[]` with timestamps
- Log RMS of playback vs mic to verify we're seeing the echo

**Validation:**
- Visually compare mic RMS spikes with playback RMS events
- Should see ~50-100ms delay correlation

### Phase 2: Time Alignment (Calibration)

**Goal:** Determine the acoustic delay in this environment

**Approach:**
- Play a known test signal (1kHz tone burst or chirp)
- Cross-correlate mic capture with test signal
- Measure peak offset → this is your delay
- Store as `ECHO_DELAY_MS` configuration

**Tooling:**
- Add HTTP endpoint `/calibrate-echo` that:
  - Plays 1-second chirp sweep (100Hz-8kHz)
  - Records mic input during playback
  - Computes cross-correlation
  - Returns detected delay and confidence score

**Validation:**
- Run calibration 5 times, verify delay is consistent (±10ms)
- Typical result: 30-70ms for modern Linux audio stack

### Phase 3: Static Subtraction (Proof of Concept)

**Goal:** Subtract playback from mic using fixed delay

**Algorithm:**
```typescript
function cancelEcho(micFrame: Buffer, timestamp: number): Buffer {
  const playbackFrame = getPlaybackFrameAt(timestamp - ECHO_DELAY_MS);
  if (!playbackFrame) return micFrame; // no playback happening
  
  const cancelled = new Int16Array(micFrame.length / 2);
  const mic = new Int16Array(micFrame);
  const pb = new Int16Array(playbackFrame);
  
  for (let i = 0; i < cancelled.length; i++) {
    cancelled[i] = mic[i] - (ATTENUATION * pb[i]);
  }
  
  return Buffer.from(cancelled.buffer);
}
```

**Tuning:**
- Start with `ATTENUATION = 0.3` (conservative)
- Increase until echo is minimized (watch VAD RMS during TTS)
- Too high: distorts user speech during interrupt
- Too low: echo still triggers VAD

**Validation:**
- Play TTS, watch mic RMS drop significantly during playback
- Speak during TTS, verify speech still detected

### Phase 4: Adaptive Filter (Production Quality)

**Goal:** Handle time-varying delays and frequency-dependent attenuation

**Library Options:**
- **WebRTC AEC3**: Gold standard (used in Chrome/Firefox)
  - Node bindings: `wrtc` package or custom native addon
  - Handles reverb, frequency shaping, double-talk detection
- **Speex**: Lighter weight, good enough for most cases
  - `speexdsp` package
  - Simpler API, less CPU

**Integration:**
```typescript
import { AcousticEchoCanceller } from 'webrtc-aec3'; // hypothetical

class VoiceOrchestrator {
  private aec: AcousticEchoCanceller;
  
  constructor() {
    this.aec = new AcousticEchoCanceller({
      sampleRate: 48000,
      frameSize: 1024,
      tailLength: 0.1, // 100ms echo tail
    });
  }
  
  private processMicFrame(micFrame: Buffer): Buffer {
    const playbackFrame = this.getRecentPlaybackFrame();
    return this.aec.process(micFrame, playbackFrame);
  }
}
```

**Configuration:**
- `tailLength`: How much delay to model (50-200ms typical)
- `nlpMode`: Aggressive/moderate/disabled non-linear processing
- `delayAgnostic`: Auto-find delay vs use fixed offset

### Phase 5: Double-Talk Detection

**Goal:** Detect when user AND TTS are both active

When both signals present:
- Don't adapt AEC filter (prevents user speech from corrupting model)
- Switch to TTS-aware cut-in thresholds temporarily
- Resume adaptation when user stops

**Detection Method:**
- Compare mic energy before/after AEC
- If `energyBefore / energyAfter > 2.0` → user is speaking too
- If `energyAfter < 0.1 * energyBefore` → only echo present

## System-Specific Considerations

### Docker Networking

**Challenge:** TTS (Piper container) and mic (openclaw-voice container) are separate

**Solutions:**
- **Option 1:** Run Piper inside openclaw-voice container (tighter coupling)
- **Option 2:** Stream playback PCM via WebSocket before sending to Piper
- **Option 3:** Use Docker shared memory for zero-copy playback buffer sharing

**Recommendation:** Keep containers separate, use loopback capture within openclaw-voice

### PulseAudio in Docker

**Current setup:**
- Host PulseAudio socket mounted into containers
- openclaw-voice records from default source
- Piper plays to default sink

**AEC implications:**
- Need access to both sink (playback) and source (mic)
- If using `module-echo-cancel`, must configure PulseAudio inside host (not container)
- Alternative: Run PulseAudio daemon inside openclaw-voice container with full control

### Sample Rate Matching

**Piper output:** Typically 22050 Hz  
**Microphone input:** 48000 Hz (configurable)

**Implications:**
- Must resample playback to match mic before subtraction
- Use `libresample` or `sox` or do in PulseAudio
- Resampling adds latency (~10ms) → include in delay calibration

## Testing & Validation Plan

### Test 1: No Speech, TTS Only
- **Setup:** Play TTS, don't speak
- **Baseline (no AEC):** VAD detects speech, cut-in triggers
- **With AEC:** VAD shows silence, no cut-in
- **Metric:** Mic RMS during TTS < 0.001

### Test 2: Interrupt TTS
- **Setup:** Play TTS, say "stop" clearly
- **Baseline:** Cut-in works but requires loud/long speech
- **With AEC:** Cut-in triggers immediately with normal speech
- **Metric:** Detection latency < 300ms, no false negatives

### Test 3: Simultaneous Speech (Double-Talk)
- **Setup:** Play TTS, speak at the same time
- **Verify:** Both TTS continues AND user speech is captured
- **Metric:** Whisper transcription includes user words

### Test 4: Varying Delays
- **Setup:** Add CPU load (compile, docker build) during TTS
- **Verify:** AEC adapts to changing latency
- **Metric:** Echo suppression doesn't degrade > 20%

### Test 5: Multiple Interrupts
- **Setup:** Interrupt TTS 5 times in 60 seconds
- **Verify:** Each interrupt detected, AEC re-locks
- **Metric:** No run-away where AEC thinks user is echo

## Configuration Parameters

**New environment variables:**
```bash
# Enable/disable AEC
ECHO_CANCELLATION_ENABLED=true

# Method: 'static', 'adaptive', 'pulseaudio'
ECHO_CANCELLATION_METHOD=adaptive

# Calibrated delay (ms), or 'auto' to detect
ECHO_DELAY_MS=auto

# Attenuation factor (0.0 to 1.0)
ECHO_ATTENUATION=0.7

# AEC tail length (ms) - how much history to model
ECHO_TAIL_LENGTH_MS=150

# Double-talk detection threshold
ECHO_DOUBLETALK_RATIO=2.0

# Re-calibrate delay every N seconds
ECHO_RECALIBRATE_INTERVAL=300
```

## Performance Considerations

**CPU Impact:**
- Cross-correlation: ~5-10% CPU per frame (optimized FFT)
- WebRTC AEC3: ~10-20% CPU continuous
- Static subtraction: ~1% CPU (trivial)

**Memory:**
- Playback ring buffer: ~10MB for 10 seconds @ 48kHz
- AEC filter state: ~1MB (tail-dependent)

**Latency:**
- AEC processing: <5ms per frame (1024 samples @ 48kHz = 21ms frames)
- Calibration: One-time 1-second overhead

## Risks & Mitigation

**Risk 1: Time alignment drift**
- **Mitigation:** Periodic re-calibration, adaptive tracking
- **Fallback:** Detect poor cancellation, switch to TTS-aware gate mode

**Risk 2: AEC removes user speech**
- **Mitigation:** Double-talk detection, conservative attenuation
- **Fallback:** User can disable via env var

**Risk 3: Works in dev, fails in production**
- **Mitigation:** Extensive testing on target hardware
- **Fallback:** Graceful degradation to simple gate

**Risk 4: Docker audio routing changes**
- **Mitigation:** Version-lock PulseAudio, document setup
- **Fallback:** Detect missing loopback, log warning

## Success Criteria

Echo cancellation is considered successful when:

1. **No false cut-ins:** TTS plays to completion without self-triggering >95% of time
2. **Responsive interrupts:** User can interrupt with normal speaking voice (<60dB SPL)
3. **Clean transcriptions:** Whisper doesn't transcribe echo artifacts
4. **Stable operation:** AEC doesn't degrade over hours of runtime
5. **Observable:** Metrics/logs show AEC effectiveness in real-time

## Next Steps

1. **Research phase** (1-2 days):
   - Test PulseAudio loopback capture on target system
   - Benchmark WebRTC AEC3 vs Speex vs custom
   - Measure baseline echo delay with test signal

2. **Prototype phase** (3-5 days):
   - Implement loopback capture in TTS client
   - Add static subtraction with manual tuning
   - Validate echo reduction in logs

3. **Integration phase** (3-5 days):
   - Integrate WebRTC AEC3 library
   - Implement auto-calibration
   - Add double-talk detection

4. **Testing phase** (2-3 days):
   - Run all validation tests
   - Tune parameters for user's environment
   - Document configuration

**Total estimated effort:** 2-3 weeks for production-quality AEC

## Alternative: Quick Win Improvements

If full AEC is too complex short-term, consider:

- **Directional microphone:** Cardioid pattern rejects speaker audio
- **Physical separation:** Move mic farther from speakers
- **Acoustic treatment:** Sound-absorbing materials between speaker/mic
- **Headphone mode:** Playback to headphones eliminates acoustic path
- **Better gate tuning:** Continue refining TTS-aware thresholds (current approach)

---

**Document version:** 1.0  
**Last updated:** 2026-02-22  
**Author:** GitHub Copilot  
**Status:** Planning phase - no implementation yet
