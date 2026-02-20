# OpenClaw Voice - Quick Reference

## Project Location
```
/home/stever/projects/openclawstuff/openclaw-voice/
```

## Quick Start

```bash
# Install dependencies
npm install

# Development mode (watch + ts-node)
npm run dev

# Build for production
npm run build

# Run compiled
npm start

# Run tests
npm test

# Docker build
docker build -t openclaw-voice .

# Docker compose (full stack)
docker-compose up
```

## Environment Setup

```bash
# Copy template
cp .env.example .env

# Edit with your values
nano .env
```

**Required Variables:**
- `GATEWAY_URL=http://localhost:18789`
- `GATEWAY_HOOK_TOKEN=your-bearer-token`
- `GATEWAY_AGENT_ID=assistant`

**Optional:**
- `PIPER_URL=http://piper:5002` (default)
- `AUDIO_DEVICE=default` (default)
- `LOG_LEVEL=info` (default: info, debug|warn|error)

## Project Structure

```
src/
  ├── audio/          # PulseAudio capture + VAD
  │   ├── capture.ts  # 90 LOC - Stream audio frames
  │   └── vad.ts      # 150 LOC - Detect speech
  ├── gateway/        # HTTP hooks to OpenClaw
  │   ├── client.ts   # 110 LOC - POST & GET endpoints
  │   └── parser.ts   # 110 LOC - Extract TTS directives
  ├── tts/            # Piper integration
  │   └── client.ts   # 120 LOC - Synthesize & play
  ├── orchestrator/   # Main event loop
  │   └── orchestrator.ts # 280 LOC - 6-state machine
  ├── utils/
  │   └── logger.ts   # 45 LOC - Logging utility
  └── index.ts        # 50 LOC - Bootstrap

tests/
  └── setup.test.ts   # Test framework setup

docs/                 # Documentation placeholder
```

## Module Details

### AudioCapture (src/audio/capture.ts)
```typescript
const capture = new AudioCapture(16000, 'default');
for await (const frame of capture.capture()) {
  // 16-bit signed mono PCM frame
}
capture.stop();
```

### VoiceActivityDetector (src/audio/vad.ts)
```typescript
const vad = new VoiceActivityDetector(16000);
const isSpeaking = vad.analyze(frame);
if (vad.isSilenceFinalized()) {
  vad.reset();
}
```

### GatewayClient (src/gateway/client.ts)
```typescript
const client = new GatewayClient(
  'http://localhost:18789',
  'token',
  'assistant'
);

const runId = await client.sendTranscription('session:123', 'hello');
const response = await client.waitForResponse('session:123');
```

### ResponseParser (src/gateway/parser.ts)
```typescript
const directives = ResponseParser.parse(response);
// → [{voiceId: 'luna', rate: 1.0, text: 'Hello'}]

const hasDirectives = ResponseParser.hasDirectives(response);
const text = ResponseParser.getText(response, stripDirectives=true);
```

### TTSClient (src/tts/client.ts)
```typescript
const tts = new TTSClient('http://piper:5002');

const buffer = await tts.synthesize('Hello', 'luna', 1.0);
await tts.playAudio(buffer);

// Or combined
await tts.speak('Hello', 'luna');

// Cut-in support
tts.stopPlayback();
```

### VoiceOrchestrator (src/orchestrator/orchestrator.ts)
```typescript
const orchestrator = new VoiceOrchestrator({
  sessionKey: 'voice:123',
  gatewayUrl: 'http://localhost:18789',
  gatewayToken: 'token',
  agentId: 'assistant'
});

await orchestrator.start();
orchestrator.stop();
console.log(orchestrator.getState()); // 'listening' | 'sending' | etc
```

## API Integration

### Send Transcription
```http
POST /hooks/agent
Authorization: Bearer {token}
Content-Type: application/json

{
  "sessionKey": "voice:123",
  "agentId": "assistant",
  "userMessage": "Hello, what is the weather?"
}
```

### Get Response
```http
GET /chat.history?sessionKey=voice:123&limit=10
Authorization: Bearer {token}
```

## TTS Directives

Format: `🎵[tts:param1=value1,param2=value2]Text to speak here`

Example from agent:
```
🎵[tts:voiceId=luna,rate=1.0,stability=0.5]The weather is sunny today.
```

**Parameters:**
- `voiceId` - Piper voice (e.g., `en_US-amy-medium`)
- `rate` - Speech rate (0.5-2.0, default 1.0)
- `stability` - Voice stability (0.0-1.0, default 0.5)

## Configuration File (.env)

```bash
# OpenClaw Gateway
GATEWAY_URL=http://localhost:18789
GATEWAY_HOOK_TOKEN=your-secure-token
GATEWAY_AGENT_ID=assistant
GATEWAY_SESSION_PREFIX=voice:

# Speech-to-Text (Whisper via separate service)
WHISPER_URL=http://whisper:8086
WHISPER_LANGUAGE=en
WHISPER_MODEL=base

# Text-to-Speech (Piper)
PIPER_URL=http://piper:5002
PIPER_VOICE_ID=en_US-amy-medium
PIPER_RATE=1.0
PIPER_STABILITY=0.5

# Audio Settings
AUDIO_DEVICE=default
AUDIO_SAMPLE_RATE=16000
AUDIO_FRAMES_PER_BUFFER=1024

# Voice Activity Detection Tuning
VAD_SILENCE_THRESHOLD=1.5
VAD_MIN_SILENCE_DURATION_MS=400
VAD_MIN_SPEECH_DURATION_MS=200
VAD_ALPHA_SMOOTHING=0.1
VAD_NOISE_FLOOR_THRESHOLD=0.02
VAD_POLL_INTERVAL_MS=10
VAD_DEBUG_OUTPUT=false

# Playback
PLAYBACK_CUT_IN_TIMEOUT_MS=30000
PLAYBACK_DEVICE=default

# Logging
LOG_LEVEL=info
```

## State Machine

```
                ┌─────────────┐
                │   LISTENING │
                │ (capture)   │
                └──────┬──────┘
                       │ silence detected
                       ▼
                ┌─────────────┐
                │  SENDING    │
                │ (POST text) │
                └──────┬──────┘
                       │ response from /hooks/agent
                       ▼
                ┌─────────────┐
                │  WAITING    │
                │   (poll)    │
                └──────┬──────┘
                       │ new message in /chat.history
                       ▼
                ┌─────────────┐
                │  SPEAKING   │
                │  (playback) │
                └──────┬──────┘
         ┌─────────────┘└──────────────┐
         │ cut-in detected              │ playback complete
         ▼                              ▼
    ┌─────────────┐            ┌──────────────┐
    │ STOP + EXIT │            │ BACK TO      │
    │  (continue) │            │ LISTENING    │
    └─────────────┘            └──────────────┘
```

## Docker Commands

### Build Image
```bash
docker build -t openclaw-voice .
```

### Run Image
```bash
docker run \
  -e GATEWAY_URL=http://host.docker.internal:18789 \
  -e GATEWAY_HOOK_TOKEN=token \
  -e GATEWAY_AGENT_ID=assistant \
  --device /dev/snd \
  -v /run/user/1000/pulse:/run/user/1000/pulse:ro \
  openclaw-voice
```

### Docker Compose
```bash
docker-compose up          # Start all services
docker-compose down        # Stop all services
docker-compose logs -f     # Watch logs
docker-compose ps          # List running
```

## Testing

### Run All Tests
```bash
npm test
```

### Watch Mode
```bash
npm test -- --watch
```

### Coverage Report
```bash
npm test -- --coverage
```

### Single File
```bash
npm test audio.test.ts
```

## Build Output

**Compilation Target**: `dist/` directory

**Files Generated:**
- `dist/index.js` - Compiled entry point
- `dist/**/*.js` - All modules
- `dist/**/*.js.map` - Source maps for debugging
- `dist/**/*.d.ts` - Type definitions

**Build Command:**
```bash
npm run build
```

**Clean Build:**
```bash
npm run clean && npm run build
```

## Debugging

### Enable Debug Logging
```bash
LOG_LEVEL=debug npm run dev
```

### Watch Build Output
```bash
npm run build && tail -f dist/*.js
```

### Check Gateway Connection
```bash
curl -H "Authorization: Bearer $GATEWAY_HOOK_TOKEN" \
  http://localhost:18789/health
```

### Test Audio Capture
```bash
parecord --format=s16 --rate=16000 --channels=1 /tmp/test.raw
paplay /tmp/test.raw
```

### Check Piper Service
```bash
curl http://piper:5002/api/voices
```

## Key Files Reference

| What | Where | Lines |
|------|-------|-------|
| Audio capture | src/audio/capture.ts | 90 |
| Speech detection | src/audio/vad.ts | 150 |
| HTTP to gateway | src/gateway/client.ts | 110 |
| Parse TTS | src/gateway/parser.ts | 110 |
| Piper TTS | src/tts/client.ts | 120 |
| Event loop | src/orchestrator/orchestrator.ts | 280 |
| Entry point | src/index.ts | 50 |
| Logger | src/utils/logger.ts | 45 |
| Config | .env.example | 35 |
| Build | package.json | 34 |
| TypeScript | tsconfig.json | 22 |
| Docker | Dockerfile | 35 |
| Compose | docker-compose.yml | 65 |

## Common Issues

### "No matching version found for dotenv"
→ Use dotenv@16.3.1 (see package.json)

### "Cannot find PulseAudio"
→ Install: `apt install pulseaudio` (Linux)

### "No audio devices"
→ Check: `pactl list short sources`

### "TTS service not responding"
→ Verify Piper URL in .env

### "Gateway connection refused"
→ Check gateway health: `curl $GATEWAY_URL/health`

## Documentation

| File | Purpose |
|------|---------|
| README.md | Complete guide, quick start, troubleshooting |
| CONTRIBUTING.md | Development guidelines, code style, testing |
| IMPLEMENTATION_STATUS.md | Detailed implementation notes |
| PROJECT_COMPLETION_SUMMARY.md | Phase 1 completion status |
| QUICK_REFERENCE.md | This file |

## Getting Help

1. Check **README.md** for usage
2. Check **CONTRIBUTING.md** for development
3. Check logs: `LOG_LEVEL=debug npm run dev`
4. Check docker logs: `docker logs openclaw-voice`
5. Check gateway: `curl $GATEWAY_URL/health`

## Version Info

- **Node.js**: 20+ required
- **TypeScript**: 5.3.0
- **Vitest**: 1.0.0+

## Next Steps

1. Configure `.env` with your gateway details
2. Run `npm install`
3. Run `npm run build` to verify compilation
4. Run `npm run dev` for development
5. Implement Whisper STT integration (Phase 2)
6. Run tests and debug
