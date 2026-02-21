# OpenClaw Voice - Cross-Platform Port Plan

**Date**: February 21, 2026  
**Target Platforms**: Windows, macOS (Linux already complete)  
**Approach**: FFmpeg for audio I/O with native application packaging  
**Timeline**: 6-8 weeks  

---

## Executive Summary

This document outlines the strategy to port openclaw-voice from Linux-only (PulseAudio/ALSA) to native Windows and macOS applications while maintaining the existing architecture and core logic.

**Key Decision**: Use native WASAPI (Windows Audio Session API) for Windows to minimize latency, with careful attention to low-latency audio patterns. Ship as native executables via `pkg` bundler.

**Why Native WASAPI**: 10-50ms latency vs 100-200ms with FFmpeg. The additional 100ms latency from FFmpeg is unacceptable for real-time voice interaction. Native WASAPI requires C++ bindings but provides imperceptible latency overhead.

---

## Architecture Overview

### Current Linux Stack
```
PulseAudio (parecord) → AudioCapture → AudioBuffer → VAD → STT
                                                           ↓
TTSClient → Piper → aplay (ALSA playback)
```

### Proposed Unified Stack
```
WASAPI (Windows, native) / PulseAudio (Linux) → AudioCapture (abstracted) → AudioBuffer → VAD → STT
                                                                                               ↓
TTSClient → Piper → WASAPI (Windows, native) / ALSA (Linux) playback
```

### Platform Isolation
- **Audio interface layer**: WASAPI (Windows) with native C++ bindings, PulseAudio/ALSA (Linux)
- **Core business logic**: Zero changes needed (orchestrator, VAD, gateway client)
- **Build system**: Platform-specific compilation, single distributable per platform

---

## Phase 1: Audio Interface Abstraction (Weeks 1-2)

### Goal
Create platform-agnostic audio interfaces. Implement native WASAPI for Windows (low latency), keep existing PulseAudio/ALSA for Linux.

### Implementation

**1. Create `src/audio/interface.ts` - Abstract Interface**
```typescript
export interface AudioCaptureInterface {
  startCapture(): AsyncGenerator<Buffer>;
  stop(): void;
  kill(): void;
  getSampleRate(): number;
  isRunning(): boolean;
}

export interface AudioPlaybackInterface {
  playAudio(buffer: Buffer): Promise<void>;
  stopPlayback(): void;
  isPlaying(): boolean;
  healthCheck(): Promise<boolean>;
}
```

**2. Windows: Native WASAPI Implementation**

**src/audio/capture-wasapi.ts** (new, Windows only)
```typescript
// Node.js native module binding to Windows WASAPI
// Uses node-gyp for C++ compilation
import { WASAPICapture } from 'wasapi-bindings'; // C++ module

export class WindowsAudioCapture implements AudioCaptureInterface {
  private capture: WASAPICapture;
  private sampleRate: number = 16000;
  private isCapturing: boolean = false;

  constructor(config: AudioCaptureConfig) {
    this.sampleRate = config.sampleRate || 16000;
    // Initialize WASAPI with low-latency settings
    this.capture = new WASAPICapture({
      sampleRate: this.sampleRate,
      channels: 1,
      bufferSize: 1024,  // ~64ms at 16kHz
      loopback: false,   // Capture from microphone, not system audio
      exclusiveMode: false, // Shared mode for broader compatibility
    });
  }

  async *capture(): AsyncGenerator<Buffer> {
    this.isCapturing = true;
    try {
      while (this.isCapturing) {
        const buffer = await this.capture.getFrame(100); // 100ms timeout
        if (buffer && buffer.length > 0) {
          yield buffer;
        }
      }
    } finally {
      this.capture.stop();
    }
  }

  stop(): void {
    this.isCapturing = false;
  }

  kill(): void {
    this.isCapturing = false;
    this.capture.kill();
  }

  getSampleRate(): number {
    return this.sampleRate;
  }

  isRunning(): boolean {
    return this.isCapturing;
  }
}
```

**src/audio/capture-linux.ts** (renamed from capture.ts)
- Keep existing PulseAudio implementation unchanged
- Maintain 100% current behavior
- Used only on Linux platform

**src/audio/capture.ts** (factory/selector)
```typescript
export function createAudioCapture(
  config: AudioConfig
): AudioCaptureInterface {
  const platform = process.platform;
  
  if (platform === 'win32') {
    return new WindowsAudioCapture(config);
  } else if (platform === 'linux') {
    return new LinuxAudioCapture(config);
  } else {
    throw new Error(`Unsupported platform: ${platform}`);
  }
}
```

**3. Windows: Native WASAPI Playback**

**src/tts/client-wasapi.ts** (new, Windows only)
```typescript
import { WASAPIPlayback } from 'wasapi-bindings';

export class WindowsTTSClient {
  private playback: WASAPIPlayback;
  private isPlaying = false;

  constructor() {
    this.playback = new WASAPIPlayback({
      sampleRate: 16000,
      channels: 1,
      bufferSize: 1024,
      exclusiveMode: false,
    });
  }

  async playAudio(buffer: Buffer): Promise<void> {
    this.isPlaying = true;
    try {
      await this.playback.play(buffer);
    } finally {
      this.isPlaying = false;
    }
  }

  stopPlayback(): void {
    this.playback.stop();
    this.isPlaying = false;
  }

  isPlayingAudio(): boolean {
    return this.isPlaying;
  }

  async healthCheck(): Promise<boolean> {
    try {
      return await this.playback.listDevices().then(d => d.length > 0);
    } catch {
      return false;
    }
  }
}
```

**src/tts/client.ts** (refactor for platform detection)
```typescript
import { TTSClient as LinuxTTSClient } from './client-linux';
import { WindowsTTSClient } from './client-wasapi';

export function createTTSClient(baseUrl: string): any {
  const platform = process.platform;
  
  if (platform === 'win32') {
    return new WindowsTTSClient();  // Uses system output, ignores Piper URL
  } else if (platform === 'linux') {
    return new LinuxTTSClient(baseUrl);  // Uses Piper HTTP
  } else {
    throw new Error(`Unsupported platform: ${platform}`);
  }
}
```

**4. Linux: Keep Existing Implementation**

- `src/tts/client-linux.ts` - Rename from client.ts, keep unchanged
- Maintains PulseAudio (parecord) and ALSA (aplay) integration
- No latency regression on Linux

### C++ Native Module: wasapi-bindings

Create `src/native/wasapi/` directory with C++ source:

**src/native/wasapi/wasapi.cc** (C++ implementation)
```cpp
#include <node.h>
#include <windows.h>
#include <wrl/client.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audiopolicy.h>

using Microsoft::WRL::ComPtr;

class WASAPICapture : public node::napi_helper::Addon<WASAPICapture> {
public:
  explicit WASAPICapture(const napi::CallbackInfo& info);
  
  napi::Promise GetFrame(const napi::CallbackInfo& info);
  void Stop(const napi::CallbackInfo& info);
  void Kill(const napi::CallbackInfo& info);

private:
  ComPtr<IAudioClient> audio_client_;
  ComPtr<IAudioCaptureClient> capture_client_;
  HANDLE h_event_;
  bool is_capturing_;
  
  void InitWASAPI(int sample_rate, int channels);
  HRESULT FillBuffer();
};
```

**binding.gyp** (Build configuration)
```json
{
  "targets": [
    {
      "target_name": "wasapi",
      "sources": [
        "src/native/wasapi/wasapi.cc"
      ],
      "include_dirs": [
        "<!(node -p \"require('node-addon-api').include_dir\")"
      ],
      "libraries": [
        "MMDevApi.lib",
        "AudioSes.lib"
      ],
      "msvs_settings": {
        "VCCLCompilerTool": {
          "AdditionalOptions": ["/EHsc"]
        }
      },
      "conditions": [
        ["OS != 'win32'", {
          "sources!": ["src/native/wasapi/wasapi.cc"]
        }]
      ]
    }
  ]
}
```

**Installation** (package.json)
```json
{
  "dependencies": {
    "node-addon-api": "^7.0.0"
  },
  "scripts": {
    "install": "node-gyp rebuild"
  },
  "binary": {
    "module_name": "wasapi",
    "module_path": "./build/Release/",
    "host": "https://github.com/openclaw/openclaw-voice/releases"
  }
}
```

### Files to Create/Modify

| File | Action | Lines | Platform |
|------|--------|-------|----------|
| src/audio/interface.ts | Create | 30 | All |
| src/audio/capture-wasapi.ts | Create | 80 | Windows |
| src/audio/capture-linux.ts | Create | 90 | Linux |
| src/audio/capture.ts | Modify | 40 | All |
| src/audio/index.ts | Modify | 10 | All |
| src/tts/client-wasapi.ts | Create | 70 | Windows |
| src/tts/client-linux.ts | Create | 120 | Linux |
| src/tts/client.ts | Modify | 30 | All |
| src/native/wasapi/wasapi.cc | Create | 400 | Windows |
| src/native/wasapi/wasapi.h | Create | 50 | Windows |
| binding.gyp | Create | 40 | Build |
| package.json | Modify | 20 | Build |

**Total Phase 1**: ~980 LOC, 14-18 hours development

### Building Phase 1

**Windows Build Requirements**:
- Visual Studio 2019+ (C++ compiler)
- Python 3.x (for node-gyp)
- Node.js 16+

**Linux Build** (unchanged):
- Existing PulseAudio dev headers
- ALSA dev headers
- No new compilation

**Build Commands**:
```bash
# Windows
npm install          # Triggers node-gyp rebuild for wasapi module
npm run build

# Linux
npm install          # No native compilation on Linux
npm run build
```

---

## Phase 2: WASAPI Integration & Testing (Weeks 2-3)

### Goal
Verify WASAPI implementation achieves <50ms latency while maintaining Linux compatibility.

### Detailed WASAPI Implementation Notes

**WASAPI Architecture**:
- **Exclusive Mode**: Direct access to audio hardware, lowest latency (5-10ms)
  - Potential issue: Only one app can use exclusive mode
  - Recommended: Shared mode for broader compatibility (15-30ms)
  
- **Event-Driven**: Use `IAudioClient::SetEventHandle()` for frame-ready notifications
  - Avoids polling overhead
  - Precise buffer timing

- **Circular Buffer Management**:
```cpp
// WASAPI provides frame count, copy into Ring Buffer for async processing
while (capture_client_->GetNextPacketSize(&packet_size) == S_OK && packet_size > 0) {
  BYTE *data;
  DWORD flags;
  capture_client_->GetBuffer(&data, &packet_size, &flags, ...);
  
  // Copy into Node.js Buffer
  // Signal Node.js event loop that data is available
  
  capture_client_->ReleaseBuffer(packet_size);
}
```

**Node.js/C++ Integration**:
- Use `node-addon-api` (NAPI) for Node.js 16+ compatibility
- Thread-safe: WASAPI events on separate thread, NAPI calls marshalled to main thread
- Promise-based async: `GetFrame()` returns Promise<Buffer>

### Testing Strategy

**1. Unit Tests (src/audio/capture-wasapi.test.ts)**
- Mock WASAPI COM objects
- Verify buffer copying and format
- Test error handling (device disconnection)

**2. Integration Tests (tests/wasapi-audio.test.ts)**
- Actual audio capture on Windows (requires audio device)
- Verify 16-bit mono PCM format
- Verify sample rate (16kHz)
- Measure latency: <50ms from input to buffer availability

**3. Latency Benchmark (tests/latency-comparison.test.ts)**
- Compare WASAPI vs PulseAudio (on Linux)
- Expected:
  - WASAPI: 10-30ms
  - PulseAudio: 50-100ms
  - Difference: ~40-80ms gain

**4. Platform-Specific Tests**
- Windows: Test on Windows 10, 11 (x64, ARM64)
- Linux: Keep existing PulseAudio tests (unchanged)
- Exclusive vs Shared mode comparison

### Playback Testing

**WASAPI Playback** (Windows):
```cpp
// Similar pattern to capture
// But: IAudioRenderClient::GetBuffer() then Write()
// Padding calculation: GetBufferSize() - GetCurrentPadding()
```

**ALSA Playback** (Linux):
- Keep existing `aplay` approach

### Configuration Updates

Add to `.env.example`:
```bash
# Audio Backend (platform-specific)
# Windows: Use WASAPI natively (no FFmpeg)
# Linux: Use PulseAudio natively (no FFmpeg)
AUDIO_BACKEND=native

# Windows WASAPI Configuration
WASAPI_EXCLUSIVE_MODE=false          # false=shared (default), true=exclusive (lower latency, single app)
WASAPI_BUFFER_SIZE=1024              # Frames per buffer (~64ms at 16kHz)
WASAPI_DEVICE_INDEX=0                # Device selection

# Device Discovery
WASAPI_LIST_DEVICES=false             # Set to true to enumerate and exit
```

### Files to Create/Modify

| File | Action | Lines |
|------|--------|-------|
| src/audio/capture-wasapi.test.ts | Create | 120 |
| tests/wasapi-audio.test.ts | Create | 150 |
| tests/latency-comparison.test.ts | Create | 100 |
| .env.example | Modify | 15 |

**Total Phase 2**: ~385 LOC, 10-14 hours development + testing

### Latency Verification

**Expected Results**:
- WASAPI first-frame latency: 50-150ms (one-time setup)
- WASAPI frame latency: <10ms per frame
- PulseAudio frame latency: 20-50ms per frame

**Acceptable Threshold**:
- Total audio I/O: <100ms (including VAD analysis)
- Previous with FFmpeg: 100-200ms
- WASAPI improvement: 50% faster ideal

---

## Phase 3: Comparison of Audio I/O Approaches

### Why Native WASAPI (Windows) Instead of FFmpeg

The latency overhead from FFmpeg-based solution was identified as unacceptable early in planning. Here's the detailed comparison:

### Option A: Native WASAPI (Chosen for Windows)

**Implementation**:
- Direct Windows Audio Session API via C++ Node.js bindings
- No subprocess overhead
- Event-driven async architecture
- Exclusive or shared mode (shared by default for compatibility)

**Latency Profile**:
| Stage | Latency | Notes |
|-------|---------|-------|
| WASAPI init | 10-50ms | One-time at app start |
| Audio capture (per frame) | <1ms | Event-driven, no polling |
| Frame yield | <1ms | In-process |
| Audio playback (per frame) | <1ms | Direct hardware write |
| **Total additional latency** | **<10ms** | vs 100-200ms with FFmpeg |

**Reliability**:
- ✅ Direct hardware access, no intermediaries
- ✅ Used in professional audio apps (Reaper, Studio One)
- ✅ Windows native, guaranteed availability
- ⚠️ Windows-only (acceptable, Linux has PulseAudio)
- ⚠️ Requires compilation (node-gyp, C++ compiler)

**Portability**:
- ✅ Works on Windows 10+ (all versions)
- ✅ Works with any audio hardware
- ❌ Windows-only (not a goal per requirements)

**Complexity**:
- 🟡 Medium: C++ binding complexity, but proven pattern
- 🟡 Windows build chain: MSVC required
- 🟢 Deployment: Single binary with embedded wasapi module

**Cost**:
- Memory: ~2-5MB wasapi module + runtime buffers (10-20MB total)
- CPU: Minimal (<5% for continuous audio)
- Disk: +3MB exe size (negligible)
- Dev effort: 14-18 hours for Phase 1

---

### Option B: FFmpeg (Rejected - Too Much Latency)

Previously considered. Key issues:

**Latency Profile**:
| Stage | Latency |
|-------|---------|
| FFmpeg startup | 200-400ms |
| Audio capture overhead | 50-100ms |
| Audio playback startup | 50-100ms |
| **Total additional latency** | **100-200ms** |

**Analysis**: This is 10-20x worse than WASAPI and adds ~2% to total app latency. For voice conversation where users expect immediate response, this is perceptible degradation.

**Rejected because**: 
- Simple subprocess overhead (no hardware abstraction benefit)
- Cross-platform goal dropped (Windows only is acceptable)
- WASAPI provides imperceptible latency

---

### Option C: Simple Node.js Audio Library (Not Viable)

**`node-wav-recorder`** or similar:
- Still 100-200ms latency (internal buffering)
- Limited device control
- Less reliable error handling

**Rejected**: Same latency issue as FFmpeg with fewer features.

---

### Option D: Shared Code via PortAudio Bindings (Too Complex)

PortAudio would add:
- 4-6 weeks dev (vs 2-3 weeks with native WASAPI)
- Outdated Node.js bindings
- Cross-platform compilation headaches

**Rejected**: Time to market not worth the theoretical generality.

---

## Comparison Matrix (Windows Focus)

| Factor | Native WASAPI | FFmpeg | Node.js Lib |
|--------|---------------|--------|-------------|
| **Latency** | <10ms | 100-200ms | 100-200ms |
| **Reliability** | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ |
| **Complexity** | 🟡 Medium | 🟢 Low | 🟢 Low |
| **Bundle Size** | +3MB | +40MB | +2MB |
| **Dev Time** | 14-18h | 8-12h | 6-8h |
| **Approval** | ✅ Direct API | ✅ Standard | ⚠️ Less proven |

**Chosen**: Native WASAPI despite higher dev cost because latency requirement overrides time-to-market.

---

### Critical Path Change

**Previous FFmpeg Plan**:
- Phase 1 (audio abstraction) → Phase 2 (FFmpeg integration) → Phase 4 (pkg packaging)
- 6-8 weeks total, smaller latency regression

**New WASAPI Plan**:
- Phase 1 (WASAPI bindings + abstraction) → Phase 2 (testing) → Phase 4 (pkg packaging)
- 6-8 weeks total, <10ms latency improvement
- Requires Windows build environment (MSVC, Python, node-gyp)

---

## Phase 4: Native App Packaging (Weeks 4-5)

### Goal
Create standalone Windows executable with bundled wasapi bindings and embedded configuration.

### Packaging Strategy: `pkg` (Node.js Bundler)

**Why `pkg`**:
- Bundles Node.js runtime + app code + native modules into single `.exe`
- No installation required (portable or installer)
- Works with native modules (including wasapi bindings)
- Open source and actively maintained

### Windows Executable Build

**1. Create pkg Configuration** (package.json)
```json
{
  "pkg": {
    "targets": ["win32-x64"],
    "outputPath": "./dist/windows",
    "scripts": ["dist/**/*.js"],
    "assets": [".env.production"],
    "compress": "brotli",
    "patches": {
      "some-module": "path/to/patch"
    }
  },
  "scripts": {
    "pkg:windows": "pkg --target win32-x64 --output openclaw-voice.exe .",
    "build:windows": "npm run build && npm run pkg:windows"
  }
}
```

**2. Build Process**

```bash
# Step 1: Compile TypeScript to dist/
npm run build

# Step 2: Bundle with node-gyp compiletimeModule wasapi
npm run build:windows

# Output: ./openclaw-voice.exe (~100-120MB with wasapi bindings)
```

**3. Configuration Management for Portable Exe**

Update `src/index.ts` to use standard Windows config locations:

```typescript
import path from 'path';
import fs from 'fs';

function getConfigPath(): string {
  if (process.pkg) {
    // Running as packaged exe
    const appRoot = path.dirname(process.execPath);
    return path.join(appRoot, 'openclaw-voice.env');
  } else {
    // Running in development
    return '.env';
  }
}

function ensureConfigExists(): void {
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) {
    // Create default config in exe directory
    const template = fs.readFileSync('.env.example', 'utf-8');
    fs.writeFileSync(configPath, template);
    console.log(`Created config at: ${configPath}`);
    console.log('Please edit and restart.');
    process.exit(1);
  }
}

// In main()
ensureConfigExists();
const envConfig = dotenv.config({ path: getConfigPath() });
```

**4. Installer Script (Optional - Advanced)**

For Windows Store or installer distribution, create NSIS script:

```nsis
; setup.nsi
!include "MUI2.nsh"

Name "OpenClaw Voice"
OutFile "OpenClaw-Voice-Setup.exe"
InstallDir "$PROGRAMFILES\OpenClaw Voice"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Section "Install"
  SetOutPath "$INSTDIR"
  File "openclaw-voice.exe"
  File ".env.example"
  
  ; Create start menu shortcuts
  CreateDirectory "$SMPROGRAMS\OpenClaw Voice"
  CreateShortcut "$SMPROGRAMS\OpenClaw Voice\OpenClaw Voice.lnk" "$INSTDIR\openclaw-voice.exe"
  CreateShortcut "$SMPROGRAMS\OpenClaw Voice\Config.lnk" "$INSTDIR\openclaw-voice.env"
SectionEnd

Section "Uninstall"
  Delete "$INSTDIR\openclaw-voice.exe"
  RMDir "$INSTDIR"
  Delete "$SMPROGRAMS\OpenClaw Voice\@OpenClaw Voice.lnk"
  RMDir "$SMPROGRAMS\OpenClaw Voice"
SectionEnd
```

### Distribution & Installation

**Option A: Portable Executable** (Simplest)
1. User downloads `openclaw-voice.exe`
2. Place in `C:\Program Files\OpenClaw Voice\`
3. Run exe - creates `openclaw-voice.env` in same directory
4. Edit .env and restart

**Option B: NSIS Installer** (More Professional)
1. User downloads `OpenClaw-Voice-Setup.exe`
2. Installer extracts to `%PROGRAMFILES%\OpenClaw Voice\`
3. Creates Start Menu shortcuts
4. Auto-creates .env template

**Option C: Windows Package Manager (winget)** (Phase 2)
```bash
winget install openclaw.voice
# Requires manifests and official package registry
```

### Files to Create/Modify

| File | Action | Lines |
|------|--------|-------|
| package.json | Modify | 20 |
| src/index.ts | Modify | 50 |
| scripts/build-windows.sh | Create | 30 |
| setup.nsi | Create | 80 |
| tests/pkg-bundle.test.ts | Create | 80 |

**Total Phase 4**: ~260 LOC, 8-10 hours

### Verification

**tests/pkg-bundle.test.ts**:
```typescript
// Verify packaged exe can:
// 1. Run with --version
// 2. Find wasapi module
// 3. List available audio devices
// 4. Create config on first run
// 5. Connect to gateway and start service
```

---

## Phase 5: Native UI (Optional, Weeks 6-8)

For end-user configuration and device selection without editing `.env`.

### Option A: CLI Menu (Recommended for MVP)

**Approach**: Create interactive CLI tool using `inquirer.js`

```typescript
// openclaw-voice --config
// Prompts:
// 1. Select audio input device
// 2. Enter gateway URL
// 3. Enter authentication token
// 4. Select TTS voice
// 5. Start service
```

**Implementation**:
- Create `src/cli/config-wizard.ts`
- Ask questions, validate, save to config file
- 100-150 LOC
- Dev time: 2-3 hours

### Option B: Desktop GUI (Recommended for Version 2)

**Approach**: Electron overlay for config + system tray

**Components**:
- Tray icon (running/stopped)
- Config window (like Discord settings)
- Logs viewer
- Device test tool

**Dev time**: 30-40 hours
**Bundle size**: +100-150MB (Electron)

### Option C: Web Dashboard (Alternative)

**Approach**: Local HTTP server with web UI

```typescript
// http://localhost:9000/admin
// - Real-time logs
// - Device list and test
// - Settings form
// - Start/stop buttons
```

**Dev time**: 15-20 hours
**Bundle size**: +5MB
**UX**: Works from any device on network

### Recommendation for MVP

**Phase 5 = CLI interactive config only**:
1. Easy to implement (2-3 hours)
2. No extra dependencies
3. Works on all platforms
4. Covers 80% of user needs

Example flow:
```bash
$ openclaw-voice --config
? Gateway URL: http://localhost:18789
? Auth Token: ••••••••
? Select input device: [1] Microphone (USB)
? Select voice: [5] en_US-amy-medium

✅ Config saved to ~/.config/openclaw-voice/.env
$ openclaw-voice
[INFO] Starting voice service...
[INFO] Connected to gateway
[INFO] Listening for speech...
```

---

## Phase 6: Continuous Integration & Testing (Weeks 5-6, parallel)

### Build Pipeline

**GitHub Actions Workflow** (.github/workflows/build.yml):

```yaml
name: Build
on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
      - run: npm install
      - run: npm test
      - run: npm run build

  build-windows:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
      - run: npm install
      - run: npm run pkg:windows
      - uses: actions/upload-artifact@v3
        with:
          name: openclaw-voice-windows
          path: dist/windows/*.exe

  build-macos:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
      - run: npm install
      - run: npm run pkg:macos
      - run: npm run sign:macos
      - uses: actions/upload-artifact@v3
        with:
          name: openclaw-voice-macos
          path: dist/macos/*.dmg
```

### Build Matrix Testing

Test on:
- Windows 10, 11 (latest + LTS)
- macOS 11, 12, 13, 14 (latest + -1)
- Ubuntu 20.04, 22.04 (latest)

### Artifact Distribution

**Release Process**:
1. Tag version: `git tag v0.1.0`
2. GitHub Actions builds all platform binaries
3. Create GitHub Release with artifacts
4. Users download `.exe` / `.dmg`

---

## Timeline & Effort Estimates

| Phase | Tasks | Dev Hours | QA Hours | Total | Weeks |
|-------|-------|-----------|----------|-------|-------|
| 1 | WASAPI bindings + abstraction | 14-18 | 3-4 | 17-22 | 2 |
| 2 | Testing + latency verification | 10-14 | 4-6 | 14-20 | 2 |
| 3 | Approach analysis | 0 | 0 | 0 | 0 |
| 4 | App packaging (pkg + NSIS) | 8-10 | 2-3 | 10-13 | 1 |
| 5 | CLI UI config (MVP) | 2-3 | 1 | 3-4 | 0 |
| 6 | CI/CD pipelines | 4-6 | 1-2 | 5-8 | 1 |
| **Total** | | **38-51** | **11-15** | **49-66** | **6-8** |

**Critical Path**: Phase 1 (WASAPI) → Phase 2 (testing) → Phase 4 (packaging)
**Parallel**: Phase 3 (analysis, completed), Phase 6 (CI/CD in week 3+)

**Note**: Higher dev hours than FFmpeg approach, but necessary for latency requirements.

---

## Risks and Mitigation

### Risk 1: WASAPI Compilation Issues on User System

**Impact**: Build fails on Windows without MSVC or Python

**Mitigation**:
- Document build requirements clearly (Visual Studio 2019+, Python 3.x)
- Provide pre-compiled binaries via GitHub Releases
- Users can download `.exe` instead of building from source
- npm install pre-built wasapi binaries from GitHub (better-sqlite3 pattern)

**Effort**: 2 hours

### Risk 2: Audio Device Names in WASAPI Vary by Locale

**Impact**: Device enumeration fails or selects wrong device

**Mitigation**:
- Implement device discovery tool
- Test on non-English Windows (Japanese, Chinese, Arabic)
- Store device UID (GUID) instead of name for selection
- Cache selection in config

**Effort**: 4 hours

### Risk 3: Shared Mode vs Exclusive Mode Latency Trade-off

**Impact**: Latency varies significantly between modes

**Mitigation**:
- Default to shared mode (compatible with all apps)
- Provide advanced option for exclusive mode if user isolates system
- Document latency difference in README
- Benchmark both modes in tests

**Effort**: 2 hours

### Risk 4: Noise Issues or Device Not Responding

**Impact**: WASAPI thread hangs, app freezes

**Mitigation**:
- Implement timeout on `GetNextPacketSize()` call
- Watchdog thread to detect audio device disconnection
- Automatic restart on device reconnection
- Error messages for driver issues

**Effort**: 3 hours

### Risk 5: Windows 7/8 Compatibility (Not Supported)

**Impact**: Users with older Windows expect to use app

**Mitigation**:
- Clearly document Windows 10+ only requirement
- WASAPI is Windows Vista+, but we'll test 10+
- Provide alternative (Docker or manual setup) for older users

**Effort**: 1 hour (documentation only)

### Risk 6: Native Module Binary Compatibility

**Impact**: .node file compiled for Node 20 won't load in Node 18

**Mitigation**:
- Use `npm install` with pre-built binary downloads
- Ship binaries for multiple Node.js versions (16, 18, 20)
- Use GitHub Actions to build/publish binaries
- Fall back to source compilation if binary unavailable

**Effort**: 4 hours setup, then automated

---

## Testing Strategy

### Unit Tests (Existing)
- Module interfaces
- Configuration
- Parser functions
- VAD logic

### Integration Tests (New)
- FFmpeg audio capture + VAD (Linux/macOS/Windows)
- FFmpeg playback (all platforms)
- Device discovery
- Config load/save

### End-to-End Tests
- Full voice loop (listen → STT → agent → TTS → playback)
- On real hardware (manual smoke tests per build)

### Performance Tests
- Latency regression: <500ms increase acceptable
- Memory usage: <200MB peak acceptable
- CPU usage: <50% on modern hardware acceptable

### Platform-Specific Tests
- Windows: Test on Windows 10 21H2, Windows 11 22H2
- macOS: Test on macOS 12, 13, 14
- Linux: Keep existing PulseAudio tests

---

## Success Criteria

### MVP (End of Phase 4)

- ✅ Windows executable runs standalone (no FFmpeg installation required)
- ✅ macOS DMG installer creates working app
- ✅ Linux Docker image still works (backward compatible)
- ✅ FFmpeg latency <200ms (measured)
- ✅ Automated builds for all platforms
- ✅ Configuration wizard works

### Phase 2 (Future)

- Web dashboard for configuration
- Homebrew formula for macOS
- Windows Store distribution
- Application analytics/monitoring

---

## Documentation Requirements

### For Developers
- Cross-platform architecture overview
- FFmpeg integration guide
- Building from source for each platform
- Adding new audio backends

### For Users
- Installation guide (Windows/macOS)
- Configuration guide
- Troubleshooting (driver issues, device selection)
- Performance tuning

### For Operators
- Docker deployment (existing)
- Native executable deployment
- Monitoring/logging
- Upgrade paths

---

## Deployment Checklist

### Windows (Primary Target)
- [ ] Build succeeds on clean Windows 10/11 machine
- [ ] MSVC compiler and Python installed (document requirements)
- [ ] wasapi bindings compile without errors
- [ ] Test on multiple Windows versions (10, 11)
- [ ] Test on both Intel and ARM64 (if applicable)
- [ ] Portable .exe runs standalone
- [ ] NSIS installer (if created) installs/uninstalls cleanly
- [ ] Verify no VC++ redistributable dependencies
- [ ] Publish to GitHub Releases
- [ ] Create Windows installation guide

### Linux (Maintain Existing)
- [ ] Existing PulseAudio implementation unchanged
- [ ] No new dependencies added to Linux build
- [ ] Test on Ubuntu 20.04, 22.04
- [ ] Docker image still works
- [ ] Backward compatible with existing config

### Cross-Platform
- [ ] Verify all CI/CD workflows on GitHub Actions
- [ ] Test upgrades from v0.0.1 → v0.1.0
- [ ] Document breaking changes (none expected)
- [ ] Create release notes

---

## Appendix: WASAPI Technical Deep Dive

### Why WASAPI Latency is Superior

**WASAPI Audio Capture Pipeline**:
```
Hardware Audio Buffer (device buffer: ~10ms)
  ↓
WASAPI IAudioCaptureClient (event-driven, <1ms notification)
  ↓
Node.js native module GetFrame() call (immediate return)
  ↓
Copy to Node.js Buffer (5-20ms depending on buffer size)
  ↓
VAD analysis (in-process, <1ms per frame)
```

**Latency Breakdown**:
- Device buffer: ~10ms
- WASAPI notification overhead: <1ms
- Buffer copy: 5-20ms
- **Total: 15-30ms** (vs 100-200ms with FFmpeg)

**Improvement**: ~85% reduction in audio I/O latency

### WASAPI Architecture

**Shared Mode** (Recommended for compatibility):
- Multiple apps can access same device
- Latency: 15-30ms
- Format negotiation: Windows handles mixing
- Reliability: Works with all audio hardware

**Exclusive Mode** (For low-latency studio use):
- Single app exclusive access
- Latency: 5-10ms (minimal)
- No format conversion (direct hardware access)
- Compatibility issue: Only one app can use exclusive mode (Discord, gaming)

**Default**: Start with shared mode, provide option for exclusive.

### WASAPI Device Enumeration

```cpp
// Enumerate available devices
IMMDeviceEnumerator *enumerator;
CoCreateInstance(CLSID_MMDeviceEnumerator, NULL, CLSCTX_ALL,
                 IID_IMMDeviceEnumerator, (void**)&enumerator);

IMMDeviceCollection *devices;
enumerator->EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE, &devices);

UINT count;
devices->GetCount(&count);

for (UINT i = 0; i < count; i++) {
  IMMDevice *device;
  devices->Item(i, &device);
  
  // Get device name and GUID for display
  IPropertyStore *props;
  device->OpenPropertyStore(STGM_READ, &props);
  // ...
}
```

### Event-Driven Model

```cpp
// Set up event notification
IAudioClient *audio_client;
device->Activate(IID_IAudioClient, CLSCTX_ALL, NULL, 
                 (void**)&audio_client);

HANDLE h_event = CreateEvent(NULL, FALSE, FALSE, NULL);
audio_client->SetEventHandle(h_event);

// Main loop: wait for frames ready
while (capturing) {
  WaitForSingleObject(h_event, 100);  // 100ms timeout
  
  IAudioCaptureClient *capture_client;
  audio_client->GetService(IID_IAudioCaptureClient, 
                          (void**)&capture_client);
  
  UINT32 packet_size;
  capture_client->GetNextPacketSize(&packet_size);
  
  if (packet_size > 0) {
    BYTE *data;
    DWORD flags;
    capture_client->GetBuffer(&data, &packet_size, &flags, NULL, NULL);
    updated plan uses native WASAPI for Windows as a pragmatic choice when latency is critical:

1. **Eliminates 100-160ms latency overhead** from FFmpeg subprocess
2. **Achieves 15-30ms audio I/O latency** competitive with professional audio apps
3. **Windows-focused implementation** (no cross-platform abstraction overhead)
4. **Maintains Linux compatibility** with existing PulseAudio approach
5. **Single distributable** via `pkg` bundler with embedded wasapi bindings

**Key differentiator from FFmpeg approach**: WASAPI provides imperceptible latency (~<30ms total audio I/O) where FFmpeg can be perceived as sluggish (~150-200ms total audio I/O) in real-time voice context.

**Trade-offs**:
- ✅ 85% latency reduction vs FFmpeg
- ✅ Native Windows reliability
- ✅ Low resource overhead (5-10MB vs 40MB FFmpeg)
- ⚠️ Platform-specific code (WASAPI is Windows-only, acceptable per requirements)
- ⚠️ Higher dev effort (18-22h vs 12-15h for FFmpeg)

**Recommended next step**: **Begin Phase 1 implementation** with WASAPI C++ bindings and Node.js native module
```cpp
// From wasapi.cc
class WASAPICapture : public Napi::ObjectWrap<WASAPICapture> {
  // ...
  
  Napi::Promise GetFrame(const Napi::CallbackInfo& info) {
    // Promise-based async
    Promise promise = Promise::New(env);
    
    // Background thread would wait on WASAPI event
    // When frame ready, resolve promise with Buffer
    
    return promise;
  }
};
```

### Comparison: FFmpeg vs WASAPI

**FFmpeg subprocess overhead**:
```
Spawn ffmpeg process: 200-400ms
↓ (first time only)
Create pipes + connect: 50ms
↓
Audio from device → ffmpeg → pipe: 50-100ms
↓
Read from pipe in Node.js: 100-200ms accumulated buffer
↓
Total: 100-200ms per frame after initial startup
```

**WASAPI native module**:
```
Initialize IAudioClient: 10-20ms (one-time)
↓
Wait for WASAPI event: <1ms per notification
↓
Copy frame to Node.js Buffer: 5-20ms
↓
Total: 5-40ms per frame
```

**Gain**: ~100-160ms latency reduction

### Device Detection Example

**Windows WASAPI Device List**:
```
[0] Microphone (Built-in)  [GUID: {device-id-123}]
[1] Headset (USB)          [GUID: {device-id-456}]
[2] Loopback (Stereo Mix)  [GUID: {device-id-789}]
```

**Default Device**: Windows default audio input (user-configured in Sound Settings)

### Error Cases

**Device Disconnection**:
```cpp
// WASAPI automatically stops yielding frames
// Node.js GetFrame() promise rejects with "Device disconnected"
// App should restart or show error UI
```

**Shared Mode Format Mismatch**:
```cpp
// Windows handles format conversion internally
// App always gets 16-bit PCM mono at requested sample rate
// No user action needed
```

**Exclusive Mode Format Mismatch**:
```cpp
// Error: Format not supported by device
// Solution: offer user alternative format or switch to shared mode
```

---

## Version Control & Branching Strategy

```
main (stable releases)
  ↓
feature/cross-platform (Phase 1-4 work)
  ├─ feature/audio-abstraction (Phase 1)
  ├─ feature/ffmpeg-integration (Phase 2)
  ├─ feature/app-packaging (Phase 4)
  └─ feature/cli-config (Phase 5)

release/v0.1.0 (release candidate branch)
  └─ cherry-picked commits from feature/cross-platform
```

---

## Conclusion

This plan uses FFmpeg as a pragmatic choice for cross-platform audio I/O:

1. **Single unified codebase** for Windows, macOS, Linux
2. **Minimal latency impact** (100-200ms of ~6s total app latency)
3. **Proven reliability** across millions of installations
4. **Fast deployment** with `pkg` bundling
5. **Scalable** to add device selection UI later

**Key differentiator from alternatives**: FFmpeg + `pkg` gets Windows/macOS apps done in 6-8 weeks vs 12-16 weeks with native API bindings, with <100ms latency tradeoff that is imperceptible in voice context.

Recommended next step: **Begin Phase 1 implementation** with audio abstraction layer refactor.
