# Contributing to OpenClaw Voice

## Development Setup

### Prerequisites

- Node.js 20+ (use `nvm` or similar)
- pnpm (recommended) or npm
- Docker & Docker Compose (for full stack testing)

### Initial Setup

```bash
# Clone repository
git clone <your-fork>
cd openclaw-voice

# Install dependencies
npm install

# Copy environment template
cp .env.example .env

# Edit configuration for your environment
nano .env
```

### Development Workflow

```bash
# Start in watch mode
npm run dev

# Run tests in watch mode
npm test -- --watch

# Type check
npx tsc --noEmit

# Build for production
npm run build
```

## Code Style

- **Language**: TypeScript (strict mode)
- **Formatting**: Prettier (run on save)
- **Linting**: ESLint rules in progress
- **Naming**: camelCase for variables/functions, PascalCase for classes

### Type Safety

Always provide explicit types:

```typescript
// ✓ Good
async function synthesize(text: string, voiceId?: string): Promise<Buffer>

// ✗ Avoid
async function synthesize(text, voiceId)
```

## Architecture

### Key Classes

- **AudioCapture**: PulseAudio streaming (`src/audio/capture.ts`)
- **VoiceActivityDetector**: Speech detection (`src/audio/vad.ts`)
- **GatewayClient**: HTTP wrapper (`src/gateway/client.ts`)
- **ResponseParser**: TTS directive extraction (`src/gateway/parser.ts`)
- **TTSClient**: Piper API integration (`src/tts/client.ts`)
- **VoiceOrchestrator**: Main event loop (`src/orchestrator/orchestrator.ts`)

### Adding Features

1. Create feature branch: `git checkout -b feature/description`
2. Implement with tests
3. Ensure all tests pass: `npm test`
4. Submit pull request

### Code Review Checklist

- [ ] TypeScript types are explicit
- [ ] Error handling is comprehensive
- [ ] Tests cover happy path and errors
- [ ] Documentation is updated
- [ ] No hardcoded values (use .env or config)
- [ ] Logging follows Logger pattern

## Testing

### Test Structure

```
tests/
├── audio.test.ts      - Audio capture and VAD
├── gateway.test.ts    - HTTP client and parsing
├── tts.test.ts        - TTS synthesis
└── orchestrator.test.ts - Main event loop
```

### Writing Tests

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { YourClass } from '../src/module';

describe('YourClass', () => {
  let instance: YourClass;
  
  beforeEach(() => {
    instance = new YourClass();
  });
  
  it('should do something', async () => {
    const result = await instance.method();
    expect(result).toBe(expected);
  });
  
  it('should handle errors', async () => {
    await expect(instance.method()).rejects.toThrow('expected error');
  });
});
```

### Running Tests

```bash
# All tests
npm test

# Single file
npm test audio.test.ts

# Watch mode
npm test -- --watch

# Coverage report
npm test -- --coverage
```

## Documentation

### Code Comments

- Document public APIs with JSDoc
- Explain "why", not "what" (code shows what)

```typescript
/**
 * Analyze audio frame for speech activity
 * Updates adaptive noise floor and tracks speech/silence duration
 * 
 * @param frame - 16-bit mono PCM audio buffer
 * @returns true if speech is currently being detected
 */
analyze(frame: Buffer): boolean
```

### README Updates

- Keep API examples current
- Update performance targets if changing algorithms
- Document new configuration options in `.env.example`

## Performance

### Targets

- Audio latency: **< 50ms** from speech end to agent response start
- Cut-in response: **< 50ms** from user speech start to playback stop
- Memory: **< 100MB** at rest

### Profiling

```bash
# Memory profiling
node --inspect dist/index.js
# Open chrome://inspect in Chrome

# CPU profiling
NODE_OPTIONS="--prof" node dist/index.js
# Analyze: node --prof-process isolate-*.log > profile.txt
```

## Debugging

### VS Code Launch Configuration

```json
{
  "type": "node",
  "request": "launch",
  "name": "Debug",
  "program": "${workspaceFolder}/dist/index.js",
  "preLaunchTask": "npm: build",
  "env": {
    "LOG_LEVEL": "debug",
    "GATEWAY_URL": "http://localhost:18789"
  }
}
```

### Debug Output

Enable verbose logging:

```bash
LOG_LEVEL=debug npm run dev
```

### Common Issues

#### Serial audio failures
- Check PulseAudio: `pactl stat`
- Test with `parecord` directly
- Check for permission issues: `groups`

#### TTS timeout
- Check Piper status: `curl http://piper:5002/api/voices`
- Verify network: `docker network ls`
- Check compose: `docker-compose ps`

## Pull Request Process

1. Update documentation
2. Add tests (if applicable)
3. Run full test suite: `npm test`
4. Build: `npm run build`
5. Update CHANGELOG.md entry
6. Submit PR with description

## Questions?

- Check existing issues/discussions
- Review documentation in `docs/`
- Ask in PR comments or issues

Thank you for contributing!
