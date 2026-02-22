# Raspberry Pi Installation Guide

## ✅ ARM64/ARMv7 Compatibility

**Yes, the orchestrator will run natively on Raspberry Pi!**

### Why It Works:

1. **Docker Base Image**: `node:20-alpine` is multi-architecture (ARM64, ARMv7, x86_64, etc.)
2. **Pure TypeScript/Node.js**: No native bindings except optional WASAPI (Windows-only)
3. **Linux Audio**: Uses PulseAudio/ALSA which work perfectly on ARM
4. **Minimal Dependencies**: Alpine Linux is only 150MB, ideal for RPi resources
5. **Cross-Platform STT/TTS**: Supports remote services (no GPU needed on RPi)

### Hardware Requirements:

- **Minimum**: Raspberry Pi 4B (2GB RAM, dual-core recommended)
- **Recommended**: Raspberry Pi 4B (4GB+ RAM, quad-core)
- **Storage**: 2GB for Docker image + 4GB for audio models (if local)
- **Network**: WiFi or Ethernet for latency-sensitive remote services

---

## 🚀 Quick Start: RPi with Remote Services

### Step 1: Install Docker & Docker Compose

```bash
# Install Docker
curl -fsSL https://get.docker.com/ | sh
sudo usermod -aG docker $USER
newgrp docker

# Install Docker Compose v2
sudo apt-get install docker-compose-plugin

# Verify
docker --version && docker compose version
```

### Step 2: Clone and Configure

```bash
cd /home/pi  # or your preferred directory
git clone <openclaw-voice-repo>
cd openclaw-voice
cp .env.example .env

# Edit .env for your setup
nano .env
```

### Step 3: Remote Services Configuration

For Raspberry Pi, use **remote** Whisper and Piper services (don't run them locally):

```dotenv
# .env for RPi with Remote Services

GATEWAY_URL=ws://192.168.1.100:18789  # Your desktop/server running openclaw-gateway
GATEWAY_AUTH_TOKEN=your-secure-token
GATEWAY_AGENT_ID=assistant

# ===== REMOTE STT (Whisper) =====
# Option A: Whisper running on another machine
WHISPER_URL=http://192.168.1.100:8086
WHISPER_LANGUAGE=en
WHISPER_MODEL=base  # Use 'base' or 'tiny' for RPi memory constraints

# ===== REMOTE TTS (Piper) =====
# Option B: Piper running on another machine  
PIPER_URL=http://192.168.1.100:5002
PIPER_VOICE_ID=en_US-amy-medium

# ===== Audio Configuration (RPi) =====
AUDIO_CAPTURE_DEVICE=default  # USB microphone or built-in
AUDIO_PLAYBACK_DEVICE=default # 3.5mm jack or USB speaker
AUDIO_PLAYBACK=pulse           # Use PulseAudio
AUDIO_SAMPLE_RATE=16000        # Keep at 16kHz for low latency

# ===== VAD Tuning for RPi (slightly less sensitive due to CPU) =====
VAD_SILENCE_THRESHOLD=1.2
VAD_NOISE_FLOOR_THRESHOLD=0.01
VAD_MIN_SPEECH_MS=200
VAD_MIN_SILENCE_MS=400
VAD_ABSOLUTE_RMS=0.02
VAD_ABSOLUTE_SILENCE_RMS=0.01

# ===== Cut-In Tuning =====
CUTIN_ABSOLUTE_RMS=0.02
CUTIN_MIN_SPEECH_MS=150
CUTIN_LATENCY_TARGET_MS=50

# ===== Timeouts (longer for remote services) =====
MAX_LISTEN_MS=30000
PRE_ROLL_MS=1200
TTS_DEDUPE_WINDOW_MS=800

# ===== Wake Word System =====
WAKE_WORD=hey assistant
WAKE_WORD_TIMEOUT=120000  # 2 minutes - long enough for conversations
SLEEP_PHRASE=go to sleep
```

### Step 4: Build and Run

```bash
# Build the Docker image (will auto-detect ARM architecture)
docker compose build openclaw-voice

# Start the service
docker compose up -d openclaw-voice

# Check logs
docker logs -f openclaw-voice

# Verify audio devices (must show at least one microphone/speaker)
docker exec openclaw-voice pactl list short devices
```

---

## 🎙️ Audio Device Setup on RPi

### USB Microphone Setup:

```bash
# List capture devices
docker exec openclaw-voice pactl list short sources

# Output example:
# 0   alsa_input.usb-Burr-Brown_USB_Audio_CODEC-00.analog-stereo   module-alsa-card.c   RUNNING

# Update .env:
AUDIO_CAPTURE_DEVICE=alsa_input.usb-Burr-Brown_USB_Audio_CODEC-00.analog-stereo
```

### 3.5mm Speaker Setup:

```bash
# List playback devices
docker exec openclaw-voice pactl list short sinks

# Output example:
# 0   alsa_output.platform-bcm2711_alsa.stereo-fallback   module-alsa-card.c   RUNNING

# Update .env:
AUDIO_PLAYBACK_DEVICE=alsa_output.platform-bcm2711_alsa.stereo-fallback
```

### Test Audio:

```bash
# Test microphone
docker exec openclaw-voice parecord -d <device_name> --format=s16le -r 16000 - | paplay -

# Test speaker
docker exec openclaw-voice speaker-test -d <device_name> -t sine -f 1000 -l 1
```

---

## 📊 Performance Recommendations

### For RPi 4B with 4GB RAM:

| Setting | RPi Value | Desktop Value | Reason |
|---------|-----------|--------------|--------|
| WHISPER_MODEL | tiny / base | small / medium | Faster inference |
| VAD_MIN_SPEECH_MS | 200 | 150 | More stable detection on single-core |
| CUTIN_MIN_SPEECH_MS | 150 | 100 | Prevent false cut-ins |
| MAX_LISTEN_MS | 30000 | 30000 | OK for remote services |
| Network | WiFi | Network time critical | Wired Ethernet recommended |

### CPU Monitoring:

```bash
# Monitor RPi CPU while running
docker stats openclaw-voice

# Typical idle: 5-15% CPU
# While processing: 50-80% CPU (depends on VAD settings)

# If CPU > 90%, reduce: VAD_DEBUG=false, use smaller WHISPER_MODEL
```

---

## 🌐 Network Architecture

### Recommended Setup:

```
┌─────────────────────────────────────────────────────┐
│  Desktop/Server (192.168.1.100)                    │
│  - openclaw-gateway (port 18789)                   │
│  - Whisper STT (port 8086)                         │
│  - Piper TTS (port 5002)                           │
│  - GPU (optional, for faster inference)            │
└─────────────────────────────────────────────────────┘
         ↑ WiFi or Ethernet
         │
┌─────────────────────────────────────────────────────┐
│  Raspberry Pi (192.168.1.50)                        │
│  - openclaw-voice orchestrator                      │
│  - USB Microphone                                   │
│  - 3.5mm Speaker or USB Speaker                     │
│  - Low CPU/Memory usage (~150MB RAM)                │
└─────────────────────────────────────────────────────┘
```

### Network Optimization:

```bash
# Check network latency to server (should be < 10ms)
docker exec openclaw-voice ping -c 5 192.168.1.100

# If latency > 20ms, consider:
# 1. Use wired Ethernet on RPi (2-5ms improvement)
# 2. Move services to LAN server vs cloud
# 3. Reduce WiFi congestion (change WiFi channel)
```

---

## 🔧 Troubleshooting RPi Installation

### Issue: Out of Memory (OOM)

```bash
# Check memory usage
free -h
docker stats openclaw-voice

# Solution: Use tiny Whisper model
WHISPER_MODEL=tiny  # Uses ~500MB vs 3GB for medium

# Or reduce VAD buffer:
VAD_MIN_SPEECH_MS=100  # Stop accumulating audio sooner
```

### Issue: Audio Not Detected

```bash
# Verify container can access audio
docker exec openclaw-voice arecord -l

# Check PulseAudio
docker exec openclaw-voice pulseaudio --check

# Restart audio
docker exec openclaw-voice pulseaudio -k
sleep 2
docker exec openclaw-voice pulseaudio --start
```

### Issue: High Latency / Slow Responses

```bash
# Check if network is the bottleneck
time curl http://192.168.1.100:8086/transcribe  # Should be < 2s

# Check CPU - reduce sensitivity if overloaded
htop  # Press P to sort by CPU

# Reduce: VAD_DEBUG=false (saves CPU)
#         CUTIN_MIN_SPEECH_MS=200 (fewer VAD checks)
```

### Issue: Wake Word Not Detected

```bash
# Enable VAD debug to see detection
VAD_DEBUG=true

# Docker logs should show RMS values
# If too low: increase AUDIO_CAPTURE_DEVICE microphone gain
# If too high: speak more quietly or reduce sensitivity
```

---

## 🚀 Running Multiple Instances

For redundancy/failover with 2+ Raspberry Pis:

```bash
# RPi-1 (Primary)
GATEWAY_URL=ws://192.168.1.100:18789
GATEWAY_AGENT_ID=assistant-pi1

# RPi-2 (Failover)
GATEWAY_URL=ws://192.168.1.100:18789
GATEWAY_AGENT_ID=assistant-pi2

# Gateway will receive from both, allowing voice input from either location
```

---

## 📈 Advanced: Build Custom RPi Image

For small RPi deployments without Docker:

```bash
# On RPi (no Docker)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
sudo apt-get install -y nodejs

# Clone and install
cd /opt/openclaw-voice
npm ci --only=production

# Run as systemd service (create file: /etc/systemd/system/openclaw-voice.service)
[Unit]
Description=OpenClaw Voice Orchestrator
After=network.target

[Service]
Type=simple
User=pi
WorkingDirectory=/opt/openclaw-voice
Environment="PATH=/usr/local/bin:/usr/bin"
EnvironmentFile=/opt/openclaw-voice/.env
ExecStart=/usr/bin/node dist/index.js
Restart=always

[Install]
WantedBy=multi-user.target

# Enable and start
sudo systemctl enable openclaw-voice
sudo systemctl start openclaw-voice
sudo journalctl -u openclaw-voice -f
```

---

## ✅ Verification Checklist

```bash
☐ Docker and Docker Compose installed
☐ Network can reach gateway server (< 20ms ping)
☐ USB microphone detected and working
☐ Audio speaker/3.5mm connected
☐ .env configured with correct device names
☐ Docker image builds successfully (arm64/armv7)
☐ Service starts without errors
☐ `docker ps` shows "healthy" status
☐ Voice input detected on microphone
☐ Audio properly captured and sent to Whisper
☐ Responses played through speaker
```

---

## 📝 Performance Notes

- **Idle Power**: ~500mA (less than 2.5W) at rest
- **Active Power**: ~1.5A (7-8W) during speech processing
- **Memory Usage**: 150-250MB (much less than server running full stack)
- **Network**: ~1-5Mbps during active use (remote STT/TTS)
- **Typical Round-Trip Latency**: 500-1500ms (limited by TTS synthesis, not hardware)

---

## 🔗 References

- [Raspberry Pi Docker Installation](https://docs.docker.com/engine/install/raspberry-os/)
- [PulseAudio Configuration](https://www.freedesktop.org/wiki/Software/PulseAudio/)
- [Node.js ARM Support](https://nodejs.org/en/download/package-manager/)
