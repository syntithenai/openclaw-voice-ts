/**
 * Acoustic Echo Cancellation (AEC) Module
 * 
 * Implements echo cancellation to prevent TTS playback from triggering
 * false cut-in detection by removing known playback signal from mic input.
 * 
 * Methods supported:
 * 1. Fixed subtraction: Linear scaling of reference (simple, low CPU)  
 * 2. Adaptive NLMS: Learns filter weights to match acoustic response (better, moderate CPU)
 * 3. WebRTC AEC: Industry-standard echo cancellation (best quality, moderate CPU)
 * 
 * Flow:
 * 1. TTS playback buffer is stored with timestamp
 * 2. Mic frames are cross-correlated with playback buffer to find delay
 * 3. Time-aligned playback is processed through selected AEC engine
 * 4. Result is "echo-cancelled" audio for VAD/Whisper
 */

import { NLMSFilter, NLMSConfig } from './nlms-filter';
import { WebRTCAEC } from './webrtc-aec';

interface PlaybackFrame {
  idx: number;
  timestamp: number; // ms since epoch
  data: Buffer; // Raw PCM samples (16-bit mono)
}

export interface EchoCancellationConfig {
  enabled: boolean;
  sampleRate: number; // e.g., 48000
  frameSize: number; // samples per frame, e.g., 1024
  tailLength: number; // max echo delay in ms, e.g., 150
  attenuation: number; // 0.0-1.0, how much to subtract, e.g., 0.7
  recalibrateInterval: number; // ms between auto-recalibration, 0=disabled
  minCorrelation: number; // minimum correlation to accept alignment, e.g., 0.3
  attenuationMin?: number; // for adaptive attenuation
  attenuationMax?: number; // for adaptive attenuation
  targetReductionMin?: number; // for adaptive attenuation
  targetReductionMax?: number; // for adaptive attenuation
  adaptiveAttenuation?: boolean; // enable adaptive attenuation
  initialDelayMs?: number; // initial delay value
  driftThresholdMs?: number; // drift threshold for logging
  calibrationCooldownMs?: number; // cooldown for calibration
  adaptiveFiltering?: boolean; // enable NLMS adaptive filtering mode
  nlmsFilterLength?: number; // NLMS filter taps (default 512 for 10ms @ 48kHz)
  useWebRTCAEC?: boolean; // enable WebRTC AEC mode
  webrtcAECStrength?: 'weak' | 'medium' | 'strong'; // WebRTC AEC aggressiveness
}

export class EchoCanceller {
  private config: EchoCancellationConfig;
  private playbackBuffer: PlaybackFrame[] = [];
  private playbackSeq: number = 0;
  private estimatedDelayMs: number = 0;
  private lastCalibrationTime: number = 0;
  private maxPlaybackFrames: number;
  private nlmsFilter: NLMSFilter | null = null;
  private useAdaptiveFiltering: boolean;
  private webrtcAec: WebRTCAEC | null = null;
  private useWebRTCAEC: boolean;
  
  constructor(config: EchoCancellationConfig) {
    this.config = config;
    // Calculate how many frames to keep based on tail length
    const msPerFrame = (config.frameSize / config.sampleRate) * 1000;
    this.maxPlaybackFrames = Math.ceil((config.tailLength + 500) / msPerFrame); // +500ms margin
    
    this.useAdaptiveFiltering = config.adaptiveFiltering ?? false;
    this.useWebRTCAEC = config.useWebRTCAEC ?? false;

    // Initialize WebRTC AEC if enabled
    if (this.useWebRTCAEC) {
      try {
        this.webrtcAec = new WebRTCAEC(
          config.sampleRate,
          config.frameSize,
          config.webrtcAECStrength ?? 'medium'
        );
        process.stderr.write(`[AEC] WebRTC AEC enabled (strength=${config.webrtcAECStrength ?? 'medium'})\n`);
      } catch (error) {
        process.stderr.write(`[AEC] WebRTC AEC initialization failed: ${error}\n`);
        this.webrtcAec = null;
        this.useWebRTCAEC = false;
      }
    }
    
    // Initialize NLMS if enabled (not mutually exclusive with WebRTC)
    if (this.useAdaptiveFiltering) {
      const nlmsConfig: NLMSConfig = {
        filterLength: config.nlmsFilterLength ?? 512,
        stepSize: 0.3,
        regularization: 1e-8,
        constrained: true,
        leakage: 0.9999,
      };
      this.nlmsFilter = new NLMSFilter(nlmsConfig);
      process.stderr.write(`[AEC] NLMS adaptive filtering enabled (${nlmsConfig.filterLength} taps, step=${nlmsConfig.stepSize})\n`);
    }
    
    process.stderr.write(`[AEC] Initialized: enabled=${config.enabled}, attenuation=${config.attenuation}, tailLength=${config.tailLength}ms, maxFrames=${this.maxPlaybackFrames}\n`);
  }
  
  /**
   * Add TTS playback audio to the reference buffer
   * Call this when TTS starts playing
   * 
   * @param wavBuffer - Complete WAV file buffer from TTS synthesis
   */
  addPlaybackAudio(wavBuffer: Buffer): void {
    if (!this.config.enabled) {
      process.stderr.write('[AEC] Skipping playback audio - AEC is disabled\n');
      return;
    }
    
    process.stderr.write(`[AEC] Adding playback audio: ${wavBuffer.length} bytes, enabled=${this.config.enabled}\n`);
    
    // Parse WAV header and extract PCM data
    const pcmData = this.extractPCMFromWav(wavBuffer);
    if (!pcmData) {
      process.stderr.write('[AEC] Failed to parse WAV file\n');
      return;
    }
    
    process.stderr.write(`[AEC] Extracted ${pcmData.length} bytes of PCM data\n`);
    
    // Convert to frames matching our frame size
    const frames = this.splitIntoFrames(pcmData);
    const timestamp = Date.now();
    
    for (const frameData of frames) {
      this.playbackBuffer.push({
        idx: this.playbackSeq++,
        timestamp: timestamp + (this.playbackBuffer.length * this.getFrameDurationMs()),
        data: frameData,
      });
      
      // Also push to NLMS reference buffer if enabled
      if (this.useAdaptiveFiltering && this.nlmsFilter) {
        this.nlmsFilter.pushReferenceFrame(frameData);
      }
      
      // Also push to WebRTC AEC reference buffer if enabled
      if (this.useWebRTCAEC && this.webrtcAec) {
        this.webrtcAec.addFarendFrame(frameData);
      }
    }
    
    // Trim old frames
    while (this.playbackBuffer.length > this.maxPlaybackFrames) {
      this.playbackBuffer.shift();
    }
    
    process.stderr.write(`[AEC] Added ${frames.length} playback frames (buffer: ${this.playbackBuffer.length}/${this.maxPlaybackFrames})\n`);
  }
  
  /**
   * Process microphone frame to remove echo
   * 
   * @param micFrame - Raw PCM frame from microphone
   * @param timestamp - When this frame was captured (ms)
   * @returns Echo-cancelled frame
   */
  processFrame(micFrame: Buffer, timestamp: number): Buffer {
    if (!this.config.enabled || this.playbackBuffer.length === 0) {
      return micFrame; // Pass through if AEC disabled or no playback
    }
    
    // Check if we need to recalibrate delay
    const shouldRecalibrate = this.config.recalibrateInterval > 0 &&
      (timestamp - this.lastCalibrationTime) > this.config.recalibrateInterval;
    
    if (shouldRecalibrate || this.estimatedDelayMs === 0) {
      this.estimatedDelayMs = this.calibrateDelay(micFrame, timestamp);
      this.lastCalibrationTime = timestamp;
    }
    
    // Find playback frame at estimated delay
    const playbackTimestamp = timestamp - this.estimatedDelayMs;
    const playbackFrame = this.findPlaybackFrameAt(playbackTimestamp);
    
    if (!playbackFrame) {
      return micFrame; // No matching playback, pass through
    }
    
    // Apply echo cancellation (WebRTC AEC, NLMS, or fixed subtraction)
    let cancelled: Buffer;
    if (this.useWebRTCAEC && this.webrtcAec) {
      // Process through WebRTC AEC
      cancelled = this.webrtcAec.processFrame(micFrame);
    } else if (this.useAdaptiveFiltering && this.nlmsFilter) {
      // Process through NLMS adaptive filter
      const result = this.nlmsFilter.processBuffer(micFrame);
      cancelled = result.residuals;
    } else {
      // Fall back to fixed subtraction
      cancelled = this.subtractFrames(micFrame, playbackFrame.data, this.config.attenuation);
    }
    
    // Calculate RMS before and after to measure effectiveness
    const rmsBefore = this.calculateRms(micFrame);
    const rmsAfter = this.calculateRms(cancelled);
    const reduction = ((rmsBefore - rmsAfter) / rmsBefore * 100).toFixed(1);
    
    if (Math.random() < 0.01) { // Log 1% of frames to avoid spam
      process.stderr.write(`[AEC] Frame processed: RMS ${rmsBefore.toFixed(6)} → ${rmsAfter.toFixed(6)} (${reduction}% reduction), delay=${this.estimatedDelayMs}ms\n`);
    }
    
    return cancelled;
  }
  
  /**
   * Calculate RMS of audio frame for effectiveness measurement
   */
  private calculateRms(frame: Buffer): number {
    const samples = new Int16Array(frame.buffer, frame.byteOffset, frame.length / 2);
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
      const normalized = samples[i] / 32768.0;
      sum += normalized * normalized;
    }
    return Math.sqrt(sum / samples.length);
  }
  
  /**
   * Calibrate echo delay using cross-correlation
   * Finds the time offset that maximizes correlation between mic and playback
   * 
   * @param micFrame - Current mic frame
   * @param micTimestamp - When mic frame was captured
   * @returns Estimated delay in ms
   */
  private calibrateDelay(micFrame: Buffer, micTimestamp: number): number {
    const maxDelayMs = this.config.tailLength;
    const frameDurationMs = this.getFrameDurationMs();
    const maxOffsetFrames = Math.ceil(maxDelayMs / frameDurationMs);
    
    let bestCorrelation = -Infinity;
    let bestOffsetMs = this.estimatedDelayMs || 50; // Default to 50ms if unknown
    
    // Search for best correlation across possible delays
    for (let offsetFrames = 0; offsetFrames < Math.min(maxOffsetFrames, this.playbackBuffer.length); offsetFrames++) {
      const offsetMs = offsetFrames * frameDurationMs;
      const playbackTimestamp = micTimestamp - offsetMs;
      const playbackFrame = this.findPlaybackFrameAt(playbackTimestamp);
      
      if (playbackFrame) {
        const correlation = this.correlate(micFrame, playbackFrame.data);
        if (correlation > bestCorrelation) {
          bestCorrelation = correlation;
          bestOffsetMs = offsetMs;
        }
      }
    }
    
    // Only accept if correlation is strong enough
    if (bestCorrelation < this.config.minCorrelation) {
      process.stderr.write(`[AEC] Calibration: low correlation (${bestCorrelation.toFixed(3)}), keeping previous delay ${this.estimatedDelayMs}ms\n`);
      return this.estimatedDelayMs || 50;
    }
    
    process.stderr.write(`[AEC] Calibration: delay=${bestOffsetMs.toFixed(1)}ms, correlation=${bestCorrelation.toFixed(3)}\n`);
    return bestOffsetMs;
  }
  
  /**
   * Cross-correlate two audio frames
   * Returns normalized correlation coefficient (-1 to 1)
   */
  private correlate(frame1: Buffer, frame2: Buffer): number {
    const minLength = Math.min(frame1.length, frame2.length);
    const samples1 = new Int16Array(frame1.buffer, frame1.byteOffset, minLength / 2);
    const samples2 = new Int16Array(frame2.buffer, frame2.byteOffset, minLength / 2);
    
    let sum1 = 0, sum2 = 0, sum1Sq = 0, sum2Sq = 0, pSum = 0;
    const n = samples1.length;
    
    for (let i = 0; i < n; i++) {
      sum1 += samples1[i];
      sum2 += samples2[i];
      sum1Sq += samples1[i] * samples1[i];
      sum2Sq += samples2[i] * samples2[i];
      pSum += samples1[i] * samples2[i];
    }
    
    const num = pSum - (sum1 * sum2 / n);
    const den = Math.sqrt((sum1Sq - sum1 * sum1 / n) * (sum2Sq - sum2 * sum2 / n));
    
    if (den === 0) return 0;
    return num / den;
  }
  
  /**
   * Subtract playback frame from mic frame
   * 
   * @param micFrame - Microphone input
   * @param playbackFrame - Time-aligned playback
   * @param attenuation - How much to subtract (0-1)
   * @returns Cancelled frame
   */
  private subtractFrames(micFrame: Buffer, playbackFrame: Buffer, attenuation: number): Buffer {
    const minLength = Math.min(micFrame.length, playbackFrame.length);
    const result = Buffer.alloc(micFrame.length);
    
    const micSamples = new Int16Array(micFrame.buffer, micFrame.byteOffset, minLength / 2);
    const pbSamples = new Int16Array(playbackFrame.buffer, playbackFrame.byteOffset, minLength / 2);
    const outSamples = new Int16Array(result.buffer, result.byteOffset, minLength / 2);
    
    for (let i = 0; i < micSamples.length; i++) {
      const cancelled = micSamples[i] - (attenuation * pbSamples[i]);
      outSamples[i] = Math.max(-32768, Math.min(32767, Math.round(cancelled)));
    }
    
    // Copy any remaining bytes if mic is longer
    if (micFrame.length > minLength) {
      micFrame.copy(result, minLength, minLength);
    }
    
    return result;
  }
  
  /**
   * Find playback frame closest to given timestamp
   */
  private findPlaybackFrameAt(timestamp: number): PlaybackFrame | null {
    if (this.playbackBuffer.length === 0) return null;
    
    // Binary search for closest timestamp
    let closest = this.playbackBuffer[0];
    let minDiff = Math.abs(closest.timestamp - timestamp);
    
    for (const frame of this.playbackBuffer) {
      const diff = Math.abs(frame.timestamp - timestamp);
      if (diff < minDiff) {
        minDiff = diff;
        closest = frame;
      }
    }
    
    // Only return if within reasonable range (2x frame duration)
    if (minDiff < this.getFrameDurationMs() * 2) {
      return closest;
    }
    
    return null;
  }
  
  /**
   * Extract raw PCM data from WAV file
   * Returns 16-bit mono PCM at configured sample rate, or null if invalid
   */
  private extractPCMFromWav(wavBuffer: Buffer): Buffer | null {
    try {
      // Simple WAV parser - assumes standard PCM format
      // WAV header: RIFF (4) + size (4) + WAVE (4) = 12 bytes
      if (wavBuffer.length < 44) return null;
      if (wavBuffer.toString('ascii', 0, 4) !== 'RIFF') return null;
      if (wavBuffer.toString('ascii', 8, 12) !== 'WAVE') return null;
      
      // Find 'data' chunk
      let offset = 12;
      while (offset < wavBuffer.length - 8) {
        const chunkId = wavBuffer.toString('ascii', offset, offset + 4);
        const chunkSize = wavBuffer.readUInt32LE(offset + 4);
        
        if (chunkId === 'data') {
          // Found PCM data
          const pcmStart = offset + 8;
          const pcmEnd = Math.min(pcmStart + chunkSize, wavBuffer.length);
          return wavBuffer.subarray(pcmStart, pcmEnd);
        }
        
        offset += 8 + chunkSize;
      }
      
      return null;
    } catch (error) {
      console.error('[AEC] WAV parsing error:', error);
      return null;
    }
  }
  
  /**
   * Split PCM buffer into fixed-size frames
   */
  private splitIntoFrames(pcmData: Buffer): Buffer[] {
    const frames: Buffer[] = [];
    const bytesPerFrame = this.config.frameSize * 2; // 16-bit = 2 bytes per sample
    
    for (let offset = 0; offset < pcmData.length; offset += bytesPerFrame) {
      const end = Math.min(offset + bytesPerFrame, pcmData.length);
      const frameData = pcmData.subarray(offset, end);
      
      // Pad last frame if needed
      if (frameData.length < bytesPerFrame) {
        const padded = Buffer.alloc(bytesPerFrame);
        frameData.copy(padded);
        frames.push(padded);
      } else {
        frames.push(frameData);
      }
    }
    
    return frames;
  }
  
  /**
   * Get duration of one frame in milliseconds
   */
  private getFrameDurationMs(): number {
    return (this.config.frameSize / this.config.sampleRate) * 1000;
  }
  
  /**
   * Clear playback buffer (e.g., when TTS stops)
   */
  clearPlayback(): void {
    this.playbackBuffer = [];
    process.stderr.write('[AEC] Cleared playback buffer\n');
  }
  
  /**
   * Get current AEC statistics
   */
  getStats(): {
    enabled: boolean;
    playbackFrames: number;
    estimatedDelayMs: number;
    lastCalibrationMs: number;
  } {
    return {
      enabled: this.config.enabled,
      playbackFrames: this.playbackBuffer.length,
      estimatedDelayMs: this.estimatedDelayMs,
      lastCalibrationMs: this.lastCalibrationTime,
    };
  }
  /**
   * Calibrate using playback capture (for testing)
   */
  calibrateFromPlaybackCapture(micBuffer: Buffer, playbackWav: Buffer): { delayMs: number; correlation: number } | null {
    // Use the existing delay estimation
    return {
      delayMs: this.estimatedDelayMs,
      correlation: 0.5, // Placeholder
    };
  }
  /**
   * Test echo cancellation offline using buffered audio
   * Used for verification and calibration testing
   */
  cancelBuffer(
    micBuffer: Buffer,
    playbackWav: Buffer,
  ): {
    rmsBefore: number;
    rmsAfter: number;
    reductionRatio: number;
    optimalAttenuation: number;
    rmsAfterOptimal: number;
    reductionRatioOptimal: number;
  } | null {
    if (!micBuffer || micBuffer.length === 0) {
      return null;
    }

    const playbackPcm = this.extractPCMFromWav(playbackWav);
    if (!playbackPcm) {
      return null;
    }

    const micSamples = new Int16Array(micBuffer.buffer, micBuffer.byteOffset, micBuffer.length / 2);
    const pbSamples = new Int16Array(playbackPcm.buffer, playbackPcm.byteOffset, playbackPcm.length / 2);

    process.stderr.write(`[CANCEL-DEBUG] micSamples=${micSamples.length}, pbSamples=${pbSamples.length}, delayMs=${this.estimatedDelayMs}, atten=${this.config.attenuation}\n`);

    // Find optimal alignment and attenuation using the estimated delay
    const delaySamples = Math.max(0, Math.round((this.estimatedDelayMs / 1000) * this.config.sampleRate));
    const attenuation = this.config.attenuation;

    let sumBefore = 0;
    let sumAfter = 0;
    let dot = 0;
    let pbEnergy = 0;

    // Single pass to calculate fixed attenuation reduction
    for (let i = 0; i < micSamples.length; i++) {
      const mic = micSamples[i] / 32768;
      sumBefore += mic * mic;

      const pbIndex = i - delaySamples;
      const pb = pbIndex >= 0 && pbIndex < pbSamples.length ? pbSamples[pbIndex] / 32768 : 0;

      dot += mic * pb;
      pbEnergy += pb * pb;

      const cancelled = mic - (attenuation * pb);
      sumAfter += cancelled * cancelled;
    }

    const rmsBefore = Math.sqrt(sumBefore / micSamples.length);
    const rmsAfter = Math.sqrt(sumAfter / micSamples.length);
    const reductionRatio = rmsBefore > 0 ? (rmsBefore - rmsAfter) / rmsBefore : 0;

    process.stderr.write(`[CANCEL-DEBUG] sumBefore=${sumBefore.toFixed(6)}, sumAfter=${sumAfter.toFixed(6)}, rmsBefore=${rmsBefore.toFixed(6)}, rmsAfter=${rmsAfter.toFixed(6)}, ratio=${reductionRatio.toFixed(4)}\n`);

    // Calculate optimal attenuation via least squares
    const optimalAttenuation = pbEnergy > 1e-9 ? Math.min(1.2, Math.max(0, dot / pbEnergy)) : 0;

    let sumAfterOptimal = 0;
    for (let i = 0; i < micSamples.length; i++) {
      const mic = micSamples[i] / 32768;
      const pbIndex = i - delaySamples;
      const pb = pbIndex >= 0 && pbIndex < pbSamples.length ? pbSamples[pbIndex] / 32768 : 0;
      const cancelled = mic - (optimalAttenuation * pb);
      sumAfterOptimal += cancelled * cancelled;
    }

    const rmsAfterOptimal = Math.sqrt(sumAfterOptimal / micSamples.length);
    const reductionRatioOptimal = rmsBefore > 0 ? (rmsBefore - rmsAfterOptimal) / rmsBefore : 0;

    return {
      rmsBefore,
      rmsAfter,
      reductionRatio,
      optimalAttenuation,
      rmsAfterOptimal,
      reductionRatioOptimal,
    };
  }

  /**
   * Apply echo cancellation offline and return the cancelled audio buffer
   * Uses cross-correlation to find optimal delay, then calculates optimal attenuation
   */
  cancelBufferWithOutput(
    micBuffer: Buffer,
    playbackWav: Buffer,
  ): {
    cancelled: Buffer;
    rmsBefore: number;
    rmsAfter: number;
    reductionRatio: number;
    optimalAttenuation: number;
    delaySamples: number;
  } | null {
    if (!micBuffer || micBuffer.length === 0) {
      return null;
    }

    const playbackPcm = this.extractPCMFromWav(playbackWav);
    if (!playbackPcm) {
      process.stderr.write(`[CANCEL-OFFLINE] Failed to extract PCM from playback WAV\n`);
      return null;
    }

    const micSamples = new Int16Array(micBuffer.buffer, micBuffer.byteOffset, micBuffer.length / 2);
    const pbSamples = new Int16Array(playbackPcm.buffer, playbackPcm.byteOffset, playbackPcm.length / 2);

    process.stderr.write(`[CANCEL-OFFLINE] micSamples=${micSamples.length}, pbSamples=${pbSamples.length}\n`);

    // Search for optimal delay using cross-correlation
    const minDelay = 0;
    const maxDelay = Math.min(Math.round(this.config.sampleRate * 0.5), micSamples.length - 1000); // Search up to 500ms
    let bestDelay = Math.round((this.estimatedDelayMs / 1000) * this.config.sampleRate);
    let bestCorrelation = -Infinity;

    // Coarse search every 100 samples
    for (let delay = minDelay; delay <= maxDelay; delay += 100) {
      let correlation = 0;
      let micEnergy = 0;
      let pbEnergy = 0;
      
      const searchLength = Math.min(10000, micSamples.length - delay, pbSamples.length);
      
      for (let i = 0; i < searchLength; i++) {
        const mic = micSamples[i + delay] / 32768;
        const pb = i < pbSamples.length ? pbSamples[i] / 32768 : 0;
        
        correlation += mic * pb;
        micEnergy += mic * mic;
        pbEnergy += pb * pb;
      }
      
      // Normalize correlation
      const normalizedCorr = (micEnergy > 0 && pbEnergy > 0) 
        ? correlation / Math.sqrt(micEnergy * pbEnergy) 
        : 0;
      
      if (normalizedCorr > bestCorrelation) {
        bestCorrelation = normalizedCorr;
        bestDelay = delay;
      }
    }

    // Fine search around best delay
    const fineMin = Math.max(0, bestDelay - 100);
    const fineMax = Math.min(maxDelay, bestDelay + 100);
    
    for (let delay = fineMin; delay <= fineMax; delay += 10) {
      let correlation = 0;
      let micEnergy = 0;
      let pbEnergy = 0;
      
      const searchLength = Math.min(10000, micSamples.length - delay, pbSamples.length);
      
      for (let i = 0; i < searchLength; i++) {
        const mic = micSamples[i + delay] / 32768;
        const pb = i < pbSamples.length ? pbSamples[i] / 32768 : 0;
        
        correlation += mic * pb;
        micEnergy += mic * mic;
        pbEnergy += pb * pb;
      }
      
      const normalizedCorr = (micEnergy > 0 && pbEnergy > 0) 
        ? correlation / Math.sqrt(micEnergy * pbEnergy) 
        : 0;
      
      if (normalizedCorr > bestCorrelation) {
        bestCorrelation = normalizedCorr;
        bestDelay = delay;
      }
    }

    const delaySamples = bestDelay;
    const delayMs = (delaySamples / this.config.sampleRate) * 1000;

    process.stderr.write(`[CANCEL-OFFLINE] Best delay found: ${delaySamples} samples (${delayMs.toFixed(1)}ms), correlation=${bestCorrelation.toFixed(4)}\n`);

    // Calculate optimal attenuation via least squares using best delay
    let dot = 0;
    let pbEnergy = 0;
    let sumBefore = 0;

    for (let i = 0; i < micSamples.length; i++) {
      const mic = micSamples[i] / 32768;
      sumBefore += mic * mic;

      const pbIndex = i - delaySamples;
      const pb = pbIndex >= 0 && pbIndex < pbSamples.length ? pbSamples[pbIndex] / 32768 : 0;

      dot += mic * pb;
      pbEnergy += pb * pb;
    }

    const optimalAttenuation = pbEnergy > 1e-9 ? Math.min(1.2, Math.max(0, dot / pbEnergy)) : this.config.attenuation;

    process.stderr.write(`[CANCEL-OFFLINE] optimalAttenuation=${optimalAttenuation.toFixed(4)}, configAttenuation=${this.config.attenuation}, pbEnergy=${pbEnergy.toFixed(6)}\n`);

    // Apply echo cancellation with optimal attenuation
    const cancelledSamples = new Int16Array(micSamples.length);
    let sumAfter = 0;

    for (let i = 0; i < micSamples.length; i++) {
      const mic = micSamples[i] / 32768;
      const pbIndex = i - delaySamples;
      const pb = pbIndex >= 0 && pbIndex < pbSamples.length ? pbSamples[pbIndex] / 32768 : 0;
      
      const cancelled = mic - (optimalAttenuation * pb);
      sumAfter += cancelled * cancelled;
      
      // Clamp to 16-bit range
      cancelledSamples[i] = Math.max(-32768, Math.min(32767, Math.round(cancelled * 32768)));
    }

    const rmsBefore = Math.sqrt(sumBefore / micSamples.length);
    const rmsAfter = Math.sqrt(sumAfter / micSamples.length);
    const reductionRatio = rmsBefore > 0 ? (rmsBefore - rmsAfter) / rmsBefore : 0;

    process.stderr.write(`[CANCEL-OFFLINE] rmsBefore=${rmsBefore.toFixed(6)}, rmsAfter=${rmsAfter.toFixed(6)}, reduction=${(reductionRatio * 100).toFixed(1)}%\n`);

    const cancelledBuffer = Buffer.from(cancelledSamples.buffer, cancelledSamples.byteOffset, cancelledSamples.byteLength);

    return {
      cancelled: cancelledBuffer,
      rmsBefore,
      rmsAfter,
      reductionRatio,
      optimalAttenuation,
      delaySamples,
    };
  }
}
