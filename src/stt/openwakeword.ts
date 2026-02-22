/**
 * OpenWakeWord Client
 * 
 * Provides fast, audio-based wake word detection using openWakeWord library.
 * Significantly faster than Whisper (~50ms vs 500-1500ms).
 */

import fetch from 'node-fetch';
import { Logger } from '../utils/logger';

export interface OpenWakeWordConfig {
  url: string;
  confidenceThreshold?: number;
  debug?: boolean;
}

export interface DetectionResult {
  detected: boolean;
  topMatch?: string;
  confidence: number;
  allScores?: Record<string, number>;
}

export class OpenWakeWordClient {
  private logger: Logger;
  private config: OpenWakeWordConfig;
  private lastError: Error | null = null;

  constructor(config: OpenWakeWordConfig) {
    this.config = config;
    this.logger = new Logger('OpenWakeWordClient');
  }

  /**
   * Detect wake words in audio chunk
   * @param audioBuffer 16-bit PCM audio data
   * @param wakeWords List of wake words to detect
   * @returns Detection result with confidence scores
   */
  async detectWakeWord(
    audioBuffer: Buffer,
    wakeWords: string[]
  ): Promise<DetectionResult> {
    try {
      const startTime = Date.now();

      // Encode audio to base64 for transmission
      const audioBase64 = audioBuffer.toString('base64');

      // Set up timeout using AbortController
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(`${this.config.url}/detect`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          audio_base64: audioBase64,
          wake_words: wakeWords,
          sample_rate: 16000,
        }),
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json() as any;
      const elapsedMs = Date.now() - startTime;

      // Debug logging
      if (this.config.debug) {
        this.logger.debug(
          `[OWW-DETECT] ${data.top_match} confidence=${data.top_confidence.toFixed(3)} ` +
          `(${elapsedMs}ms)`
        );
      }

      this.lastError = null;

      return {
        detected: data.detected,
        topMatch: data.top_match,
        confidence: data.top_confidence,
        allScores: data.all_scores,
      };
    } catch (error) {
      this.lastError = error as Error;
      
      if (this.config.debug) {
        this.logger.debug(`[OWW-ERROR] Detection failed: ${error}`);
      }

      // Return negative result on error (fail-safe)
      return {
        detected: false,
        confidence: 0,
      };
    }
  }

  /**
   * Health check - verify service is available
   */
  async isHealthy(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(`${this.config.url}/health`, {
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        return false;
      }

      const data = await response.json() as any;
      return data.status === 'healthy' || data.status === 'degraded';
    } catch (error) {
      this.logger.debug(`Health check failed: ${error}`);
      return false;
    }
  }

  /**
   * Get last error (for debugging)
   */
  getLastError(): Error | null {
    return this.lastError;
  }
}
