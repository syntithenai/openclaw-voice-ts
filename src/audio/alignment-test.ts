/**
 * Echo Alignment Test Harness
 * 
 * Tests various approaches to time-aligning playback with microphone capture:
 * - Cross-correlation (current method)
 * - PulseAudio timing API (streaming timestamps)
 * - Manual calibration with test tones
 * - Visual correlation display
 */

import { encodeWav } from './wav';

export interface AlignmentTestResult {
  method: string;
  delayMs: number;
  confidence: number; // 0-1, correlation strength
  metadata: Record<string, unknown>;
}

export interface AlignmentDiagnostics {
  playbackBufferSize: number;
  playbackFrameCount: number;
  playbackRmsHistory: number[];
  micRmsHistory: number[];
  correlationMap: Array<{ offsetMs: number; correlation: number }>;
  estimatedDelayMs: number;
  pulseAudioLatency?: number;
}

/**
 * Generate test signals for alignment calibration
 */
export class AlignmentTestSignals {
  /**
   * Generate a chirp sweep (frequency increases linearly)
   * Good for correlation because it's unique at every point in time
   */
  static generateChirp(
    sampleRate: number,
    durationMs: number,
    startFreqHz: number,
    endFreqHz: number,
    amplitude: number = 0.5,
  ): Buffer {
    const totalSamples = Math.floor((sampleRate * durationMs) / 1000);
    const pcm = Buffer.alloc(totalSamples * 2); // 16-bit PCM

    for (let i = 0; i < totalSamples; i++) {
      const t = i / sampleRate;
      const tNorm = i / totalSamples;
      const freq = startFreqHz + (endFreqHz - startFreqHz) * tNorm;
      const phase = 2 * Math.PI * freq * t;
      const sample = Math.sin(phase) * amplitude;
      const intSample = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
      pcm.writeInt16LE(intSample, i * 2);
    }

    return encodeWav(pcm, sampleRate);
  }

  /**
   * Generate a tone burst (short sine wave)
   * Simple and easy to spot visually in waveforms
   */
  static generateToneBurst(
    sampleRate: number,
    durationMs: number,
    frequencyHz: number,
    amplitude: number = 0.5,
  ): Buffer {
    const totalSamples = Math.floor((sampleRate * durationMs) / 1000);
    const pcm = Buffer.alloc(totalSamples * 2);

    for (let i = 0; i < totalSamples; i++) {
      const t = i / sampleRate;
      // Apply Hanning window to avoid clicks
      const window = 0.5 * (1 - Math.cos((2 * Math.PI * i) / totalSamples));
      const sample = Math.sin(2 * Math.PI * frequencyHz * t) * amplitude * window;
      const intSample = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
      pcm.writeInt16LE(intSample, i * 2);
    }

    return encodeWav(pcm, sampleRate);
  }

  /**
   * Generate white noise burst
   * Good for testing in noisy environments
   */
  static generateNoiseBurst(
    sampleRate: number,
    durationMs: number,
    amplitude: number = 0.3,
  ): Buffer {
    const totalSamples = Math.floor((sampleRate * durationMs) / 1000);
    const pcm = Buffer.alloc(totalSamples * 2);

    for (let i = 0; i < totalSamples; i++) {
      const sample = (Math.random() * 2 - 1) * amplitude;
      const intSample = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
      pcm.writeInt16LE(intSample, i * 2);
    }

    return encodeWav(pcm, sampleRate);
  }

  /**
   * Generate a sequence of pulses (like a sonar ping)
   * Easy to identify peaks for alignment
   */
  static generatePulseSequence(
    sampleRate: number,
    pulseCount: number,
    pulseDurationMs: number,
    gapMs: number,
    frequencyHz: number,
    amplitude: number = 0.5,
  ): Buffer {
    const pulseSamples = Math.floor((sampleRate * pulseDurationMs) / 1000);
    const gapSamples = Math.floor((sampleRate * gapMs) / 1000);
    const totalSamples = pulseCount * (pulseSamples + gapSamples);
    const pcm = Buffer.alloc(totalSamples * 2);

    let offset = 0;
    for (let p = 0; p < pulseCount; p++) {
      // Pulse
      for (let i = 0; i < pulseSamples; i++) {
        const t = i / sampleRate;
        const window = 0.5 * (1 - Math.cos((2 * Math.PI * i) / pulseSamples));
        const sample = Math.sin(2 * Math.PI * frequencyHz * t) * amplitude * window;
        const intSample = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
        pcm.writeInt16LE(intSample, offset * 2);
        offset++;
      }
      // Gap (silence)
      offset += gapSamples;
    }

    return encodeWav(pcm, sampleRate);
  }
}

/**
 * Alignment tester using different methods
 */
export class AlignmentTester {
  private sampleRate: number;
  private frameSize: number;

  constructor(sampleRate: number, frameSize: number) {
    this.sampleRate = sampleRate;
    this.frameSize = frameSize;
  }

  /**
   * Test alignment using cross-correlation sweep
   * This is the current method used by EchoCanceller
   */
  testCrossCorrelation(
    micBuffer: Buffer,
    playbackBuffer: Buffer,
    maxDelayMs: number,
  ): AlignmentTestResult {
    const micFrames = this.splitIntoFrames(micBuffer);
    const playbackFrames = this.splitIntoFrames(playbackBuffer);

    if (micFrames.length === 0 || playbackFrames.length === 0) {
      return {
        method: 'cross-correlation',
        delayMs: 0,
        confidence: 0,
        metadata: { error: 'Empty buffers' },
      };
    }

    const frameDurationMs = (this.frameSize / this.sampleRate) * 1000;
    const maxOffsetFrames = Math.ceil(maxDelayMs / frameDurationMs);

    let bestCorrelation = -Infinity;
    let bestOffsetFrames = 0;
    const correlationMap: Array<{ offsetMs: number; correlation: number }> = [];

    // Sweep through all possible delays
    for (
      let offsetFrames = 0;
      offsetFrames <= Math.min(maxOffsetFrames, micFrames.length - 1);
      offsetFrames++
    ) {
      let sum = 0;
      let count = 0;

      // Average correlation across multiple frame pairs
      const maxPairs = Math.min(10, playbackFrames.length, micFrames.length - offsetFrames);
      for (let i = 0; i < maxPairs; i++) {
        const micIndex = i + offsetFrames;
        if (micIndex >= micFrames.length) break;
        sum += this.correlate(micFrames[micIndex]!, playbackFrames[i]!);
        count++;
      }

      const avgCorr = count > 0 ? sum / count : 0;
      const offsetMs = offsetFrames * frameDurationMs;
      correlationMap.push({ offsetMs, correlation: avgCorr });

      if (avgCorr > bestCorrelation) {
        bestCorrelation = avgCorr;
        bestOffsetFrames = offsetFrames;
      }
    }

    const delayMs = bestOffsetFrames * frameDurationMs;

    return {
      method: 'cross-correlation',
      delayMs,
      confidence: Math.max(0, Math.min(1, bestCorrelation)),
      metadata: {
        correlationMap,
        micFrames: micFrames.length,
        playbackFrames: playbackFrames.length,
        frameDurationMs,
      },
    };
  }

  /**
   * Test alignment using RMS energy matching
   * Find where mic RMS peak aligns with playback RMS peak
   */
  testRmsAlignment(
    micBuffer: Buffer,
    playbackBuffer: Buffer,
    maxDelayMs: number,
  ): AlignmentTestResult {
    const micFrames = this.splitIntoFrames(micBuffer);
    const playbackFrames = this.splitIntoFrames(playbackBuffer);

    if (micFrames.length === 0 || playbackFrames.length === 0) {
      return {
        method: 'rms-alignment',
        delayMs: 0,
        confidence: 0,
        metadata: { error: 'Empty buffers' },
      };
    }

    const micRms = micFrames.map((f) => this.calculateRms(f));
    const playbackRms = playbackFrames.map((f) => this.calculateRms(f));

    // Find peak RMS in playback
    const playbackPeakIdx = playbackRms.indexOf(Math.max(...playbackRms));
    const playbackPeakRms = playbackRms[playbackPeakIdx]!;

    // Find corresponding peak in mic (within search window)
    const frameDurationMs = (this.frameSize / this.sampleRate) * 1000;
    const maxOffsetFrames = Math.ceil(maxDelayMs / frameDurationMs);

    let bestMatch = Infinity;
    let bestOffsetFrames = 0;

    for (let offset = 0; offset <= Math.min(maxOffsetFrames, micRms.length - 1); offset++) {
      const micIdx = playbackPeakIdx + offset;
      if (micIdx >= micRms.length) break;

      const rmsDiff = Math.abs(micRms[micIdx]! - playbackPeakRms);
      if (rmsDiff < bestMatch) {
        bestMatch = rmsDiff;
        bestOffsetFrames = offset;
      }
    }

    const delayMs = bestOffsetFrames * frameDurationMs;
    const confidence = playbackPeakRms > 0.01 ? 1 - Math.min(1, bestMatch / playbackPeakRms) : 0;

    return {
      method: 'rms-alignment',
      delayMs,
      confidence,
      metadata: {
        micRms,
        playbackRms,
        playbackPeakIdx,
        bestOffsetFrames,
      },
    };
  }

  /**
   * Generate diagnostic data for visualization
   */
  generateDiagnostics(
    micBuffer: Buffer,
    playbackBuffer: Buffer,
    maxDelayMs: number,
  ): AlignmentDiagnostics {
    const crossCorrResult = this.testCrossCorrelation(micBuffer, playbackBuffer, maxDelayMs);
    const rmsResult = this.testRmsAlignment(micBuffer, playbackBuffer, maxDelayMs);

    const micFrames = this.splitIntoFrames(micBuffer);
    const playbackFrames = this.splitIntoFrames(playbackBuffer);

    return {
      playbackBufferSize: playbackBuffer.length,
      playbackFrameCount: playbackFrames.length,
      playbackRmsHistory: playbackFrames.map((f) => this.calculateRms(f)),
      micRmsHistory: micFrames.map((f) => this.calculateRms(f)),
      correlationMap: (crossCorrResult.metadata.correlationMap as Array<{
        offsetMs: number;
        correlation: number;
      }>) || [],
      estimatedDelayMs: crossCorrResult.delayMs,
    };
  }

  // Helper methods
  private splitIntoFrames(buffer: Buffer): Buffer[] {
    const frames: Buffer[] = [];
    const bytesPerFrame = this.frameSize * 2; // 16-bit samples
    for (let i = 0; i < buffer.length; i += bytesPerFrame) {
      const end = Math.min(i + bytesPerFrame, buffer.length);
      if (end - i >= bytesPerFrame) {
        frames.push(buffer.subarray(i, end));
      }
    }
    return frames;
  }

  private correlate(frame1: Buffer, frame2: Buffer): number {
    const samples1 = new Int16Array(
      frame1.buffer,
      frame1.byteOffset,
      frame1.length / 2,
    );
    const samples2 = new Int16Array(
      frame2.buffer,
      frame2.byteOffset,
      frame2.length / 2,
    );

    const minLen = Math.min(samples1.length, samples2.length);
    let sum = 0;
    let sum1sq = 0;
    let sum2sq = 0;

    for (let i = 0; i < minLen; i++) {
      const s1 = samples1[i]! / 32768.0;
      const s2 = samples2[i]! / 32768.0;
      sum += s1 * s2;
      sum1sq += s1 * s1;
      sum2sq += s2 * s2;
    }

    const denom = Math.sqrt(sum1sq * sum2sq);
    return denom > 0 ? sum / denom : 0;
  }

  private calculateRms(frame: Buffer): number {
    const samples = new Int16Array(frame.buffer, frame.byteOffset, frame.length / 2);
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
      const normalized = samples[i]! / 32768.0;
      sum += normalized * normalized;
    }
    return Math.sqrt(sum / samples.length);
  }
}
