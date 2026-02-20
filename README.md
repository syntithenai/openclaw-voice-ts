# OpenClaw Voice Service

Independent, stateless voice service for OpenClaw gateway with zero modifications required to the gateway codebase.

**Architecture**: HTTP-based voice orchestration with speech-to-text, agent routing, and text-to-speech synthesis.

## Features

- 🎤 **Speech Capture**: Real-time audio input via PulseAudio
- 🔍 **Voice Activity Detection**: RMS-based speech detection with adaptive noise floor
- 🎯 **Agent Routing**: HTTP hooks to OpenClaw gateway (`/hooks/agent` + `/chat.history`)
- 🎵 **Text-to-Speech**: Piper integration with TTS directives
- ⚡ **Cut-In Support**: Immediate interrupt on user speech (< 50ms target)
- 📋 **Session Management**: Prefix-based session isolation (`voice:*`)
- 🐳 **Docker Ready**: Multi-stage build and docker-compose orchestration

## Architecture

```
Audio Input (PulseAudio)
    ↓
Voice Activity Detector (RMS-based, adaptive noise floor)
    ↓
Captured Audio Frame
    ↓
[LISTENING STATE] ←→ [SENDING STATE]
    ↓                       ↓
    └─→ [WAITING STATE]
            ↓
    [SPEAKING STATE] ← TTS Directives
            ↓
         [CUT-IN CHECK]
            ↓
    Return to LISTENING
```

## Quick Start

### Prerequisites

- Node.js 20+
- PulseAudio (for audio capture)
- ALSA (for audio playback)
- OpenClaw gateway running with hooks enabled
- Whisper API service (for STT)
- Piper service (for TTS)

### Installation

```bash
# Clone and install
git clone <repo>
cd openclaw-voice
npm install

# Copy and configure environment
cp .env.example .env
# Edit .env with your gateway and service URLs
```

### Configuration

See [.env.example](.env.example) for all 24 configuration options:

**Gateway Configuration:**
```bash
GATEWAY_URL=http://localhost:18789
GATEWAY_HOOK_TOKEN=your-bearer-token
GATEWAY_AGENT_ID=assistant
GATEWAY_SESSION_PREFIX=voice:
```

**Service Integration:**
```bash
WHISPER_URL=http://whisper:8086
PIPER_URL=http://piper:5002
```

**Audio:**
```bash
AUDIO_DEVICE=default
AUDIO_SAMPLE_RATE=16000
```

### Local Development

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Run in development mode
npm run dev

# Run tests
npm test
```

### Docker Deployment

```bash
# Build image
docker build -t openclaw-voice .

# Run with compose (includes OpenClaw, Whisper, Piper)
docker-compose up
```

## API Integration

The service uses existing OpenClaw HTTP endpoints:

### Send Transcription to Agent

```http
POST /hooks/agent
Authorization: Bearer <token>
Content-Type: application/json

{
  "sessionKey": "voice:1234567890",
  "agentId": "assistant",
  "userMessage": "What is the weather?"
}

Response:
{
  "runId": "run_abc123",
  "status": "running"
}
```

### Get Conversation History

```http
GET /chat.history?sessionKey=voice:1234567890&limit=10
Authorization: Bearer <token>

Response:
{
  "messages": [
    {
      "role": "user",
      "content": "What is the weather?"
    },
    {
      "role": "assistant",
      "content": "🎵[tts:voiceId=luna,rate=1.0]The weather is sunny and warm today."
    }
  ]
}
```

## TTS Directives

Agent responses can include TTS directives to control voice output:

```
🎵[tts:voiceId=luna,rate=1.0,stability=0.5]Text to speak here
```

**Parameters:**
- `voiceId` (required): Piper voice identifier (e.g., `en_US-amy-medium`)
- `rate` (optional): Speech rate (default 1.0, 0.5-2.0 range)
- `stability` (optional): Voice stability (default 0.5, 0.0-1.0 range)

## Project Structure

```
openclaw-voice/
├── src/
│   ├── audio/           # Audio capture and VAD
│   │   ├── capture.ts   # PulseAudio recording
│   │   ├── vad.ts       # Voice Activity Detection
│   │   └── index.ts
│   ├── gateway/         # OpenClaw integration
│   │   ├── client.ts    # HTTP hooks wrapper
│   │   ├── parser.ts    # TTS directive parsing
│   │   └── index.ts
│   ├── tts/             # Text-to-Speech
│   │   ├── client.ts    # Piper integration
│   │   └── index.ts
│   ├── orchestrator/    # Main event loop
│   │   ├── orchestrator.ts
│   │   └── index.ts
│   ├── utils/           # Utilities
│   │   ├── logger.ts
│   │   └── index.ts
│   └── index.ts         # Entry point
├── tests/               # Test suite
├── docs/                # Documentation
├── Dockerfile           # Multi-stage build
├── docker-compose.yml   # Service orchestration
├── package.json
├── tsconfig.json
├── .env.example
└── README.md (this file)
```

## Development

### Voice State Machine

The orchestrator implements a 6-state cycle:

1. **IDLE**: Waiting to start
2. **LISTENING**: Capturing speech, detecting voice activity
3. **SENDING**: Submitting transcription to agent via HTTP
4. **WAITING**: Polling for agent response
5. **SPEAKING**: Playing TTS audio with cut-in monitoring
6. **ERROR**: Fatal errors (retries after delay)

### Debugging

Enable debug logging:

```bash
LOG_LEVEL=debug npm run dev
```

Watch logs:

```bash
docker logs -f openclaw-voice
```

### Testing

```bash
# Run all tests
npm test

# Run with coverage
npm test -- --coverage

# Watch mode (development)
npm test -- --watch
```

## Performance Targets

- **Audio latency**: < 50ms from speech end to agent response start
- **Cut-in response**: < 50ms from user speech to playback interrupt
- **Agent response time**: Depends on agent, typically 2-5 seconds
- **Memory usage**: < 100MB at rest

## Troubleshooting

### No Audio Input

```bash
# Check PulseAudio
pactl list short sources
parecord --list-devices

# Test audio capture
parecord --format=s16 --rate=16000 --channels=1 /tmp/test.raw
```

### No Audio Output

```bash
# Check ALSA devices
aplay -l

# Test playback
aplay /tmp/test.raw
```

### Gateway Connection Failed

```bash
# Verify gateway is running
curl http://localhost:18789/health

# Check authentication
curl -H "Authorization: Bearer YOUR_TOKEN" http://localhost:18789/hooks/agent
```

### TTS Not Responding

```bash
# Check Piper service
curl http://piper:5002/api/voices

# Test synthesis
curl -X POST http://piper:5002/api/tts \
  -H "Content-Type: application/json" \
  -d '{"text":"Hello","voice":"en_US-amy-medium"}'
```

## Documentation

- [HTTP API Reference](./docs/API.md) - Complete endpoint specifications
- [Architecture Plan](./docs/ARCHITECTURE.md) - Detailed design document
- [Implementation Examples](./docs/EXAMPLES.md) - Working code samples
- [Gateway Configuration](./docs/GATEWAY.md) - OpenClaw hooks setup

## Contributing

Please see [CONTRIBUTING.md](./CONTRIBUTING.md) for development guidelines.

## License

Same as OpenClaw - see [LICENSE](./LICENSE)

## References

- **OpenClaw**: https://github.com/openclaw/openclaw
- **Whisper**: https://github.com/openai/whisper
- **Piper**: https://github.com/rhasspy/piper
- **PulseAudio**: https://www.pulseaudio.org/

## Support

For issues and questions:
1. Check the Troubleshooting section above
2. Review service logs: `docker logs openclaw-voice`
3. Check gateway connectivity: `curl $GATEWAY_URL/health`
4. Verify environment: `cat .env` (don't commit tokens!)
