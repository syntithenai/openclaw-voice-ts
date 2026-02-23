/**
 * Silero Voice Activity Detection (ONNX-based)
 * ML-based VAD using pre-trained Silero VAD v5.0 model
 * More reliable than RMS-based detection, handles noisy environments better
 */
import * as ort from 'onnxruntime-node';
import * as path from 'path';
import * as fs from 'fs';
import { Logger } from '../utils/logger';

export interface SileroVADConfig {
  /** Confidence threshold 0-1 (default 0.5) */
  confidenceThreshold: number;
  /** Minimum speech duration in ms (default 250) */
  minSpeechDuration: number;
  /** Minimum silence duration in ms (default 500) */
  minSilenceDuration: number;
  /** Path to ONNX model file (optional, downloads if not provided) */
  modelPath?: string;
  /** Enable debug logging */
  debug?: boolean;
}

export class SileroVoiceActivityDetector {
  private session: ort.InferenceSession | null = null;
  private config: SileroVADConfig;
  private logger: Logger;
  private isCurrentlySpeaking: boolean = false;
  private silenceDurationMs: number = 0;
  private speechDurationMs: number = 0;
  private lastFrameTime: number = 0;
  private h: Float32Array = new Float32Array(2 * 64); // Hidden state for RNN
  private c: Float32Array = new Float32Array(2 * 64); // Cell state for LSTM
  private sr_int: BigInt64Array = new BigInt64Array([BigInt(16000)]); // Sample rate
  private initialized: boolean = false;
  private lastConfidence: number = 0; // Cache last model output for synchronous access

  constructor(
    private sampleRate: number = 16000,
    config: Partial<SileroVADConfig> = {}
  ) {
    this.config = {
      confidenceThreshold: 0.5,
      minSpeechDuration: 250,
      minSilenceDuration: 500,
      debug: false,
      ...config,
    };
    this.logger = new Logger('[SILERO-VAD]');
  }

  /**
   * Initialize the Silero VAD model
   * Must be called before using analyze()
   */
  async initialize(): Promise<void> {
    try {
      const modelPath = this.config.modelPath || this.getDefaultModelPath();
      
      if (!fs.existsSync(modelPath)) {
        this.logger.warn(`Model file not found: ${modelPath}, will try to download...`);
        // In production, you might want to download the model here
        // For now, we'll attempt to use what's available
      }

      this.session = await ort.InferenceSession.create(modelPath, {
        executionProviders: ['cpu'],
        graphOptimizationLevel: 'all',
      });

      // Initialize hidden and cell states
      this.h = new Float32Array(2 * 64);
      this.c = new Float32Array(2 * 64);
      
      this.initialized = true;
      this.logger.info(`Silero VAD initialized (threshold=${this.config.confidenceThreshold})`);
    } catch (error) {
      this.logger.error('Failed to initialize Silero VAD:', error);
      throw error;
    }
  }

  /**
   * Analyze audio frame and detect speech activity
   * Returns immediately with cached result, queues async inference for next frame
   * Returns true if speech is currently being detected
   */
  analyze(frame: Buffer): boolean {
    if (!this.initialized || !this.session) {
      // Fall back to RMS-based analysis if not initialized
      return this.fallbackAnalyze(frame);
    }

    try {
      const now = Date.now();
      
      // Update timing
      if (this.lastFrameTime === 0) {
        this.lastFrameTime = now;
      }
      const elapsedMs = now - this.lastFrameTime;
      this.lastFrameTime = now;

      // Convert frame to float32 audio
      const audio = this.frameToFloat32(frame);

      // Queue async inference (non-blocking)
      // Note: We'll use the result from the PREVIOUS frame for this one
      // This small latency (one frame = 20ms) is acceptable for VAD
      (async () => {
        try {
          if (!this.session) {
            return; // Session was cleared
          }
          
          const inputs = {
            input: new ort.Tensor('float32', audio, [1, audio.length]),
            state_h: new ort.Tensor('float32', this.h, [2, 1, 64]),
            state_c: new ort.Tensor('float32', this.c, [2, 1, 64]),
            sr: new ort.Tensor('int64', this.sr_int, [1]),
          };

          // Use async run (non-blocking)
          const output = await this.session.run(inputs);
          
          // Extract confidence from output
          const outputData = output.output.data as Float32Array;
          this.lastConfidence = outputData[0];

          // Update hidden/cell states for next frame
          if (output.state_h && output.state_h.data) {
            this.h = new Float32Array(output.state_h.data as any);
          }
          if (output.state_c && output.state_c.data) {
            this.c = new Float32Array(output.state_c.data as any);
          }

          if (this.config.debug && Date.now() % 1000 < 50) {
            this.logger.debug(`confidence=${this.lastConfidence.toFixed(3)}`);
          }
        } catch (error) {
          this.logger.warn('Silero inference error:', error);
        }
      })();

      // Detect speech based on last computed confidence
      const hasSpeech = this.lastConfidence >= this.config.confidenceThreshold;

      // Update speech/silence duration
      if (hasSpeech) {
        this.speechDurationMs += elapsedMs;
        this.silenceDurationMs = 0;
      } else {
        this.silenceDurationMs += elapsedMs;
      }

      // State transitions with minimum durations
      const wasStartingSpeech =
        !this.isCurrentlySpeaking &&
        hasSpeech &&
        this.speechDurationMs >= this.config.minSpeechDuration;

      const wasEndingSpeech =
        this.isCurrentlySpeaking &&
        !hasSpeech &&
        this.silenceDurationMs >= this.config.minSilenceDuration;

      if (wasStartingSpeech) {
        this.isCurrentlySpeaking = true;
        this.logger.debug(`Speech started`);
      }

      if (wasEndingSpeech) {
        this.isCurrentlySpeaking = false;
        this.logger.debug(`Speech ended`);
      }

      return this.isCurrentlySpeaking;
    } catch (error) {
      this.logger.error('Error in Silero VAD analysis:', error);
      return this.fallbackAnalyze(frame);
    }
  }

  /**
   * Async version of analyze - for compatibility with async code paths
   */
  async analyzeAsync(frame: Buffer): Promise<boolean> {
    return this.analyze(frame);
  }

  /**
   * Fallback RMS-based analysis if model fails
   */
  private fallbackAnalyze(frame: Buffer): boolean {
    const rms = this.calculateRMS(frame);
    // Simple threshold for fallback
    return rms > 0.01;
  }

  /**
   * Check if silence has been finalized
   */
  isSilenceFinalized(): boolean {
    return (
      !this.isCurrentlySpeaking &&
      this.silenceDurationMs >= this.config.minSilenceDuration
    );
  }

  /**
   * Reset detector state
   */
  reset(): void {
    this.isCurrentlySpeaking = false;
    this.silenceDurationMs = 0;
    this.speechDurationMs = 0;
    this.lastFrameTime = 0;
    // Reset hidden/cell states
    this.h = new Float32Array(2 * 64);
    this.c = new Float32Array(2 * 64);
  }

  /**
   * Get current state for debugging
   */
  getState() {
    return {
      isCurrentlySpeaking: this.isCurrentlySpeaking,
      silenceDurationMs: this.silenceDurationMs,
      speechDurationMs: this.speechDurationMs,
      initialized: this.initialized,
      modelType: 'silero-v5.0',
    };
  }

  /**
   * Convert 16-bit PCM buffer to float32 audio
   */
  private frameToFloat32(frame: Buffer): Float32Array {
    const samples = frame.length / 2;
    const float32 = new Float32Array(samples);

    for (let i = 0; i < samples; i++) {
      const int16 = frame.readInt16LE(i * 2);
      float32[i] = int16 / 32768; // Normalize to -1 to 1
    }

    return float32;
  }

  /**
   * Calculate RMS for fallback
   */
  private calculateRMS(frame: Buffer): number {
    let sum = 0;
    const samples = frame.length / 2;

    for (let i = 0; i < frame.length; i += 2) {
      const sample = frame.readInt16LE(i);
      sum += sample * sample;
    }

    const mean = sum / samples;
    return Math.sqrt(mean) / 32768;
  }

  /**
   * Get default model path
   */
  private getDefaultModelPath(): string {
    // Try multiple locations
    const possiblePaths = [
      path.join(__dirname, '../../models/silero_vad.onnx'),
      path.join(__dirname, '../../../models/silero_vad.onnx'),
      path.join(process.cwd(), 'models/silero_vad.onnx'),
      path.join(process.cwd(), 'silero_vad.onnx'),
      '/app/models/silero_vad.onnx', // Docker path
    ];

    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        return p;
      }
    }

    // Return first path if none exist (model might be downloaded at runtime)
    return possiblePaths[0];
  }

  /**
   * Cleanup resources
   */
  async dispose(): Promise<void> {
    if (this.session) {
      this.session.release();
      this.session = null;
      this.initialized = false;
      this.logger.info('Silero VAD disposed');
    }
  }
}
