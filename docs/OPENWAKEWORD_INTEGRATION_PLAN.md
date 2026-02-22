# OpenWakeWord Integration Plan

## Overview

This plan describes integrating **openWakeWord** (https://github.com/dscripka/openWakeWord) as an alternative to Whisper for wake word detection. openWakeWord is a lightweight, on-device hotword detection library optimized for low-latency wake word recognition without requiring full speech-to-text transcription.

---

## Why openWakeWord vs Whisper?

### Current Approach (Whisper):
- **Pros**: Universal speech recognition, accurate for any speech
- **Cons**: Slow (500-1500ms per inference), requires full audio transcription, resource-intensive, overkill for wake words

### openWakeWord:
- **Pros**: Dedicated wake word detection, fast (<50ms per frame), lightweight, low CPU/memory, on-device, multi-language support
- **Cons**: Only for wake words, not for command transcription (still need Whisper for actual commands)

### Architecture with Both:
```
Audio Input
    ↓
├─ openWakeWord (continuous, fast) → Detect wake word
│  └─ If match: trigger command capture
│
├─ Whisper (only when commanded) → Transcribe actual command
└─ Result: 10x faster wake word detection, same command accuracy
```

---

## Implementation Plan

### Phase 1: Research & Setup

#### 1.1 openWakeWord Library Integration

**Task**: Add openWakeWord Python wrapper

```bash
# Requirements:
pip install openwakeword numpy soundfile

# Model files:
- Download pre-trained models (~5-20MB each)
- Place in: /app/models/openwakeword/
- Examples: "hey google", "alexa", "ok google", "hey siri"
```

**Decision**: Use HTTP wrapper approach (parallel to existing Whisper/Piper services)

**Why HTTP wrapper?**
- Node.js orchestrator stays TypeScript-only
- Easy hot-reload for model updates
- Matches existing architecture (Whisper/Piper already HTTP)
- Can run in separate container for scalability

#### 1.2 Create openWakeWord HTTP Service

**New file**: `docker/openwakeword-wrapper/app.py`

```python
from fastapi import FastAPI
from openwakeword.model import Model
import numpy as np

app = FastAPI()
model = Model(inference_framework="onnx")

@app.post("/detect")
async def detect_wake_word(audio_bytes: bytes, wake_word: str = "hey"):
    """
    Detect wake word in audio chunk
    Returns: {detected: bool, confidence: float}
    """
    audio = np.frombuffer(audio_bytes, dtype=np.int16)
    scores = model.predict(audio, [wake_word])
    return {"detected": scores[wake_word] > 0.5, "confidence": float(scores[wake_word])}

@app.get("/health")
async def health():
    return {"status": "healthy"}
```

---

### Phase 2: Configuration System

#### 2.1 Environment Variables

Add to `.env.example`:

```dotenv
# Wake Word Detection Engine
# Options: whisper (default, transcribes everything), openwakeword (fast wake-word-only detection)
WAKE_WORD_ENGINE=openwakeword

# When using openWakeWord:
OPENWAKEWORD_URL=http://localhost:8082          # OpenWakeWord service URL
OPENWAKEWORD_CONFIDENCE_THRESHOLD=0.5           # Detection confidence threshold (0-1)
OPENWAKEWORD_ENABLE_DEBUG=false                 # Log detection frames

# When using Whisper (fallback or command detection):
WHISPER_URL=http://localhost:8086
WHISPER_MODEL=small
WHISPER_LANGUAGE=en
```

#### 2.2 Update OrchestratorConfig Interface

**File**: `src/orchestrator/orchestrator.ts`

```typescript
export interface OrchestratorConfig {
  // ... existing fields ...
  
  // Wake word detection engine selection
  wakeWordEngine?: 'whisper' | 'openwakeword';  // default: 'whisper'
  
  // OpenWakeWord configuration
  openWakeWordUrl?: string;
  openWakeWordConfidenceThreshold?: number;
  openWakeWordDebug?: boolean;
  
  // Whisper configuration (still used for command transcription)
  whisperUrl?: string;
  whisperModel?: string;
  whisperLanguage?: string;
}
```

---

### Phase 3: Client Implementation

#### 3.1 Create OpenWakeWord Client

**New file**: `src/stt/openwakeword.ts`

```typescript
import fetch from 'node-fetch';
import { Logger } from '../utils/logger';

export interface OpenWakeWordConfig {
  url: string;
  confidenceThreshold?: number;
  debug?: boolean;
}

export interface DetectionResult {
  detected: boolean;
  confidence: number;
  wakeWord: string;
}

export class OpenWakeWordClient {
  private logger = new Logger('OpenWakeWordClient');
  private config: OpenWakeWordConfig;

  constructor(config: OpenWakeWordConfig) {
    this.config = config;
  }

  /**
   * Detect wake word in audio chunk (16-bit PCM)
   */
  async detectWakeWord(
    audioBuffer: Buffer,
    wakeWords: string[]
  ): Promise<{ detected: boolean; topMatch?: DetectionResult }> {
    try {
      const response = await fetch(`${this.config.url}/detect`, {
        method: 'POST',
        body: JSON.stringify({
          audio_base64: audioBuffer.toString('base64'),
          wake_words: wakeWords,
        }),
        headers: { 'Content-Type': 'application/json' },
      });

      const data = await response.json();
      
      if (this.config.debug) {
        this.logger.debug(`[OWW-DETECT] confidence: ${data.top_confidence.toFixed(3)}`);
      }

      // Check if any wake word detected above threshold
      const threshold = this.config.confidenceThreshold ?? 0.5;
      const detected = data.top_confidence >= threshold;

      return {
        detected,
        topMatch: detected
          ? {
              detected: true,
              confidence: data.top_confidence,
              wakeWord: data.top_match,
            }
          : undefined,
      };
    } catch (error) {
      this.logger.error('Wake word detection failed:', error);
      return { detected: false };
    }
  }

  /**
   * Health check
   */
  async isHealthy(): Promise<boolean> {
    try {
      const response = await fetch(`${this.config.url}/health`);
      return response.ok;
    } catch {
      return false;
    }
  }
}
```

---

### Phase 4: Orchestrator Integration

#### 4.1 Update VoiceOrchestrator Class

**File**: `src/orchestrator/orchestrator.ts`

```typescript
import { OpenWakeWordClient } from '../stt/openwakeword';

export class VoiceOrchestrator {
  private whisperClient: WhisperClient | null = null;
  private openWakeWordClient: OpenWakeWordClient | null = null;  // NEW
  private wakeWordEngine: 'whisper' | 'openwakeword' = 'whisper';  // NEW

  constructor(
    private config: OrchestratorConfig,
    logger?: Logger
  ) {
    // ... existing initialization ...

    // Initialize wake word engine based on config
    this.wakeWordEngine = config.wakeWordEngine || 'whisper';

    if (this.wakeWordEngine === 'openwakeword' && config.openWakeWordUrl) {
      this.openWakeWordClient = new OpenWakeWordClient({
        url: config.openWakeWordUrl,
        confidenceThreshold: config.openWakeWordConfidenceThreshold,
        debug: config.openWakeWordDebug,
      });
    } else {
      // Fallback to Whisper if openWakeWord not configured
      this.whisperClient = new WhisperClient({
        url: config.whisperUrl,
        model: config.whisperModel,
        language: config.whisperLanguage,
      });
    }
  }

  /**
   * Detect wake word using configured engine
   */
  private async detectWakeWord(text: string, audioBuffer?: Buffer): Promise<boolean> {
    if (!this.config.wakeWord) return false;

    const wakeWords = Array.isArray(this.config.wakeWord)
      ? this.config.wakeWord
      : [this.config.wakeWord];

    // ENGINE 1: OpenWakeWord (fast, audio-based)
    if (this.wakeWordEngine === 'openwakeword' && this.openWakeWordClient && audioBuffer) {
      const result = await this.openWakeWordClient.detectWakeWord(audioBuffer, wakeWords);
      
      if (result.detected && result.topMatch) {
        this.logger.info(
          `[WAKE-WORD] Detected via openWakeWord: "${result.topMatch.wakeWord}" ` +
          `(confidence: ${(result.topMatch.confidence * 100).toFixed(1)}%)`
        );
        return true;
      }
    }

    // ENGINE 2: Fallback to text matching (existing method)
    if (this.containsWakeWord(text)) {
      this.logger.info(`[WAKE-WORD] Detected via text matching`);
      return true;
    }

    return false;
  }

  /**
   * Modified speech capture to use openWakeWord detection
   */
  private async captureSpeechAudio(): Promise<Buffer | null> {
    // ... existing code ...

    // When using openWakeWord, check audio directly before Whisper
    if (this.wakeWordEngine === 'openwakeword' && this.openWakeWordClient) {
      const audioBuffer = Buffer.concat(frames);
      
      // Fast wake word check on raw audio
      if (await this.detectWakeWord('', audioBuffer)) {
        // Wake word detected, continue to capture command
        this.captureEnabled = true;
        return audioBuffer;
      }
    }

    // When using Whisper (original flow)
    if (!audioBuffer || audioBuffer.length === 0) {
      return null;
    }

    // ... rest of existing logic ...
  }
}
```

#### 4.2 Update index.ts (Configuration Loading)

**File**: `src/index.ts`

```typescript
async function main() {
  const config: OrchestratorConfig = {
    // ... existing fields ...

    // Wake word engine
    wakeWordEngine: (process.env.WAKE_WORD_ENGINE as 'whisper' | 'openwakeword') || 'whisper',

    // OpenWakeWord config
    openWakeWordUrl: process.env.OPENWAKEWORD_URL,
    openWakeWordConfidenceThreshold: process.env.OPENWAKEWORD_CONFIDENCE_THRESHOLD
      ? parseFloat(process.env.OPENWAKEWORD_CONFIDENCE_THRESHOLD)
      : 0.5,
    openWakeWordDebug: process.env.OPENWAKEWORD_ENABLE_DEBUG === 'true',
  };

  // Validate configuration
  if (config.wakeWordEngine === 'openwakeword' && !config.openWakeWordUrl) {
    throw new Error('OPENWAKEWORD_URL required when WAKE_WORD_ENGINE=openwakeword');
  }

  // ... rest of main function ...
}
```

---

### Phase 5: Docker Setup

#### 5.1 Create OpenWakeWord Service

**New file**: `docker-compose.yml` additions

```yaml
services:
  openwakeword:
    image: ghcr.io/dscripka/openwakeword:latest
    # Or build from: https://github.com/dscripka/openWakeWord
    container_name: openclaw-openwakeword
    ports:
      - "8082:8082"
    environment:
      # Optional: specify model path
      MODEL_PATH: /models
      # Optional: preload specific models
      PRELOAD_MODELS: "hey_google,alexa"
    volumes:
      - openwakeword-models:/models
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8082/health"]
      interval: 30s
      timeout: 10s
      retries: 3

volumes:
  openwakeword-models:
```

#### 5.2 Update Voice Service Dependencies

```yaml
openclaw-voice:
  depends_on:
    - whisper
    - piper
    - openwakeword  # NEW (optional, fallback if failed)
  environment:
    WAKE_WORD_ENGINE: ${WAKE_WORD_ENGINE:-whisper}
    OPENWAKEWORD_URL: http://openwakeword:8082
```

#### 5.3 Create Custom Dockerfile (Optional)

**New file**: `docker/openwakeword-wrapper/Dockerfile`

```dockerfile
FROM python:3.10-slim

WORKDIR /app

RUN pip install --no-cache-dir \
  openwakeword \
  fastapi \
  uvicorn \
  numpy \
  soundfile \
  requests

COPY app.py .

ENV OPENWAKEWORD_MODELS=/models
RUN mkdir -p $OPENWAKEWORD_MODELS

EXPOSE 8082

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8082"]
```

---

### Phase 6: Testing & Validation

#### 6.1 Unit Tests

**New file**: `src/stt/openwakeword.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import { OpenWakeWordClient } from './openwakeword';

describe('OpenWakeWordClient', () => {
  const client = new OpenWakeWordClient({
    url: 'http://localhost:8082',
    confidenceThreshold: 0.5,
  });

  it('should detect valid wake word', async () => {
    // Mock test with actual audio buffer
    const result = await client.detectWakeWord(
      Buffer.from([...]), // 16-bit PCM audio
      ['hey google']
    );
    expect(result.detected).toBe(true);
  });

  it('should return confidence scores', async () => {
    const result = await client.detectWakeWord(Buffer.from([...]), ['alexa']);
    expect(result.topMatch?.confidence).toBeGreaterThanOrEqual(0);
    expect(result.topMatch?.confidence).toBeLessThanOrEqual(1);
  });

  it('should be healthy', async () => {
    const healthy = await client.isHealthy();
    expect(healthy).toBe(true);
  });
});
```

#### 6.2 Integration Tests

**New file**: `src/orchestrator/orchestrator.openwakeword.integration.test.ts`

```typescript
describe('VoiceOrchestrator with OpenWakeWord', () => {
  it('should use openWakeWord when configured', async () => {
    const config = {
      wakeWordEngine: 'openwakeword',
      openWakeWordUrl: 'http://localhost:8082',
      wakeWord: 'hey assistant',
    };
    
    const orchestrator = new VoiceOrchestrator(config);
    // Test wake word detection flow
  });

  it('should fallback to Whisper if openWakeWord unavailable', async () => {
    // Test failover scenario
  });
});
```

---

### Phase 7: Performance Benchmarks

#### Metrics to Collect:

```
Wake Word Detection Latency:
├─ Whisper (baseline): 500-1500ms
├─ OpenWakeWord (target): <50ms per frame
└─ Total savings: 10-30x faster

CPU Usage:
├─ Whisper: 80-100% (single core during inference)
├─ OpenWakeWord: 5-15% baseline
└─ Memory: 150MB vs 500MB+

Accuracy:
├─ Whisper: ~99% (transcribes to text, then fuzzy match)
├─ OpenWakeWord: ~95-98% (optimized for specific wake words)
└─ False positive rate: <1% baseline
```

---

## Configuration Examples

### Example 1: Fast Wake Word Detection (Production)

```dotenv
# Use lightweight openWakeWord for wake words
WAKE_WORD_ENGINE=openwakeword
OPENWAKEWORD_URL=http://localhost:8082
OPENWAKEWORD_CONFIDENCE_THRESHOLD=0.6      # Strict to avoid false positives

# Whisper still available for debugging/command details
WHISPER_URL=http://localhost:8086
WHISPER_MODEL=tiny
```

### Example 2: Fallback Strategy (Safe)

```dotenv
# Try openWakeWord first, fallback to Whisper if offline
WAKE_WORD_ENGINE=openwakeword
OPENWAKEWORD_URL=http://localhost:8082

# Whisper as automatic fallback (checked in code)
WHISPER_URL=http://localhost:8086
```

### Example 3: Whisper Only (Existing Behavior)

```dotenv
# Keep using Whisper (backward compatible)
WAKE_WORD_ENGINE=whisper
WHISPER_URL=http://localhost:8086
```

---

## Implementation Steps (Sequential)

### Step 1: Setup
- [ ] Research openWakeWord Python library
- [ ] Document model availability and licensing
- [ ] Test openWakeWord with sample audio

### Step 2: HTTP Wrapper
- [ ] Create `docker/openwakeword-wrapper/app.py`
- [ ] Create Dockerfile for wrapper
- [ ] Test HTTP endpoint locally

### Step 3: Client Library
- [ ] Implement `src/stt/openwakeword.ts`
- [ ] Add TypeScript interfaces
- [ ] Add error handling & retry logic

### Step 4: Orchestrator Integration
- [ ] Update `OrchestratorConfig` interface
- [ ] Implement `detectWakeWord()` method
- [ ] Add engine selection logic
- [ ] Implement fallback to Whisper

### Step 5: Configuration
- [ ] Add environment variables
- [ ] Update `.env.example`
- [ ] Document all options

### Step 6: Docker Compose
- [ ] Add `openwakeword` service
- [ ] Test container orchestration
- [ ] Verify networking between services

### Step 7: Testing
- [ ] Unit tests for OpenWakeWordClient
- [ ] Integration tests for engine selection
- [ ] E2E tests with actual audio

### Step 8: Documentation
- [ ] Update README with new architecture
- [ ] Add performance benchmarks
- [ ] Create troubleshooting guide

### Step 9: Optimization (Optional)
- [ ] Model quantization for further speedup
- [ ] Multi-model support (multiple wake words simultaneously)
- [ ] Streaming detection (continuous monitoring)

### Step 10: Deployment
- [ ] Build and publish Docker image
- [ ] Create migration guide
- [ ] Add A/B testing setup

---

## Backward Compatibility

**No breaking changes:**
- Default `WAKE_WORD_ENGINE=whisper` (existing behavior)
- OpenWakeWord is opt-in
- Can run both systems in parallel
- Easy rollback if issues occur

---

## Risk Mitigation

### Risk 1: OpenWakeWord Service Unavailable
**Mitigation**: Automatic fallback to Whisper text matching

### Risk 2: Different Wake Word Accuracy
**Mitigation**: Configurable confidence threshold, run both systems in parallel

### Risk 3: Model Size / Licensing Issues
**Mitigation**: Use official openWakeWord releases, include licensing documentation

### Risk 4: Language/Accent Support
**Mitigation**: OpenWakeWord supports multiple languages, test with target use cases

---

## Success Criteria

- ✅ Wake word detection < 50ms (vs 500ms+ with Whisper)
- ✅ Configurable engine selection
- ✅ Backward compatible (existing Whisper-only setups work unchanged)
- ✅ Automatic fallback to Whisper if openWakeWord unavailable
- ✅ < 1% false positive rate on standard datasets
- ✅ Unit tests with >80% coverage
- ✅ E2E tests with real audio samples

---

## Related Documentation

- [openWakeWord GitHub](https://github.com/dscripka/openWakeWord)
- [Current Wake Word Detection](../README.md#wake-word)
- [VAD Configuration](./CUTIN_LATENCY.md)
- [Fuzzy Matching](./FUZZY_WAKE_WORD.md)
