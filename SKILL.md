---
name: openclaw-voice-control
description: Control the openclaw-voice service via HTTP endpoints. Use when a user asks to start/stop voice capture, put the voice assistant to sleep/wake it up, check voice service status, or control the voice orchestrator remotely.
---

# OpenClaw Voice Control API

## Overview

The openclaw-voice service provides an optional HTTP control API for external orchestration and monitoring. This API allows you to programmatically control audio capture, manage wake word behavior, and query service status without restarting the service.

**Important**: The HTTP control server is **optional** and **disabled by default**. It only runs when the `VOICE_HTTP_PORT` environment variable is set.

## Enabling the HTTP Control Server

Add to your `.env` file:

```bash
# Enable HTTP control server on port 18910
VOICE_HTTP_PORT=18910
```

Without this variable, the service runs in standalone mode with no HTTP API.

## Available Endpoints

### Health Check

**GET** `/health`

Simple health check endpoint.

**Response**:
```json
{
  "ok": true
}
```

**Example**:
```bash
curl http://localhost:18910/health
```

### Service Status

**GET** `/status`

Get detailed voice service status including readiness, models, and state.

**Response**:
```json
{
  "captureEnabled": true,
  "isAwake": true,
  "state": "listening",
  "whisperHealthy": true,
  "ttsHealthy": true,
  "whisperModel": "base.en",
  "ttsVoice": "en_US-amy-medium",
  "wakeWord": "hey dipshit",
  "hasWakeWord": true
}
```

**Example**:
```bash
curl http://localhost:18910/status
```

**Use cases**:
- Monitor service health from external monitoring tools
- Display voice assistant status in home automation dashboards
- Check if models are loaded and ready
- Verify wake word configuration

### Start Audio Capture

**POST** `/control/start`

Enable audio capture. The microphone will start listening for speech.

**Response**:
```json
{
  "ok": true,
  "captureEnabled": true
}
```

**Example**:
```bash
curl -X POST http://localhost:18910/control/start
```

**Use cases**:
- Resume voice listening after manual pause
- Trigger voice activation from external button/switch
- Restore capture after privacy mode

### Stop Audio Capture

**POST** `/control/stop`

Disable audio capture. The microphone stops listening completely (privacy mode).

**Response**:
```json
{
  "ok": true,
  "captureEnabled": false
}
```

**Example**:
```bash
curl -X POST http://localhost:18910/control/stop
```

**Use cases**:
- Privacy mode: completely disable microphone
- Pause voice listening during meetings/calls
- Remote kill switch for audio capture
- Integration with physical mute buttons

**Note**: This is different from `sleep` - capture is completely disabled, not just waiting for wake word.

### Sleep (Wait for Wake Word)

**POST** `/control/sleep`

Put the assistant to sleep. It will stop processing voice input until the wake word is spoken.

**Response**:
```json
{
  "ok": true,
  "isAwake": false
}
```

**Example**:
```bash
curl -X POST http://localhost:18910/control/sleep
```

**Use cases**:
- Manual sleep command from external interface
- Schedule sleep during specific hours
- Trigger sleep after completing a task
- Integration with "goodnight" routines

**Behavior**:
- Audio capture continues (microphone still listening)
- Only listens for the configured wake word
- Transcription and gateway messages disabled
- Automatically wakes when wake word is detected

### Wake (Start Processing)

**POST** `/control/wake`

Wake the assistant. It will start processing all voice input immediately.

**Response**:
```json
{
  "ok": true,
  "isAwake": true
}
```

**Example**:
```bash
curl -X POST http://localhost:18910/control/wake
```

**Use cases**:
- Manual wake command from external interface
- Schedule wake at specific times
- Trigger wake from automation rules
- Integration with "good morning" routines

**Note**: This bypasses the wake word requirement until the next sleep.

## Integration Examples

### Home Assistant Automation

```yaml
# Turn off voice during phone calls
automation:
  - alias: "Mute voice during calls"
    trigger:
      - platform: state
        entity_id: sensor.phone_state
        to: "ringing"
    action:
      - service: rest_command.voice_stop

rest_command:
  voice_stop:
    url: http://openclaw-voice:18910/control/stop
    method: POST
  voice_start:
    url: http://openclaw-voice:18910/control/start
    method: POST
```

### Cron-based Sleep Schedule

```bash
# Sleep at 11 PM, wake at 7 AM
0 23 * * * curl -X POST http://localhost:18910/control/sleep
0 7 * * * curl -X POST http://localhost:18910/control/wake
```

### Physical Button Integration

```python
#!/usr/bin/env python3
import RPi.GPIO as GPIO
import requests

BUTTON_PIN = 17
VOICE_URL = "http://localhost:18910"

GPIO.setmode(GPIO.BCM)
GPIO.setup(BUTTON_PIN, GPIO.IN, pull_up_down=GPIO.PUD_UP)

def toggle_capture():
    # Get current status
    status = requests.get(f"{VOICE_URL}/status").json()
    
    if status["captureEnabled"]:
        # Stop capture
        requests.post(f"{VOICE_URL}/control/stop")
        print("🔇 Voice capture disabled")
    else:
        # Start capture
        requests.post(f"{VOICE_URL}/control/start")
        print("🎤 Voice capture enabled")

GPIO.add_event_detect(BUTTON_PIN, GPIO.FALLING, 
                       callback=lambda x: toggle_capture(), 
                       bouncetime=300)

print("Listening for button press...")
GPIO.wait_for_edge(BUTTON_PIN, GPIO.FALLING)
```

### Dashboard Widget (HTML/JS)

```html
<!DOCTYPE html>
<html>
<head>
  <title>Voice Assistant Control</title>
</head>
<body>
  <h1>OpenClaw Voice</h1>
  <div id="status"></div>
  <button onclick="toggleCapture()">Toggle Capture</button>
  <button onclick="sleep()">Sleep</button>
  <button onclick="wake()">Wake</button>
  
  <script>
    const API = 'http://localhost:18910';
    
    async function updateStatus() {
      const res = await fetch(`${API}/status`);
      const data = await res.json();
      document.getElementById('status').innerHTML = `
        State: ${data.state}<br>
        Capture: ${data.captureEnabled ? '🎤 ON' : '🔇 OFF'}<br>
        Awake: ${data.isAwake ? '👁️ YES' : '😴 NO'}
      `;
    }
    
    async function toggleCapture() {
      const status = await (await fetch(`${API}/status`)).json();
      const endpoint = status.captureEnabled ? 'stop' : 'start';
      await fetch(`${API}/control/${endpoint}`, { method: 'POST' });
      updateStatus();
    }
    
    async function sleep() {
      await fetch(`${API}/control/sleep`, { method: 'POST' });
      updateStatus();
    }
    
    async function wake() {
      await fetch(`${API}/control/wake`, { method: 'POST' });
      updateStatus();
    }
    
    // Update status every 2 seconds
    setInterval(updateStatus, 2000);
    updateStatus();
  </script>
</body>
</html>
```

## Security Considerations

### Network Exposure

The HTTP control API has **no authentication** by default. It is designed for local network use only.

**❌ DO NOT expose to the public internet without authentication**

**Recommended setup**:
- Bind to localhost only: `VOICE_HTTP_PORT=18910` (listens on 0.0.0.0 by default)
- Use firewall rules to restrict access
- Run behind reverse proxy with authentication if exposing to network
- Use VPN/tailnet for remote access

**Example firewall rules (UFW)**:
```bash
# Allow only from specific IP
sudo ufw allow from 192.168.1.100 to any port 18910

# Or allow only from local network
sudo ufw allow from 192.168.1.0/24 to any port 18910
```

### Privacy Modes

**Capture stopped** (`/control/stop`):
- Microphone completely disabled
- No audio capture whatsoever
- Maximum privacy

**Sleep** (`/control/sleep`):
- Microphone active, listening for wake word
- Audio frames processed for wake word detection
- Transcription and gateway forwarding disabled
- Medium privacy (local processing only)

**Awake** (normal operation):
- Full voice processing active
- Audio transcribed and sent to gateway
- Lowest privacy (normal operation)

## Troubleshooting

### "Connection refused"

**Cause**: HTTP server not enabled or wrong port

**Fix**: Check that `VOICE_HTTP_PORT` is set in `.env`:
```bash
grep VOICE_HTTP_PORT .env
```

If missing, add it and restart the service.

### "404 Not Found"

**Cause**: Incorrect endpoint URL

**Fix**: Check endpoint spelling and method (GET vs POST):
- Health: `GET /health`
- Status: `GET /status`  
- Control: `POST /control/{start|stop|sleep|wake}`

### Status shows `"whisperHealthy": false`

**Cause**: Whisper STT service not reachable

**Fix**: Check Whisper container/service is running:
```bash
docker ps | grep whisper
curl http://localhost:9000/health
```

### Status shows `"ttsHealthy": false`

**Cause**: Piper TTS service not reachable

**Fix**: Check Piper container/service is running:
```bash
docker ps | grep piper
curl http://localhost:5000/voices
```

## Configuration Reference

### Environment Variables

Related to HTTP control server:

```bash
# HTTP Control API
VOICE_HTTP_PORT=18910              # Port for HTTP control server (unset = disabled)

# Wake Word Configuration
WAKE_WORD=["hey assistant", "hello"]  # Array or single string
WAKE_WORD_TIMEOUT=10000                # ms before sleep (0 = disabled)
SLEEP_PHRASE="go to sleep"             # Phrase to trigger sleep

# Service URLs
GATEWAY_URL=http://localhost:18789      # OpenClaw gateway URL
WHISPER_URL=http://localhost:9000       # Whisper STT service
PIPER_URL=http://localhost:5000         # Piper TTS service
```

## Use Cases Summary

| Scenario | Endpoint | When to Use |
|----------|----------|-------------|
| Check if service is ready | GET /status | Monitoring, dashboards |
| Privacy mode (mute mic) | POST /control/stop | Meetings, calls, privacy |
| Resume listening | POST /control/start | After privacy mode |
| Schedule quiet hours | POST /control/sleep | Nighttime, work hours |
| Schedule active hours | POST /control/wake | Morning, availability |
| Manual sleep command | POST /control/sleep | "Go to sleep" alternative |
| Manual wake command | POST /control/wake | "Wake up" alternative |
| Health monitoring | GET /health | Load balancers, uptime |

## Best Practices

1. **Use `/control/stop` for privacy**: Complete microphone disable
2. **Use `/control/sleep` for quiet periods**: Still responds to wake word
3. **Monitor `/status` for health**: Check model availability before use
4. **Secure the endpoint**: No public internet exposure without auth
5. **Use with automation**: Integrate with home automation, schedulers
6. **Test locally first**: Verify endpoints work before automation
7. **Log control actions**: Track who/what sends control commands

## Related Documentation

- [Main README](README.md) - Service overview and setup
- [CROSSPLATFORM_PLAN.md](CROSSPLATFORM_PLAN.md) - Windows WASAPI support
- [.env.example](.env.example) - Full configuration reference

## Agent Instructions

When a user asks about controlling the voice service:

1. **Check if HTTP server is enabled**: Look for `VOICE_HTTP_PORT` in environment
2. **Explain the difference** between `stop` (privacy), `sleep` (wake word), and normal operation
3. **Provide working curl commands**: Copy-paste ready examples
4. **Consider security**: Warn about network exposure if user mentions remote access
5. **Suggest integration**: Recommend home automation, cron, or scripts based on use case
6. **Verify service is responding**: Test `/health` endpoint before complex operations
7. **Check status first**: Use `/status` to understand current state before control actions

Example interaction:
```
User: "How can I turn off the voice assistant during work hours?"

Agent response:
1. Check current status: `curl http://localhost:18910/status`
2. If you want complete silence: `curl -X POST http://localhost:18910/control/stop`
3. If you want it to still wake on command: `curl -X POST http://localhost:18910/control/sleep`
4. For scheduled work hours (9 AM - 5 PM weekdays):
   - Add to crontab: `0 9 * * 1-5 curl -X POST http://localhost:18910/control/sleep`
   - Add to crontab: `0 17 * * 1-5 curl -X POST http://localhost:18910/control/wake`
```

When troubleshooting:
1. Verify `VOICE_HTTP_PORT` is set
2. Check service logs for "HTTP server listening"
3. Test `/health` endpoint first
4. Check `/status` for model health
5. Verify network accessibility (firewall, Docker network)

Remember: The HTTP API is **optional** - the core voice functionality works without it.
