/**
 * Acoustic Echo Cancellation (AEC) Module
 * 
 * Implements echo cancellation to prevent TTS playback from triggering
 * false cut-in detection by removing known playback signal from mic input.
 * 
 * Method: Static subtraction with cross-correlation time alignment
 * 
 * Flow:
 * 1. TTS playback buffer is stored with timestamp
 * 2. Mic frames are cross-correlated with playback buffer to find delay
 * 3. Time-aligned playback is subtracted from mic input
 * 4. Result is "echo-cancelled" audio for VAD/Whisper
 */

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
}

export class EchoCanceller {
  private config: EchoCancellationConfig;
  private playbackBuffer: PlaybackFrame[] = [];
  private playbackSeq: number = 0;
  private estimatedDelayMs: number = 0;
  private lastCalibrationTime: number = 0;
  private maxPlaybackFrames: number;
  
  constructor(config: EchoCancellationConfig) {
    this.config = config;
    // Calculate how many frames to keep based on tail length
    const msPerFrame = (config.frameSize / config.sampleRate) * 1000;
    this.maxPlaybackFrames = Math.ceil((config.tailLength + 500) / msPerFrame); // +500ms margin
    
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
    
    // Subtract playback from mic
    const cancelled = this.subtractFrames(micFrame, playbackFrame.data, this.config.attenuation);
    
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
}
