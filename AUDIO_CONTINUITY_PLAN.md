# Audio Continuity Plan (No-Code)

## Objectives
- Ensure no audible speech is lost between wake word and command.
- Make Whisper chunking contiguous across pauses.
- Ensure OpenWakeWord latency does not drop early command audio.
- Keep the system’s awake/asleep semantics intact and predictable.

## Observations (Current Behavior)
- Audio capture is continuous into a ring buffer (`audioBuffer`).
- A rolling pre-roll buffer (`preRollBuffer`, ~2s) is maintained in parallel.
- **Whisper is always transcribing when it is configured** (awake/asleep only gates gateway sending).
- Whisper transcription chunks are created by VAD boundaries.
- When TTS starts or ends, `audioBuffer` is cleared (dropping buffered frames).
- During TTS playback, `continuousCaptureLoop` is paused.

These points can cause command audio loss when:
- TTS begins quickly after wake word, clearing buffered frames.
- The user speaks while TTS is playing and cut‑in does not trigger.
- The command starts during OpenWakeWord detection latency and no pre-roll is appended.

## Plan
review 
### 1) Instrumentation & Observability
- Add explicit timeline markers (no logic changes) for:
  - Start/end of capture sessions (timestamps, buffer sizes).
  - TTS start/end (buffer sizes before/after clear).
  - Cut‑in detection windows (frames seen, RMS peaks).
  - Wake word detection time vs. command speech start.
- Add a lightweight trace ID per capture session and include it in logs.

### 2) Audio Buffering Guarantees
- Define a single authoritative ring buffer with read pointers (consumer indexes), so:
  - Capture never erases audio that hasn’t been consumed.
  - Each transcription request reads a contiguous slice of frames.
- Do **not** clear the ring buffer on TTS start/end; instead, advance read pointers for specific consumers.
- Keep a dedicated “pre-roll” pointer for OpenWakeWord so it can request audio that begins before detection time.

### 3) Whisper Chunking Policy
- Treat VAD boundaries as “soft”: allow a post‑wakeword grace window so a command spoken within $2$–$3$ seconds stays in the next chunk.
- Ensure the next Whisper request starts at the *previous chunk end* (contiguous), not “latest buffer tail.”
- Explicitly include the silent bridge (or a minimal leading silence window) between wake word and command.

### 4) OpenWakeWord Gating Policy (Target Behavior)
- When asleep, **do not** send audio to Whisper.
- On OpenWakeWord detection:
  - Capture a pre-roll slice (e.g., last 500–1500 ms) from the ring buffer.
  - Immediately start a new capture window including that pre-roll + live frames.
  - Send a single contiguous chunk to Whisper for transcription of the command.

### 5) TTS Cut‑In Safety
- Ensure cut‑in detection always has access to fresh audio frames.
- Avoid any buffer clears that remove user speech during TTS.
- If cut‑in fails, keep audio and still allow a post‑TTS transcription window.

### 6) Validation Tests
- **Wake‑pause‑command**: “wakeword” → 2s pause → command.
- **Wake‑fast‑command**: immediate command after wake word.
- **Wake‑command during TTS**: ensure cut‑in or post‑TTS capture still transcribes.
- **OpenWakeWord latency**: speak command overlapping detection; verify pre-roll captures it.
- Log review: confirm every spoken segment appears in a transcription request.

## Expected Outcome
- No lost audio between wake word and command.
- Whisper always receives contiguous audio slices.
- OpenWakeWord detection uses pre-roll to avoid missing early command speech.
- Awake/asleep behavior remains predictable and configurable.
