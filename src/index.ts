import * as dotenv from 'dotenv';
import http from 'http';
import { VoiceOrchestrator } from './orchestrator';
import { Logger } from './utils/logger';

// Load environment variables
dotenv.config();

const logger = new Logger('Main', process.env.LOG_LEVEL as any || 'info');

async function main() {
  try {
    logger.info('OpenClaw Voice Service starting...');

    const parseWakeWords = (value?: string): string | string[] | undefined => {
      if (!value) {
        return undefined;
      }
      const trimmed = value.trim();
      if (!trimmed) {
        return undefined;
      }
      if (trimmed.startsWith('[')) {
        try {
          const parsed = JSON.parse(trimmed);
          if (Array.isArray(parsed)) {
            const normalized = parsed.map(item => String(item).trim()).filter(Boolean);
            return normalized.length ? normalized : undefined;
          }
        } catch (error) {
          logger.warn('Failed to parse WAKE_WORD as JSON array, falling back to string.');
        }
      }
      return trimmed;
    };
    
    // Validate required configuration
    const requiredEnvs = [
      'GATEWAY_URL',
      'GATEWAY_HOOK_TOKEN',
      'GATEWAY_AGENT_ID',
    ];
    
    for (const env of requiredEnvs) {
      if (!process.env[env]) {
        throw new Error(`Missing required environment variable: ${env}`);
      }
    }
    
    // Generate session key
    const sessionKey = `${process.env.GATEWAY_SESSION_PREFIX || 'voice:'}${Date.now()}`;
    logger.info(`Session key: ${sessionKey}`);
    
    // Create orchestrator
    const wakeWord = parseWakeWords(process.env.WAKE_WORD);
    const hasWakeWord = Array.isArray(wakeWord)
      ? wakeWord.length > 0
      : Boolean(wakeWord && wakeWord.trim().length > 0);

    const orchestrator = new VoiceOrchestrator({
      sessionKey,
      gatewayUrl: process.env.GATEWAY_URL!,
      gatewayToken: process.env.GATEWAY_AUTH_TOKEN || process.env.GATEWAY_HOOK_TOKEN!,
      agentId: process.env.GATEWAY_AGENT_ID!,
      whisperUrl: process.env.WHISPER_URL,
      whisperLanguage: process.env.WHISPER_LANGUAGE,
      whisperModel: process.env.WHISPER_MODEL,
      piperUrl: process.env.PIPER_URL,
      piperVoiceId: process.env.PIPER_VOICE_ID,
      audioDevice: process.env.AUDIO_DEVICE,
      sampleRate: process.env.AUDIO_SAMPLE_RATE ? parseInt(process.env.AUDIO_SAMPLE_RATE) : 16000,
      audioInputFile: process.env.AUDIO_INPUT_FILE,
      audioInputFormat: (process.env.AUDIO_INPUT_FORMAT as 'wav' | 'raw') || 'wav',
      audioInputLoop: process.env.AUDIO_INPUT_LOOP === 'true',
      vadSilenceThreshold: process.env.VAD_SILENCE_THRESHOLD
        ? parseFloat(process.env.VAD_SILENCE_THRESHOLD)
        : undefined,
      vadNoiseFloorThreshold: process.env.VAD_NOISE_FLOOR_THRESHOLD
        ? parseFloat(process.env.VAD_NOISE_FLOOR_THRESHOLD)
        : undefined,
      vadMinSpeechMs: process.env.VAD_MIN_SPEECH_MS
        ? parseInt(process.env.VAD_MIN_SPEECH_MS, 10)
        : undefined,
      vadMinSilenceMs: process.env.VAD_MIN_SILENCE_MS
        ? parseInt(process.env.VAD_MIN_SILENCE_MS, 10)
        : undefined,
      vadDebug: process.env.VAD_DEBUG === 'true',
      vadAbsoluteRms: process.env.VAD_ABSOLUTE_RMS
        ? parseFloat(process.env.VAD_ABSOLUTE_RMS)
        : undefined,
      vadAbsoluteSilenceRms: process.env.VAD_ABSOLUTE_SILENCE_RMS
        ? parseFloat(process.env.VAD_ABSOLUTE_SILENCE_RMS)
        : undefined,
      cutInAbsoluteRms: process.env.CUTIN_ABSOLUTE_RMS
        ? parseFloat(process.env.CUTIN_ABSOLUTE_RMS)
        : undefined,
      cutInMinSpeechMs: process.env.CUTIN_MIN_SPEECH_MS
        ? parseInt(process.env.CUTIN_MIN_SPEECH_MS, 10)
        : undefined,
      ttsDedupeWindowMs: process.env.TTS_DEDUPE_WINDOW_MS
        ? parseInt(process.env.TTS_DEDUPE_WINDOW_MS, 10)
        : undefined,
      wakeWord,
      wakeWordTimeout: hasWakeWord && process.env.WAKE_WORD_TIMEOUT
        ? parseInt(process.env.WAKE_WORD_TIMEOUT, 10)
        : undefined,
      sleepPhrase: hasWakeWord ? (process.env.SLEEP_PHRASE || 'go to sleep') : undefined,
      maxListenMs: process.env.MAX_LISTEN_MS
        ? parseInt(process.env.MAX_LISTEN_MS, 10)
        : undefined,
      preRollMs: process.env.PRE_ROLL_MS
        ? parseInt(process.env.PRE_ROLL_MS, 10)
        : undefined,
    }, logger);

    const httpPort = process.env.VOICE_HTTP_PORT
      ? parseInt(process.env.VOICE_HTTP_PORT, 10)
      : 18910;

    const server = http.createServer((req, res) => {
      const method = req.method || 'GET';
      const url = req.url || '/';

      if (method === 'GET' && url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (method === 'GET' && url === '/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(orchestrator.getStatus()));
        return;
      }

      if (method === 'POST' && url === '/control/start') {
        orchestrator.setCaptureEnabled(true);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, captureEnabled: true }));
        return;
      }

      if (method === 'POST' && url === '/control/stop') {
        orchestrator.setCaptureEnabled(false);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, captureEnabled: false }));
        return;
      }

      if (method === 'POST' && url === '/control/sleep') {
        orchestrator.setAwakeState(false);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, isAwake: false }));
        return;
      }

      if (method === 'POST' && url === '/control/wake') {
        orchestrator.setAwakeState(true);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, isAwake: true }));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    });

    server.listen(httpPort, () => {
      logger.info(`Voice control HTTP server listening on port ${httpPort}`);
    });
    
    // Handle graceful shutdown
    process.on('SIGINT', () => {
      logger.info('SIGINT received, shutting down...');
      orchestrator.stop();
      server.close();
    });
    
    process.on('SIGTERM', () => {
      logger.info('SIGTERM received, shutting down...');
      orchestrator.stop();
      server.close();
    });
    
    const orchestratorPromise = orchestrator.start();
    await orchestratorPromise;

    logger.info('Voice service exiting');
    server.close();
    process.exit(0);
    
  } catch (error) {
    logger.error('Fatal error:', error);
    process.exit(1);
  }
}

main();
