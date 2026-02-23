/**
 * VAD Factory - creates the appropriate Voice Activity Detector
 * Supports both RMS-based (fast) and Silero (accurate) implementations
 */
import { VoiceActivityDetector, VADConfig } from './vad';
import { SileroVoiceActivityDetector, SileroVADConfig } from './silero-vad';
import { Logger } from '../utils/logger';

export type VADInstance = VoiceActivityDetector | SileroVoiceActivityDetector;

export interface VADFactoryConfig {
  type: 'rms' | 'silero';
  rmsConfig?: Partial<VADConfig>;
  sileroConfig?: Partial<SileroVADConfig>;
}

const logger = new Logger('[VAD-FACTORY]');

/**
 * Create appropriate VAD instance based on configuration
 */
export async function createVAD(
  sampleRate: number = 16000,
  config: VADFactoryConfig = { type: 'rms' }
): Promise<VADInstance> {
  switch (config.type) {
    case 'silero': {
      logger.info('Creating Silero VAD detector');
      const sileroVad = new SileroVoiceActivityDetector(sampleRate, config.sileroConfig);
      try {
        await sileroVad.initialize();
        return sileroVad;
      } catch (error) {
        logger.error('Failed to initialize Silero VAD, falling back to RMS:', error);
        return new VoiceActivityDetector(sampleRate, config.rmsConfig);
      }
    }
    case 'rms':
    default: {
      logger.info('Creating RMS-based VAD detector');
      return new VoiceActivityDetector(sampleRate, config.rmsConfig);
    }
  }
}

/**
 * Check if passed VAD is Silero type
 */
export function isSileroVAD(vad: VADInstance): vad is SileroVoiceActivityDetector {
  return vad instanceof SileroVoiceActivityDetector;
}

/**
 * Cleanup VAD resources if needed
 */
export async function disposeVAD(vad: VADInstance): Promise<void> {
  if (isSileroVAD(vad)) {
    await vad.dispose();
  }
}
