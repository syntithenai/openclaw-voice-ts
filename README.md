# OpenClaw Voice Service

**Real-time voice interaction service for OpenClaw Gateway**

A stateless voice orchestration service providing speech-to-text, voice activity detection, agent routing, and text-to-speech synthesis. Designed as an independent HTTP-based service that integrates with OpenClaw Gateway without requiring gateway code modifications.

---

## ✨ Features

- 🎤 **Real-time Audio Capture**: Platform-native audio (PulseAudio/ALSA on Linux, WASAPI on Windows)
- 🔍 **Voice Activity Detection**: Adaptive RMS-based VAD with noise floor tracking
- 🎯 **Wake Word System**: Configurable wake phrases with timeout-based sleep
- 💬 **Agent Integration**: WebSocket connection to OpenClaw Gateway
- 🎵 **Text-to-Speech**: Piper TTS with directive-based voice control
- ⚡ **Cut-In Detection**: Sub-100ms interrupt when user speech detected during TTS playback
- 🔄 **TTS Deduplication**: Time-windowed duplicate shard protection (800ms default)
- 🌐 **HTTP Control API**: Optional REST endpoints for external orchestration
- 🐳 **Docker Ready**: Multi-container orchestration with Whisper STT and Piper TTS
- 🖥️ **Cross-Platform**: Linux (production), Windows WASAPI (planned), macOS (future)

---

## 🔌 Supported Agent Frameworks

OpenClaw Voice supports multiple AI agent frameworks through a provider interface. Choose the one that matches your setup:

| Provider | Type | Best For | Auth Method | Details |
|----------|------|----------|-------------|---------|
| **OpenClaw** | HTTP Hooks | Full-featured OpenClaw Gateway | Bearer Token | Default, WebSocket capable, TTS emoji directives |
| **ZeroClaw** | HTTP Webhook | Lightweight stateless agents | Bearer Token | Minimal footprint, great for edge devices |
| **TinyClaw** | File Queue | Embedded/IoT devices | File System | No network, message queueing via `~/.tinyclaw/queue/` |
| **IronClaw** | WebSocket | Privacy-first systems | Bearer Token | E2E encrypted, PostgreSQL backend support |
| **MimiClaw** | Dual Mode | ESP32 devices | WebSocket or Telegram | LAN via WebSocket or global via Telegram bot |

**Quick Start**: 
- Already running OpenClaw? Use default `VOICE_CLAW_PROVIDER=openclaw`
- Have a ZeroClaw instance? Set `VOICE_CLAW_PROVIDER=zeroclaw` and provide webhook credentials
- See **[Multi-Provider Support](#-multi-provider-support-zeroclawm-tinyclaw-ironclaw-mimiclaw)** section below for detailed per-provider setup

---

## 🏗️ Architecture

### High-Level Data Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                        OpenClaw Voice Service                        │
├─────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  Microphone → AudioCapture → AudioBuffer → VAD → Orchestrator       │
│                                 ↓                      │              │
│                           [Voice Activity]             │              │
│                                 ↓                      │              │
│                     Speech Detected → Whisper STT     │              │
│                                 ↓                      │              │
│                         Transcription                  │              │
│                                 ↓                      │              │
│                     Gateway WebSocket                  │              │
│                                 ↓                      │              │
│                     Agent Response (with TTS directives)             │
│                                 ↓                      │              │
│                     Piper TTS Synthesis                │              │
│                                 ↓                      │              │
│                     Speaker Playback ←─────────────────┘              │
│                          (Cut-in monitoring during playback)          │
│                                                                       │
└─────────────────────────────────────────────────────────────────────┘
```

### State Machine

The voice orchestrator operates as a state machine:

```
[IDLE] (Initial boot)
   ↓
[LISTENING] ── Speech Detected ──→ [SENDING]
   ↑                                    ↓
   │                          Send to Gateway
   │                                    ↓
   │                               [WAITING]
   │                                    ↓
   │                          TTS Response Ready
   │                                    ↓
   └────── Playback Complete ──── [SPEAKING]
                                        ↓
                                  (Cut-in Check)
                                   User Speaks?
                                     Yes ↓ No
                                  [LISTENING]
```

**States**:
- **IDLE**: Service starting up
- **LISTENING**: Monitoring for speech (wake word check if configured)
- **SENDING**: Transcribing and sending to gateway
- **WAITING**: Waiting for agent response
- **SPEAKING**: TTS playback with cut-in detection

### Wake Word Flow

If `WAKE_WORD` is configured:

```
[SLEEPING] ── Wake Word Detected ──→ [AWAKE/LISTENING]
     ↑                                       ↓
     │                            Speech → Gateway → TTS
     │                                       ↓
     │                              Timeout Expires?
     │                                Yes ↓ No
     └────────── Auto-Sleep ─────── [SLEEPING]
                                            ↓
                               Sleep Phrase Spoken?
                                Yes ↓ No
                             [SLEEPING]
```

**Wake Word Features**:
- Single phrase or array of phrases: `WAKE_WORD=["hey assistant", "ok computer"]`
- Configurable timeout: `WAKE_WORD_TIMEOUT=10000` (10 seconds)
- Sleep phrase: `SLEEP_PHRASE="go to sleep"`
- Punctuation normalization: "Hey, assistant!" matches "hey assistant"
- Timeout starts after TTS completes (not during playback)

---

## 🚀 Quick Start

### Prerequisites

**Runtime**:
- Node.js 20+
- Docker & Docker Compose (for containerized deployment)

**Linux** (production):
- PulseAudio (for audio capture)
- ALSA (for audio playback, fallback)

**Windows** (experimental):
- Visual Studio 2019+ with C++ tools (for WASAPI bindings)
- Windows SDK 10.0+
- Python 3.x (for node-gyp)

**Services**:
- OpenClaw Gateway (HTTP hooks enabled)
- Whisper STT service (faster-whisper or similar)
- Piper TTS service

### Installation

#### Docker Deployment (Recommended)

```bash
# Clone repository
git clone <repository-url>
cd openclaw-voice

# Copy and configure environment
cp .env.example .env
# Edit .env with your configuration (see Configuration section)

# Build and start all services (voice, whisper, piper)
docker compose up --build

# Check logs
docker logs -f openclaw-voice
```

The Docker Compose setup includes:
- `openclaw-voice`: Main orchestrator service
- `whisper`: Faster-whisper STT service (CPU or GPU)
- `piper`: Piper TTS HTTP server

#### Local Development

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Run in development mode (with auto-reload)
npm run dev

# Run compiled service
npm start

# Run tests
npm test
```

**Note**: Local development requires Whisper and Piper services running separately.

---

## ⚡ Quick Start by Provider

Choose your AI agent framework and follow the quick start:

### Docker Quick Start

```bash
cd openclaw-voice
cp .env.example .env
```

**OpenClaw (Default)**:
```bash
# Edit .env
VOICE_CLAW_PROVIDER=openclaw
OPENCLAW_GATEWAY_URL=http://host.docker.internal:18789  # or actual IP
OPENCLAW_GATEWAY_TOKEN=your-token
OPENCLAW_AGENT_ID=assistant

docker compose up --build
```

**ZeroClaw**:
```bash
# Edit .env
VOICE_CLAW_PROVIDER=zeroclaw
ZEROCLAW_GATEWAY_URL=http://localhost:3000
ZEROCLAW_WEBHOOK_TOKEN=webhook-secret

docker compose up --build
```

**TinyClaw**:
```bash
# Prepare TinyClaw
mkdir -p ~/.tinyclaw/queue/{incoming,outgoing}
tinyclaw setup

# Edit .env
VOICE_CLAW_PROVIDER=tinyclaw
TINYCLAW_HOME=~/.tinyclaw

docker compose up --build
```

**IronClaw**:
```bash
# Get token
ironclaw auth login

# Edit .env
VOICE_CLAW_PROVIDER=ironclaw
IRONCLAW_GATEWAY_URL=http://localhost:8888
IRONCLAW_GATEWAY_TOKEN=your-ironclaw-token

docker compose up --build
```

**MimiClaw (WebSocket)**:
```bash
# Flash ESP32 and note device IP (e.g., 192.168.1.100)
# Edit .env
VOICE_CLAW_PROVIDER=mimiclaw
MIMICLAW_DEVICE_HOST=192.168.1.100
MIMICLAW_DEVICE_PORT=18789
MIMICLAW_USE_WEBSOCKET=true

docker compose up --build
```

**MimiClaw (Telegram)**:
```bash
# Create Telegram bot via @BotFather, get token and chat ID
# Edit .env
VOICE_CLAW_PROVIDER=mimiclaw
MIMICLAW_USE_WEBSOCKET=false
MIMICLAW_TELEGRAM_BOT_TOKEN=your-bot-token
MIMICLAW_TELEGRAM_CHAT_ID=your-chat-id

docker compose up --build
```

---

## ⚙️ Configuration

Configuration is managed via environment variables (`.env` file).

### Required Configuration

```bash
# Agent Framework Provider (default: openclaw)
VOICE_CLAW_PROVIDER=openclaw                    # openclaw|zeroclaw|tinyclaw|ironclaw|mimiclaw

# Provider Credentials (varies by provider - see detailed configs below)
OPENCLAW_GATEWAY_URL=http://localhost:18789     # OpenClaw: Gateway URL
OPENCLAW_GATEWAY_TOKEN=your-secure-token        # OpenClaw: Bearer token
OPENCLAW_AGENT_ID=assistant                     # OpenClaw: Agent ID to interact with

# For other providers, see Multi-Provider Support section below for detailed setup
```

**Provider-Specific Setup**: See **[🌐 Multi-Provider Support](#-multi-provider-support-zeroclawm-tinyclaw-ironclaw-mimiclaw)** section for complete configuration instructions for each provider.

### Audio Configuration

```bash
# Audio Device
AUDIO_CAPTURE_DEVICE=default                    # PulseAudio/ALSA capture device name
AUDIO_PLAYBACK_DEVICE=default                   # ALSA playback device (when AUDIO_PLAYBACK=alsa)
AUDIO_SAMPLE_RATE=16000                         # Sample rate (16kHz recommended)

# Audio Playback Mode (Linux only)
AUDIO_PLAYBACK=auto                             # auto|pulse|alsa
```

**Finding your audio devices** (Linux):
```bash
# List PulseAudio capture devices
pactl list sources short

# List ALSA playback devices
aplay -L

# Example capture device name:
#   alsa_input.usb-Device_Name-00.analog-stereo-input

# Example playback device name (ALSA):
#   hw:0,0  or  plughw:0,0  or  default
```

### Voice Activity Detection (VAD)

Fine-tune speech detection sensitivity:

```bash
# Adaptive VAD (recommended for dynamic environments)
VAD_SILENCE_THRESHOLD=1.01                      # Ratio above noise floor (1.0 = disabled)
VAD_NOISE_FLOOR_THRESHOLD=0.01                  # Noise floor factor

# Absolute VAD (recommended for stable environments)
VAD_ABSOLUTE_RMS=0.0015                         # Absolute RMS threshold
VAD_ABSOLUTE_SILENCE_RMS=0.0010                 # Silence threshold

# Timing
VAD_MIN_SPEECH_MS=10                            # Minimum speech duration
VAD_MIN_SILENCE_MS=1000                         # Silence gap before end-of-speech

# Debugging
VAD_DEBUG=true                                  # Enable VAD debug logging
```

**Tuning Tips**:
- **Too sensitive** (triggers on noise): Increase `VAD_ABSOLUTE_RMS`
- **Not sensitive enough** (misses quiet speech): Decrease `VAD_ABSOLUTE_RMS`
- **Cuts off speech early**: Increase `VAD_MIN_SILENCE_MS`
- **Long pause before processing**: Decrease `VAD_MIN_SILENCE_MS`

### Cut-In Detection

Configure interrupt sensitivity during TTS playback:

```bash
CUTIN_ABSOLUTE_RMS=0.004                        # RMS threshold (higher = less sensitive)
CUTIN_MIN_SPEECH_MS=80                          # Minimum duration before interrupt
```

**Tuning Tips**:
- **False triggers from speakers**: Increase `CUTIN_ABSOLUTE_RMS` or `CUTIN_MIN_SPEECH_MS`
- **Too slow to interrupt**: Decrease `CUTIN_MIN_SPEECH_MS`
- **Target**: <100ms interrupt latency from speech start

### Wake Word System

```bash
# Single wake phrase
WAKE_WORD=hey assistant

# Multiple wake phrases (JSON array)
WAKE_WORD=["hey assistant", "ok computer", "hello friend"]

# Timeout before auto-sleep (milliseconds, 0 = disabled)
WAKE_WORD_TIMEOUT=10000

# Sleep command phrase
SLEEP_PHRASE=go to sleep
```

**Behavior**:
- If `WAKE_WORD` is set: System sleeps after timeout, requires wake word
- If `WAKE_WORD` is unset: System always listens (no sleep/wake)
- Timeout starts when TTS finishes (not during playback)
- Sleep phrase can manually trigger sleep

### TTS Deduplication

Prevent duplicate TTS message shards:

```bash
TTS_DEDUPE_WINDOW_MS=800                        # Time window for duplicate detection
```

Only messages within the time window are considered duplicates. Messages outside the window play normally.

### Listening Window

```bash
MAX_LISTEN_MS=30000                             # Maximum listening duration (30s)
PRE_ROLL_MS=1200                                # Audio buffer before speech (1.2s)
```

### Service Integration

```bash
# Whisper STT Service
WHISPER_URL=http://localhost:8086               # Whisper HTTP endpoint
WHISPER_LANGUAGE=en                             # Language code (en, es, fr, etc.)
WHISPER_MODEL=large-v3                          # Model size (tiny|base|small|medium|large|large-v3)

# Piper TTS Service
PIPER_URL=http://localhost:5000                 # Piper HTTP endpoint
PIPER_VOICE_ID=en_US-amy-medium                 # Default voice ID
```

### HTTP Control API (Optional)

Enable external control via HTTP endpoints:

```bash
VOICE_HTTP_PORT=18910                           # Port for HTTP control server (unset = disabled)
```

**Endpoints** (when enabled):
- `GET /health` - Health check
- `GET /status` - Service status and model info
- `POST /control/start` - Enable audio capture
- `POST /control/stop` - Disable audio capture (privacy mode)
- `POST /control/sleep` - Sleep (wait for wake word)
- `POST /control/wake` - Wake up (bypass wake word)

See [SKILL.md](SKILL.md) for full API documentation.

**Security**: No authentication by default - use firewall or reverse proxy for network exposure.

### Advanced Configuration

```bash
# Session Management
GATEWAY_SESSION_PREFIX=voice:                   # Session key prefix

# Timeouts
GATEWAY_CONNECT_TIMEOUT_MS=5000                 # Gateway connection timeout
GATEWAY_READ_TIMEOUT_MS=30000                   # Gateway read timeout

# Logging
LOG_LEVEL=info                                  # debug|info|warn|error
```

---

## � Multi-Provider Support (ZeroClaw, TinyClaw, IronClaw, MimiClaw)

OpenClaw Voice now supports multiple AI agent frameworks through a unified provider interface. Switch between providers via environment variables without code changes.

### Provider Selection

```bash
# Select provider (default: openclaw)
VOICE_CLAW_PROVIDER=openclaw   # openclaw|zeroclaw|tinyclaw|ironclaw|mimiclaw

# Global settings
VOICE_SESSION_PREFIX=voice     # Session key prefix (default: voice)
VOICE_GATEWAY_TIMEOUT=30000    # Request timeout in ms (default: 30000)
```

### Provider-Specific Configuration

#### 1. OpenClaw (Default)

**Authentication Setup:**

The OpenClaw gateway requires a bearer token for authentication.

**Generate Token (in OpenClaw Gateway):**
```bash
# Option A: Environment variable on gateway startup
export OPENCLAW_GATEWAY_TOKEN=your-secret-token

# Option B: Generated JWT token (if supported by your OpenClaw version)
# Contact OpenClaw administrator for issued tokens

# Option C: Extract from gateway logs
docker logs openclaw-openclaw-gateway-1 | grep "Auth token"
```

**Configure OpenClaw Voice:**
```bash
VOICE_CLAW_PROVIDER=openclaw
OPENCLAW_GATEWAY_URL=http://localhost:18789
OPENCLAW_GATEWAY_TOKEN=your-secret-token
OPENCLAW_AGENT_ID=assistant    # Agent to interact with

# Legacy variable names (also supported)
GATEWAY_URL=http://localhost:18789
GATEWAY_AUTH_TOKEN=your-secret-token
GATEWAY_AGENT_ID=assistant
```

**Verification:**
```bash
# Test authentication
curl -H "Authorization: Bearer your-secret-token" \
  http://localhost:18789/health
```

#### 2. ZeroClaw

**Authentication Setup:**

ZeroClaw requires webhook authentication with one-time pairing codes.

**Get Webhook Token (in ZeroClaw):**
```bash
# Run ZeroClaw with webhook expose
zeroclaw start --webhook-expose

# A pairing code appears in logs (6-digit code)
# Exchange for bearer token via pairing endpoint
```

**Configure OpenClaw Voice:**
```bash
VOICE_CLAW_PROVIDER=zeroclaw
ZEROCLAW_GATEWAY_URL=http://localhost:3000
ZEROCLAW_WEBHOOK_TOKEN=webhook-secret

# Optional: Custom channel routing
ZEROCLAW_WEBHOOK_CHANNEL=voice  # Channel to send messages to
```

**Verification:**
```bash
# Test webhook endpoint
curl -H "Authorization: Bearer webhook-secret" \
  -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/json" \
  -d '{"text":"test"}'
```

#### 3. TinyClaw

**Authentication Setup:**

TinyClaw uses file-based queues - no authentication token needed. Access is filesystem-based.

**Prepare TinyClaw Home:**
```bash
# Ensure TinyClaw is initialized
tinyclaw setup

# Verify queue directories exist
ls -la ~/.tinyclaw/queue/
```

**Configure OpenClaw Voice:**
```bash
VOICE_CLAW_PROVIDER=tinyclaw
TINYCLAW_HOME=~/.tinyclaw        # Path to .tinyclaw directory

# Optional: Agent ID
TINYCLAW_AGENT_ID=default        # Which agent to route to
```

**Verification:**
```bash
# Check queue is accessible
ls -la ~/.tinyclaw/queue/incoming
touch ~/.tinyclaw/queue/test.txt && rm ~/.tinyclaw/queue/test.txt
```

#### 4. IronClaw

**Authentication Setup:**

IronClaw requires a bearer token, either from NEAR AI OAuth or OpenAI-compatible endpoint.

**Get Bearer Token (IronClaw):**
```bash
# Option A: NEAR AI OAuth (default)
ironclaw auth login

# Option B: OpenAI-compatible token
# Use your OpenRouter, Together AI, or local LLM provider token

# Option C: Self-hosted with JWT
# Contact IronClaw administrator for issued tokens
```

**Configure OpenClaw Voice:**
```bash
VOICE_CLAW_PROVIDER=ironclaw
IRONCLAW_GATEWAY_URL=http://localhost:8888
IRONCLAW_GATEWAY_TOKEN=bearer-token-here

# Optional: Use HTTP instead of WebSocket
IRONCLAW_USE_WEBSOCKET=true     # true for websocket, false for HTTP polling

# Optional: Agent ID
IRONCLAW_AGENT_ID=default
```

**Verification:**
```bash
# Test WebSocket health
curl -H "Authorization: Bearer bearer-token-here" \
  http://localhost:8888/health
```

#### 5. MimiClaw

**Authentication Setup:**

MimiClaw on ESP32 uses two authentication methods:
1. WebSocket (LAN, no authentication)
2. Telegram bot API (requires bot token)

**Setup MimiClaw Device:**

**Option A: WebSocket (LAN Only)**
```bash
# Flash MimiClaw to ESP32 device
idf.py -p /dev/ttyUSB0 flash

# Configure device via serial CLI
idf.py -p /dev/ttyUSB0 monitor

# In serial prompt:
mimi> wifi_set YOUR_SSID YOUR_PASSWORD
mimi> set_api_key your-anthropic-key
mimi> config_show
```

**Option B: Telegram Bot (Internet Access)**
```bash
# Create Telegram bot via BotFather
# 1. Message @BotFather on Telegram
# 2. /newbot → Enter name → Get bot token
# 3. Save bot token (starts with digits:)

# Configure device to use Telegram
mimi> set_tg_token YOUR_BOT_TOKEN
mimi> set_tg_chat_id YOUR_CHAT_ID
mimi> config_show
```

**Configure OpenClaw Voice:**

**WebSocket Mode (LAN):**
```bash
VOICE_CLAW_PROVIDER=mimiclaw
MIMICLAW_DEVICE_HOST=192.168.1.100    # ESP32 device IP
MIMICLAW_DEVICE_PORT=18789             # Default WebSocket port
MIMICLAW_USE_WEBSOCKET=true            # Enable WebSocket
```

**Telegram Mode (Internet):**
```bash
VOICE_CLAW_PROVIDER=mimiclaw
MIMICLAW_USE_WEBSOCKET=false           # Disable WebSocket, use Telegram
MIMICLAW_TELEGRAM_BOT_TOKEN=your-bot-token
MIMICLAW_TELEGRAM_CHAT_ID=your-chat-id
```

**Verification:**

WebSocket:
```bash
# Ping device (requires nc/netcat)
nc -zv 192.168.1.100 18789
```

Telegram:
```bash
# Test bot token
curl https://api.telegram.org/bot{YOUR_TOKEN}/getMe
```

---

## �🎵 TTS Directives

Agent responses can include TTS directives to control voice output.

### Basic Syntax

```
🎵[tts:voiceId=en_US-amy-medium,rate=1.0,stability=0.5]Text to speak here
```

The emoji `🎵` (U+1F3B5) marks the message for TTS processing.

### Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `voiceId` | string | `PIPER_VOICE_ID` | Piper voice identifier |
| `rate` | float | 1.0 | Speech speed (0.5-2.0) |
| `stability` | float | 0.5 | Voice stability (0.0-1.0) |

### Examples

**Simple TTS**:
```
🎵[tts]Hello, how can I help you today?
```

**Custom voice**:
```
🎵[tts:voiceId=en_US-libritts-high]I'm using a different voice model.
```

**Slow, stable speech**:
```
🎵[tts:rate=0.8,stability=0.8]I will speak slowly and clearly.
```

**Fast, expressive speech**:
```
🎵[tts:rate=1.3,stability=0.3]Let me tell you excitedly about this!
```

### Available Voices

Piper supports 100+ voices across languages. Common English voices:

- `en_US-amy-medium` (default) - Female, neutral
- `en_US-libritts-high` - Female, high quality
- `en_US-joe-medium` - Male, casual
- `en_GB-alan-medium` - British male
- `en_GB-jenny-medium` - British female

List available voices:
```bash
curl http://localhost:5000/voices
```

Download additional voices from [Piper voices repository](https://github.com/rhasspy/piper/blob/master/VOICES.md).

---

## 🔌 OpenClaw Gateway Integration

The voice service integrates with OpenClaw Gateway via WebSocket for real-time bidirectional communication.

### Connection

The service establishes a WebSocket connection to the gateway using the configured URL and authentication token:

```bash
GATEWAY_URL=ws://openclaw-gateway:18789
GATEWAY_AUTH_TOKEN=your-secure-token
GATEWAY_AGENT_ID=assistant
```

### Message Flow

1. **User speaks** → Voice detected by VAD
2. **Audio captured** → Sent to Whisper for transcription
3. **Transcription** → Sent to gateway via WebSocket (`sendMessage`)
4. **Gateway processes** → Routes to specified agent
5. **Agent responds** → Sent back via WebSocket with TTS directives
6. **TTS synthesis** → Piper converts text to speech
7. **Audio playback** → User hears response

### Gateway Requirements

1. **WebSocket Support**: Gateway must support WebSocket connections
2. **Authentication**: Bearer token configured (`GATEWAY_AUTH_TOKEN`)
3. **Session Isolation**: Prefix-based session keys (`voice:*`)
4. **TTS Directives**: Agent responses include `🎵[tts:...]` markers

---

## 📁 Project Structure

```
openclaw-voice/
├── src/
│   ├── audio/                      # Audio capture and voice activity
│   │   ├── interface.ts            # Platform-agnostic interfaces
│   │   ├── capture.ts              # Factory for audio capture
│   │   ├── capture-linux.ts        # Linux PulseAudio implementation
│   │   ├── capture-wasapi.ts       # Windows WASAPI implementation (stub)
│   │   ├── vad.ts                  # Voice Activity Detector
│   │   ├── wav.ts                  # WAV file utilities
│   │   └── index.ts
│   ├── gateway/                    # Gateway integration
│   │   ├── client.ts               # WebSocket/HTTP client
│   │   ├── parser.ts               # TTS directive parser
│   │   └── index.ts
│   ├── orchestrator/               # Main state machine
│   │   ├── orchestrator.ts         # Voice orchestration logic
│   │   └── index.ts
│   ├── stt/                        # Speech-to-text
│   │   ├── client.ts               # Whisper HTTP client
│   │   └── index.ts
│   ├── tts/                        # Text-to-speech
│   │   ├── interface.ts            # Platform-agnostic interfaces
│   │   ├── client.ts               # Factory for TTS client
│   │   ├── client-linux.ts         # Linux ALSA/PulseAudio implementation
│   │   ├── client-wasapi.ts        # Windows WASAPI implementation (stub)
│   │   └── index.ts
│   ├── utils/                      # Utilities
│   │   ├── logger.ts               # Logging utility
│   │   └── index.ts
│   ├── native/                     # Native bindings
│   │   └── wasapi/                 # Windows WASAPI C++ bindings (stub)
│   │       ├── wasapi.cc           # Main entry point
│   │       ├── capture.cc          # Audio capture
│   │       └── playback.cc         # Audio playback
│   └── index.ts                    # Service entry point
├── docker/                         # Docker service images
│   ├── whisper/                    # Faster-whisper STT
│   ├── piper1-gpl/                 # Piper TTS HTTP server
│   ├── piper-models/               # Piper voice models
│   └── piper-data/                 # Piper runtime data
├── scripts/                        # Build and utility scripts
│   └── optional-build.js           # Conditional WASAPI build
├── tests/                          # Test suite
├── docs/                           # Documentation
├── Dockerfile                      # Multi-stage build
├── docker-compose.yml              # Service orchestration
├── binding.gyp                     # Native bindings build config
├── package.json                    # NPM dependencies
├── tsconfig.json                   # TypeScript config
├── .env.example                    # Configuration template
├── SKILL.md                        # HTTP API skill documentation
├── CROSSPLATFORM_PLAN.md           # Windows/macOS porting plan
└── README.md                       # This file
```

---

## 🐳 Docker Compose Services

### openclaw-voice

Main orchestration service.

**Configuration**: Via environment variables in `.env`

**Volumes**:
- `/run/user/1000/pulse:/run/user/1000/pulse` - PulseAudio socket
- `/home/<user>/.config/pulse/cookie:/home/node/.config/pulse/cookie:ro` - Auth cookie
- `./test-data:/test-data:ro` - Optional test audio files

**Devices**:
- `/dev/snd:/dev/snd` - Audio device access

**Networks**:
- `openclaw_default` (external) - Shared with OpenClaw Gateway
- `default` - Internal network with Whisper/Piper

**Ports**:
- `18910:18910` - HTTP control API (if `VOICE_HTTP_PORT` set)

### whisper

Faster-whisper STT service (CPU or GPU).

**Image**: Custom build from `docker/whisper/`

**Ports**: `8086:8080`

**Environment**:
- `WHISPER_MODEL`: Model size (tiny|base|small|medium|large|large-v3)
- `WHISPER_DEVICE`: cpu|cuda
- `WHISPER_COMPUTE_TYPE`: int8|float16|float32

**Volumes**:
- `./whisper-models:/models` - Model cache

### piper

Piper TTS HTTP server.

**Image**: Custom build from `docker/piper1-gpl/`

**Ports**: `5002:5000`

**Command**: `["server", "--model", "en_US-amy-medium"]`

**Volumes**:
- `./docker/piper-models:/home/piper/.local/share/piper` - Voice models
- `./docker/piper-data:/data` - Runtime data

---

## 🔧 Troubleshooting

### Audio Issues

**No audio capture / "parecord not found"**:
```bash
# Install PulseAudio
sudo apt install pulseaudio pulseaudio-utils

# Check PulseAudio is running
pulseaudio --check && echo "Running" || echo "Not running"

# List audio devices
pactl list sources short
```

**Wrong audio device selected**:
```bash
# List devices
docker exec openclaw-voice pactl list sources short

# Update .env with correct device name
AUDIO_CAPTURE_DEVICE=alsa_input.usb-<your-device>.analog-stereo-input
```

**Audio playback not working**:
```bash
# Check playback mode
grep AUDIO_PLAYBACK .env

# Test with paplay (PulseAudio)
docker exec openclaw-voice paplay /test-data/test.wav

# Test with aplay (ALSA)
docker exec openclaw-voice aplay /test-data/test.wav
```

**Permission denied on `/dev/snd`**:
```bash
# Add user to audio group
sudo usermod -aG audio $USER

# Logout and login for group change to take effect
```

### VAD Issues

**Too sensitive (triggers on silence)**:
```bash
# Increase absolute RMS threshold
VAD_ABSOLUTE_RMS=0.002  # was 0.0015

# Enable debug logging to see RMS values
VAD_DEBUG=true
```

**Not sensitive enough (misses speech)**:
```bash
# Decrease absolute RMS threshold
VAD_ABSOLUTE_RMS=0.001  # was 0.0015

# Decrease minimum speech duration
VAD_MIN_SPEECH_MS=5     # was 10
```

**Cuts off end of speech**:
```bash
# Increase silence duration before end-of-speech
VAD_MIN_SILENCE_MS=1500  # was 1000
```

### Gateway Connection Issues

**Connection refused**:
```bash
# Check gateway is running
docker ps | grep openclaw-gateway

# Check gateway URL in .env
GATEWAY_URL=ws://openclaw-openclaw-gateway-1:18789  # Docker network
# or
GATEWAY_URL=http://localhost:18789                   # Host network

# Test gateway connectivity
docker exec openclaw-voice curl -I http://openclaw-openclaw-gateway-1:18789/health
```

**Authentication failed**:
```bash
# Verify token is correct
grep GATEWAY_AUTH_TOKEN .env

# Check token in gateway configuration
docker exec openclaw-gateway env | grep AUTH_TOKEN
```

**Messages not appearing in gateway**:
```bash
# Check session key prefix
grep SESSION_PREFIX .env  # Should match gateway config

# Verify agent ID exists
grep GATEWAY_AGENT_ID .env

# Check gateway logs
docker logs openclaw-gateway
```

### STT/TTS Issues

**Whisper service not responding**:
```bash
# Check Whisper is running
docker ps | grep whisper

# Test Whisper directly
curl -X POST http://localhost:8086/v1/audio/transcriptions \
  -F "file=@test-audio.wav" \
  -F "model=large-v3"

# Check Whisper logs
docker logs openclaw-voice-whisper-1
```

**Piper service not responding**:
```bash
# Check Piper is running
docker ps | grep piper

# Test Piper directly
curl http://localhost:5002/voices

# Test TTS synthesis
curl -X POST http://localhost:5002/ \
  -H "Content-Type: application/json" \
  -d '{"text":"Hello world"}' \
  --output test.wav

# Check Piper logs
docker logs openclaw-voice-piper-1
```

**TTS not playing / silent**:
```bash
# Check TTS directives in agent response
docker logs openclaw-voice | grep "TTS"

# Verify audio playback works
docker exec openclaw-voice paplay /test-data/test.wav

# Check for playback process
docker exec openclaw-voice ps aux | grep -E "paplay|aplay"
```

### Wake Word Issues

**Wake word not detected**:
```bash
# Check wake word configuration
grep WAKE_WORD .env

# Enable VAD debug to see speech detection
VAD_DEBUG=true

# Check for punctuation normalization
# "Hey, assistant!" should match "hey assistant"
```

**System doesn't go to sleep**:
```bash
# Verify timeout is set
grep WAKE_WORD_TIMEOUT .env  # Should be > 0

# Check if wake word is configured
# If no wake word, timeout is disabled
```

**Sleep phrase not working**:
```bash
# Verify sleep phrase is set
grep SLEEP_PHRASE .env

# Check if phrase is being transcribed
docker logs openclaw-voice | grep -i "sleep"
```

### HTTP Control API Issues

**HTTP endpoints not responding**:
```bash
# Check if HTTP server is enabled
grep VOICE_HTTP_PORT .env  # Must be set

# Test health endpoint
curl http://localhost:18910/health

# Check service logs
docker logs openclaw-voice | grep "HTTP server"
```

**Status endpoint shows unhealthy models**:
```bash
# Check service status
curl http://localhost:18910/status | jq .

# If whisperHealthy=false: Check Whisper service
docker logs openclaw-voice-whisper-1

# If ttsHealthy=false: Check Piper service
docker logs openclaw-voice-piper-1
```

### Cut-In Issues

**Cut-in detection triggers on TTS playback**:
```bash
# Increase cut-in RMS threshold
CUTIN_ABSOLUTE_RMS=0.005  # was 0.004

# Increase minimum speech duration
CUTIN_MIN_SPEECH_MS=100   # was 80
```

**Cut-in too slow to interrupt**:
```bash
# Decrease minimum speech duration
CUTIN_MIN_SPEECH_MS=50    # was 80

# Check cut-in latency in logs
docker logs openclaw-voice | grep "CUT-IN-LATENCY"
```

### Debug Logging

Enable verbose logging for troubleshooting:

```bash
# In .env
LOG_LEVEL=debug
VAD_DEBUG=true

# Restart service
docker compose down
docker compose up

# Watch logs in real-time
docker logs -f openclaw-voice
```

---

## � Provider-Specific Troubleshooting

### OpenClaw

**Gateway connection refused**:
```bash
# Verify gateway is running
docker ps | grep openclaw-gateway

# Test gateway directly
curl -H "Authorization: Bearer ${OPENCLAW_GATEWAY_TOKEN}" \
  http://localhost:18789/health
```

**Bearer token rejected**:
```bash
# Check token format (should be alphanumeric)
echo $OPENCLAW_GATEWAY_TOKEN

# Re-generate token from gateway and update .env
docker logs openclaw-gateway | grep -i "token"

# Verify token in environment
docker exec openclaw-voice env | grep OPENCLAW_GATEWAY
```

### ZeroClaw

**Webhook endpoint returns 404**:
```bash
# Verify ZeroClaw is running and webhook enabled
zeroclaw status

# Check webhook address
zeroclaw config | grep webhook

# Ensure endpoint path is /webhook
curl http://localhost:3000/webhook -v
```

**Webhook authentication fails**:
```bash
# Re-generate webhook token  
zeroclaw webhook generate

# Verify token format
echo $ZEROCLAW_WEBHOOK_TOKEN

# Test endpoint with token
curl -H "Authorization: Bearer ${ZEROCLAW_WEBHOOK_TOKEN}" \
  -X POST http://localhost:3000/webhook \
  -d '{"text":"test"}'
```

**Cannot reach ZeroClaw instance**:
```bash
# Check if ZeroClaw is running
ps aux | grep zeroclaw

# Verify network connectivity
telnet localhost 3000   # or: nc -zv localhost 3000

# Check firewall rules
sudo ufw status | grep 3000
```

### TinyClaw

**Queue directory not found**:
```bash
# Create queue structure
mkdir -p ~/.tinyclaw/queue/{incoming,outgoing,dead-letter}

# Verify permissions
ls -la ~/.tinyclaw/queue/

# Re-initialize TinyClaw
tinyclaw init
```

**Messages not being processed**:
```bash
# Check incoming queue has files
ls -la ~/.tinyclaw/queue/incoming/

# Verify TinyClaw is running
ps aux | grep tinyclaw

# Check permissions on queue directory
stat ~/.tinyclaw/queue/incoming/ | grep Access: | grep 777

# Fix permissions if needed
chmod -R 777 ~/.tinyclaw/queue/
```

**Cannot read conversation history**:
```bash
# Check if JSONL files exist
ls -la ~/.tinyclaw/queue/conversations/

# Verify JSONL format
head ~/.tinyclaw/queue/conversations/*.jsonl

# Clear corrupted history and start fresh
rm ~/.tinyclaw/queue/conversations/*
```

**Messages timeout waiting for response**:
```bash
# Check TinyClaw is processing outgoing files
ls -la ~/.tinyclaw/queue/outgoing/

# Increase timeout in .env
VOICE_GATEWAY_TIMEOUT=60000  # was 30000

# Verify TinyClaw agent is responding
tinyclaw status
```

### IronClaw

**WebSocket connection times out**:
```bash
# Verify IronClaw is listening on configured port
netstat -tuln | grep 8888    # or: ss -tuln | grep 8888

# Test connectivity
timeout 5 bash -c "echo > /dev/tcp/localhost/8888" && echo "Connected" || echo "Failed"

# Check IronClaw logs
ironclaw logs
```

**Bearer token invalid for IronClaw**:
```bash
# If using NEAR AI oauth:
ironclaw auth status

# If using OpenAI-compatible token:
curl -H "Authorization: Bearer ${IRONCLAW_GATEWAY_TOKEN}" \
  http://localhost:8888/health

# Re-authenticate if needed
ironclaw auth login
```

**HTTP endpoint (fallback) not working**:
```bash
# Verify HTTP endpoint is available
curl http://localhost:8888/health

# Check if fallback is enabled
grep IRONCLAW_USE_WEBSOCKET .env
```

**Cannot connect to/query memory endpoint**:
```bash
# Check if memory endpoint exists
curl http://localhost:8888/api/memory

# If SSE not supported, service falls back gracefully
# Verify service logs show memory endpoint handling
docker logs openclaw-voice | grep -i memory
```

### MimiClaw

**WebSocket device not found**:
```bash
# Ping device on network
ping 192.168.1.100  # Replace with your ESP32 IP

# Verify device is connected to WiFi
nmap -p 18789 192.168.1.100

# Check ESP32 device serial console
screen /dev/ttyUSB0 115200
# Type: config_show
```

**Cannot connect to device on port 18789**:
```bash
# Check firewall not blocking connections
sudo ufw allow 18789

# Test WebSocket port directly
wscat -c ws://192.168.1.100:18789

# Restart device
# On ESP32: Type: restart
```

**Telegram bot not responding**:
```bash
# Verify bot token format
echo $MIMICLAW_TELEGRAM_BOT_TOKEN
# Should start with digits followed by colon and alphanumeric

# Test bot token
curl https://api.telegram.org/bot${MIMICLAW_TELEGRAM_BOT_TOKEN}/getMe

# Verify chat ID is numeric and correct
docker exec openclaw-voice env | grep MIMICLAW_TELEGRAM_CHAT_ID
```

**Telegram messages not being sent**:
```bash
# Check Telegram API credentials
curl -X POST https://api.telegram.org/bot${MIMICLAW_TELEGRAM_BOT_TOKEN}/sendMessage \
  -H "Content-Type: application/json" \
  -d '{"chat_id":"'${MIMICLAW_TELEGRAM_CHAT_ID}'","text":"test"}'

# Verify chat ID is correct (get from @userinfobot on Telegram)
# Verify bot has permission to send messages to that chat
```

**Switching between WebSocket and Telegram fails**:
```bash
# Only one mode can be active
# Verify only one is enabled
grep -E "MIMICLAW_USE_WEBSOCKET|MIMICLAW_TELEGRAM" .env

# If using WebSocket:
MIMICLAW_USE_WEBSOCKET=true
# (unset Telegram variables)

# If using Telegram:
MIMICLAW_USE_WEBSOCKET=false
MIMICLAW_TELEGRAM_BOT_TOKEN=bot-token
MIMICLAW_TELEGRAM_CHAT_ID=chat-id
```

---

## �📊 Performance

### Latency Targets

| Stage | Target | Typical |
|-------|--------|---------|
| Audio capture to VAD | <10ms | 5-8ms |
| VAD speech detection | <50ms | 20-30ms |
| STT transcription (Whisper large-v3) | <2s | 1-1.5s |
| Gateway agent response | <3s | 1-2s |
| TTS synthesis (Piper) | <500ms | 200-400ms |
| TTS playback start | <100ms | 50-80ms |
| **Cut-in interrupt** | **<100ms** | **50-80ms** |
| **End-to-end (user speech → TTS start)** | **<6s** | **3-4s** |

### Resource Usage

**Docker Containers** (typical):
- `openclaw-voice`: 50-100MB RAM, <5% CPU
- `whisper` (large-v3, CPU): 4-6GB RAM, 50-100% CPU during transcription
- `piper`: 200-500MB RAM, 10-20% CPU during synthesis

**Optimizations**:
- Use **Whisper `base` or `small`** models for faster transcription (1GB RAM vs 6GB)
- Enable **GPU acceleration** for Whisper (`WHISPER_DEVICE=cuda`)
- Use **lower sample rate** for voice (16kHz is sufficient, 48kHz wastes bandwidth)
- Enable **TTS deduplication** to reduce redundant playback (`TTS_DEDUPE_WINDOW_MS=800`)

---

## 🌐 Cross-Platform Support

### Current Platform Support

| Platform | Audio Capture | Audio Playback | Status |
|----------|---------------|----------------|--------|
| **Linux** | PulseAudio/ALSA | PulseAudio/ALSA | ✅ Production |
| **Windows** | WASAPI (native) | WASAPI (native) | 🚧 Planned (stub implemented) |
| **macOS** | CoreAudio | CoreAudio | 📋 Future |

### Windows Support (Planned)

The codebase includes platform detection and WASAPI native binding stubs for Windows support.

**Current Status**:
- ✅ Platform-agnostic audio interfaces defined
- ✅ Windows WASAPI capture/playback TypeScript wrappers
- ✅ C++ WASAPI binding structure (Node-API)
- ✅ Conditional build script (only builds on Windows)
- 🚧 WASAPI C++ implementation incomplete (stubs)

**To complete Windows support**:
1. Implement `InitializeWASAPI()` in `src/native/wasapi/capture.cc`
2. Implement `GetFrame()` async Promise wrapper
3. Implement `WriteBuffer()` in `src/native/wasapi/playback.cc`
4. Build and test on Windows 10/11
5. Document Windows-specific setup

See [CROSSPLATFORM_PLAN.md](CROSSPLATFORM_PLAN.md) for full Windows porting details.

**Why WASAPI?**:
- 15-30ms latency (vs 100-200ms with FFmpeg subprocess)
- Native Windows API (no external dependencies)
- Shared mode (compatible) or exclusive mode (low-latency)

---

## 🧪 Testing

```bash
# Run all tests
npm test

# Run specific test file
npm test -- audio/vad.test.ts

# Run with coverage
npm test -- --coverage

# Watch mode
npm test -- --watch
```

---

## 🤝 Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development guidelines.

**Quick Contribution Checklist**:
- [ ] Code follows TypeScript best practices
- [ ] Tests added for new features
- [ ] Documentation updated (README, SKILL.md)
- [ ] `.env.example` updated if new config added
- [ ] No breaking changes without migration plan
- [ ] Docker build succeeds
- [ ] Manual testing on Linux

---

## 📋 Implementation Status

✅ **Completed**:
- Real-time audio capture (Linux PulseAudio/ALSA)
- Voice Activity Detection (adaptive + absolute RMS)
- Whisper STT integration
- OpenClaw Gateway HTTP hooks integration
- TTS directive parsing and Piper integration
- Audio playback with cut-in detection
- Wake word system with array support and timeout
- Time-windowed TTS deduplication
- HTTP control API with start/stop/sleep/wake endpoints
- Docker Compose orchestration
- Cross-platform architecture (platform detection)
- WASAPI binding stubs (Windows)

🚧 **In Progress**:
- Windows WASAPI native implementation (C++ bindings)

📋 **Planned**:
- macOS CoreAudio support
- Web configuration UI
- Performance metrics and monitoring
- Advanced VAD algorithms (WebRTC VAD, Silero VAD)
- Streaming STT (partial transcription)
- Multi-language support
- Voice cloning integration

---

## 📄 License

See LICENSE file in repository.

---

## 🙋 Support

**Documentation**:
- [SKILL.md](SKILL.md) - HTTP Control API reference
- [CROSSPLATFORM_PLAN.md](CROSSPLATFORM_PLAN.md) - Windows/macOS porting plan
- [.env.example](.env.example) - Configuration reference

**Logs**:
```bash
# View service logs
docker logs -f openclaw-voice

# View all service logs
docker compose logs -f
```

**Health Check**:
```bash
# Check service health
curl http://localhost:18910/health

# Check detailed status
curl http://localhost:18910/status | jq .
```

**Community**:
- GitHub Issues: Report bugs and feature requests
- Discussions: Ask questions and share feedback
- Pull Requests: Contribute improvements

---

## 🎯 Use Cases

**Personal Voice Assistant**:
- "Hey assistant, what's the weather today?"
- "Set a reminder for 3 PM"
- "Play my morning playlist"

**Home Automation**:
- "Turn off the living room lights"
- "Set thermostat to 72 degrees"
- "Lock the front door"

**Productivity**:
- "Add 'buy groceries' to my todo list"
- "Schedule a meeting for tomorrow at 10 AM"
- "What's on my calendar today?"

**Information Retrieval**:
- "What's the latest news on AI?"
- "How do I make sourdough bread?"
- "What time is it in Tokyo?"

**Development Testing**:
- Test voice interfaces before deploying to production
- Prototype voice-enabled applications
- Benchmark speech recognition accuracy

---

**Built with OpenClaw Gateway integration** • **Powered by Whisper STT and Piper TTS** • **Designed for real-time voice interaction**
