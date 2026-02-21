import * as dotenv from 'dotenv';
import { VoiceOrchestrator } from './orchestrator';
import { Logger } from './utils/logger';

// Load environment variables
dotenv.config();

const logger = new Logger('Main', process.env.LOG_LEVEL as any || 'info');

async function main() {
  try {
    logger.info('OpenClaw Voice Service starting...');
    
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
    const orchestrator = new VoiceOrchestrator({
      sessionKey,
      gatewayUrl: process.env.GATEWAY_URL!,
      gatewayToken: process.env.GATEWAY_AUTH_TOKEN || process.env.GATEWAY_HOOK_TOKEN!,
      agentId: process.env.GATEWAY_AGENT_ID!,
      whisperUrl: process.env.WHISPER_URL,
      whisperLanguage: process.env.WHISPER_LANGUAGE,
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
      wakeWord: process.env.WAKE_WORD,
      wakeWordTimeout: process.env.WAKE_WORD_TIMEOUT
        ? parseInt(process.env.WAKE_WORD_TIMEOUT, 10)
        : undefined,
      sleepPhrase: process.env.SLEEP_PHRASE || 'go to sleep',
      maxListenMs: process.env.MAX_LISTEN_MS
        ? parseInt(process.env.MAX_LISTEN_MS, 10)
        : undefined,
      preRollMs: process.env.PRE_ROLL_MS
        ? parseInt(process.env.PRE_ROLL_MS, 10)
        : undefined,
    }, logger);
    
    // Handle graceful shutdown
    process.on('SIGINT', () => {
      logger.info('SIGINT received, shutting down...');
      orchestrator.stop();
    });
    
    process.on('SIGTERM', () => {
      logger.info('SIGTERM received, shutting down...');
      orchestrator.stop();
    });
    
    // Start the orchestrator
    await orchestrator.start();
    
    logger.info('Voice service exiting');
    process.exit(0);
    
  } catch (error) {
    logger.error('Fatal error:', error);
    process.exit(1);
  }
}

main();
