import * as dotenv from 'dotenv';
import http from 'http';
import { VoiceOrchestrator } from './orchestrator';
import { Logger } from './utils/logger';
import { AlignmentTester, AlignmentTestSignals } from './audio/alignment-test';
import { PulseAudioTiming } from './audio/pulse-timing';

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

    const parseOptionalFloat = (value?: string): number | undefined => {
      if (!value) {
        return undefined;
      }
      const parsed = parseFloat(value);
      return Number.isFinite(parsed) ? parsed : undefined;
    };

    const parseOptionalInt = (value?: string): number | undefined => {
      if (!value) {
        return undefined;
      }
      const parsed = parseInt(value, 10);
      return Number.isFinite(parsed) ? parsed : undefined;
    };
    
    // Validate required configuration
    const requiredEnvs = [
      'GATEWAY_URL',
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
      gatewayToken: process.env.GATEWAY_AUTH_TOKEN || process.env.GATEWAY_TOKEN || '',
      agentId: process.env.GATEWAY_AGENT_ID!,
      whisperUrl: process.env.WHISPER_URL,
      whisperLanguage: process.env.WHISPER_LANGUAGE,
      whisperModel: process.env.WHISPER_MODEL,
      piperUrl: process.env.PIPER_URL,
      piperVoiceId: process.env.PIPER_VOICE_ID,
      audioCaptureDevice: process.env.AUDIO_CAPTURE_DEVICE || process.env.AUDIO_DEVICE,
      audioPlaybackDevice: process.env.AUDIO_PLAYBACK_DEVICE || process.env.AUDIO_DEVICE,
      sampleRate: process.env.AUDIO_SAMPLE_RATE ? parseInt(process.env.AUDIO_SAMPLE_RATE) : 16000,
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
      cutInTtsAbsoluteRms: process.env.CUTIN_TTS_ABSOLUTE_RMS
        ? parseFloat(process.env.CUTIN_TTS_ABSOLUTE_RMS)
        : undefined,
      cutInTtsMinSpeechMs: process.env.CUTIN_TTS_MIN_SPEECH_MS
        ? parseInt(process.env.CUTIN_TTS_MIN_SPEECH_MS, 10)
        : undefined,
      postTtsListenMs: process.env.POST_TTS_LISTEN_MS
        ? parseInt(process.env.POST_TTS_LISTEN_MS, 10)
        : undefined,
      ttsDedupeWindowMs: process.env.TTS_DEDUPE_WINDOW_MS
        ? parseInt(process.env.TTS_DEDUPE_WINDOW_MS, 10)
        : undefined,
      wakeWord,
      wakeWordTimeout: hasWakeWord && process.env.WAKE_WORD_TIMEOUT
        ? parseInt(process.env.WAKE_WORD_TIMEOUT, 10)
        : undefined,
      wakeWordEngine: (process.env.WAKE_WORD_ENGINE as 'whisper' | 'openwakeword') || 'whisper',
      openWakeWordUrl: process.env.OPENWAKEWORD_URL,
      openWakeWordConfidenceThreshold: process.env.OPENWAKEWORD_CONFIDENCE_THRESHOLD
        ? parseFloat(process.env.OPENWAKEWORD_CONFIDENCE_THRESHOLD)
        : undefined,
      openWakeWordDebug: process.env.OPENWAKEWORD_ENABLE_DEBUG === 'true',
      sleepPhrase: hasWakeWord ? (process.env.SLEEP_PHRASE || 'go to sleep') : undefined,
      maxListenMs: process.env.MAX_LISTEN_MS
        ? parseInt(process.env.MAX_LISTEN_MS, 10)
        : undefined,
      preRollMs: process.env.PRE_ROLL_MS
        ? parseInt(process.env.PRE_ROLL_MS, 10)
        : undefined,
      echoCancel: process.env.ECHO_CANCEL === 'true',
      echoCancelAttenuation: process.env.ECHO_CANCEL_ATTENUATION
        ? parseFloat(process.env.ECHO_CANCEL_ATTENUATION)
        : undefined,
      echoCancelAttenuationMin: parseOptionalFloat(process.env.ECHO_CANCEL_ATTENUATION_MIN),
      echoCancelAttenuationMax: parseOptionalFloat(process.env.ECHO_CANCEL_ATTENUATION_MAX),
      echoCancelTargetReductionMin: parseOptionalFloat(process.env.ECHO_CANCEL_TARGET_REDUCTION_MIN),
      echoCancelTargetReductionMax: parseOptionalFloat(process.env.ECHO_CANCEL_TARGET_REDUCTION_MAX),
      echoCancelAdaptiveAttenuation: process.env.ECHO_CANCEL_ADAPTIVE_ATTENUATION === 'true',
      echoCancelTailLength: process.env.ECHO_CANCEL_TAIL_LENGTH
        ? parseInt(process.env.ECHO_CANCEL_TAIL_LENGTH, 10)
        : undefined,
      echoCancelDelayMs: parseOptionalFloat(process.env.ECHO_CANCEL_DELAY_MS),
      echoCancelRecalibrateInterval: process.env.ECHO_CANCEL_RECALIBRATE_INTERVAL
        ? parseInt(process.env.ECHO_CANCEL_RECALIBRATE_INTERVAL, 10)
        : undefined,
      echoCancelMinCorrelation: process.env.ECHO_CANCEL_MIN_CORRELATION
        ? parseFloat(process.env.ECHO_CANCEL_MIN_CORRELATION)
        : undefined,
      echoCancelCalibrationCooldownMs: parseOptionalInt(
        process.env.ECHO_CANCEL_CALIBRATION_COOLDOWN_MS,
      ),
      echoCancelDriftThresholdMs: parseOptionalInt(process.env.ECHO_CANCEL_DRIFT_THRESHOLD_MS),
      echoCancelAutoCalibrate: process.env.ECHO_CANCEL_AUTO_CALIBRATE === 'true',
      echoCancelAdaptiveFiltering: process.env.ECHO_CANCEL_ADAPTIVE_FILTERING === 'true',
      echoCancelNlmsFilterLength: parseOptionalInt(process.env.ECHO_CANCEL_NLMS_FILTER_LENGTH),
      echoCancelUseWebRTCAEC: process.env.ECHO_CANCEL_USE_WEBRTC_AEC === 'true',
      echoCancelWebRTCAECStrength: (process.env.ECHO_CANCEL_WEBRTC_AEC_STRENGTH as 'weak' | 'medium' | 'strong' | undefined) || 'medium',
    }, logger);

    // HTTP control server (optional - only if VOICE_HTTP_PORT is set)
    let server: http.Server | null = null;
    
    if (process.env.VOICE_HTTP_PORT) {
      const httpPort = parseInt(process.env.VOICE_HTTP_PORT, 10);

      server = http.createServer((req, res) => {
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

        if (method === 'POST' && url === '/control/calibrate-echo') {
          orchestrator.calibrateEcho().then((result) => {
            res.writeHead(result.ok ? 200 : 500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
          }).catch((error) => {
            logger.error('Echo calibration endpoint failed:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'Calibration failed.' }));
          });
          return;
        }

        // Test endpoints for alignment verification
        if (method === 'POST' && url === '/test/alignment-chirp') {
          orchestrator.testAlignmentWithChirp().then((result) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
          }).catch((error) => {
            logger.error('Alignment chirp test failed:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: String(error) }));
          });
          return;
        }

        if (method === 'POST' && url === '/test/alignment-pulse') {
          orchestrator.testAlignmentWithPulse().then((result) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
          }).catch((error) => {
            logger.error('Alignment pulse test failed:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: String(error) }));
          });
          return;
        }

        if (method === 'GET' && url === '/test/alignment-diagnostics') {
          orchestrator.getAlignmentDiagnostics().then((result) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
          }).catch((error) => {
            logger.error('Alignment diagnostics failed:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: String(error) }));
          });
          return;
        }

        if (method === 'POST' && url === '/test/echo-cancellation-verify') {
          orchestrator.testEchoCancellationEffectiveness().then((result) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
          }).catch((error) => {
            logger.error('Echo cancellation verification failed:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: String(error) }));
          });
          return;
        }

        if (method === 'POST' && url === '/test/calibration-methods') {
          orchestrator.testAllCalibrationMethods().then((result) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
          }).catch((error) => {
            logger.error('Calibration methods test failed:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: String(error) }));
          });
          return;
        }

        if (method === 'POST' && url === '/test/calibration-impulse') {
          orchestrator.testImpulseResponseCalibration().then((result) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
          }).catch((error) => {
            logger.error('Impulse response calibration failed:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: String(error) }));
          });
          return;
        }

        if (method === 'POST' && url === '/test/calibration-blind-deconv') {
          orchestrator.testBlindDeconvolutionCalibration().then((result) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
          }).catch((error) => {
            logger.error('Blind deconvolution calibration failed:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: String(error) }));
          });
          return;
        }

        if (method === 'POST' && url === '/test/calibration-tts-specific') {
          orchestrator.testTtsSpecificCalibration().then((result) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
          }).catch((error) => {
            logger.error('TTS-specific calibration failed:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: String(error) }));
          });
          return;
        }

        if (method === 'GET' && url === '/test/pulse-timing') {
          PulseAudioTiming.getEchoCancellationTiming(
            process.env.AUDIO_PLAYBACK_DEVICE,
            process.env.AUDIO_CAPTURE_DEVICE,
          ).then((result) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result || { error: 'Could not retrieve timing' }));
          }).catch((error) => {
            logger.error('PulseAudio timing query failed:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: String(error) }));
          });
          return;
        }

        if (method === 'GET' && url === '/test/pulse-devices') {
          Promise.all([
            PulseAudioTiming.listSinks(),
            PulseAudioTiming.listSources(),
          ]).then(([sinks, sources]) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ sinks, sources }));
          }).catch((error) => {
            logger.error('PulseAudio device listing failed:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: String(error) }));
          });
          return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      });

      server.listen(httpPort, () => {
        logger.info(`Voice control HTTP server listening on port ${httpPort}`);
      });
    } else {
      logger.info('HTTP control server disabled (VOICE_HTTP_PORT not set)');
    }
    
    // Handle graceful shutdown
    process.on('SIGINT', () => {
      logger.info('SIGINT received, shutting down...');
      orchestrator.stop();
      if (server) {
        server.close();
      }
    });
    
    process.on('SIGTERM', () => {
      logger.info('SIGTERM received, shutting down...');
      orchestrator.stop();
      if (server) {
        server.close();
      }
    });
    
    const orchestratorPromise = orchestrator.start();
    await orchestratorPromise;

    logger.info('Voice service exiting');
    if (server) {
      server.close();
    }
    process.exit(0);
    
  } catch (error) {
    logger.error('Fatal error:', error);
    process.exit(1);
  }
}

main();
