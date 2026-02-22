/**
 * Voice Activity Detection using RMS-based energy analysis
 * Detects speech through acoustic energy with adaptive noise floor
 */
export interface VADConfig {
  /** Silence threshold multiplier (default 1.5) */
  silenceThreshold: number;
  /** Absolute RMS threshold to force speech detection (default 0) */
  absoluteSpeechRms: number;
  /** Absolute RMS threshold below which speech is forced off (default 0) */
  absoluteSilenceRms: number;
  /** Minimum silence duration in ms (default 400) */
  minSilenceDuration: number;
  /** Minimum speech duration in ms before silence can end it (default 200) */
  minSpeechDuration: number;
  /** Noise floor update rate 0-1 (default 0.1) */
  noiseFloorAlphaSmoothing: number;
  /** RMS level threshold for noise floor (default 0.02) */
  noiseFloorThreshold: number;
}

export class VoiceActivityDetector {
  private noiseFloor: number = 0.02;
  private isCurrentlySpeaking: boolean = false;
  private silenceDurationMs: number = 0;
  private speechDurationMs: number = 0;
  private lastFrameTime: number = 0;
  private config: VADConfig;
  
  constructor(
    private sampleRate: number = 16000,
    config: Partial<VADConfig> = {}
  ) {
    this.config = {
      silenceThreshold: 1.2,
      absoluteSpeechRms: 0.02,
      absoluteSilenceRms: 0.01,
      minSilenceDuration: 400,
      minSpeechDuration: 200,
      noiseFloorAlphaSmoothing: 0.1,
      noiseFloorThreshold: 0.01,
      ...config,
    };
  }
  
  /**
   * Analyze audio frame and detect speech activity
   * Returns true if speech is detected in this frame
   */
  analyze(frame: Buffer): boolean {
    const now = Date.now();
    const frameTimestampMs = (frame.length / 2 / this.sampleRate) * 1000;
    
    // Calculate RMS (Root Mean Square) energy
    const rms = this.calculateRMS(frame);
    
    // Update noise floor: adaptive estimation of quiet baseline
    if (rms < this.config.noiseFloorThreshold) {
      this.noiseFloor = 
        this.config.noiseFloorAlphaSmoothing * rms +
        (1 - this.config.noiseFloorAlphaSmoothing) * this.noiseFloor;
    }
    
    // Detect if this frame has speech
    const threshold = this.noiseFloor * this.config.silenceThreshold;
    let hasSpeech = rms > threshold || rms >= this.config.absoluteSpeechRms;
    if (this.config.absoluteSilenceRms > 0 && rms < this.config.absoluteSilenceRms) {
      hasSpeech = false;
    }
    
    // Update timing
    if (this.lastFrameTime === 0) {
      this.lastFrameTime = now;
    }
    const elapsedMs = now - this.lastFrameTime;
    this.lastFrameTime = now;
    
    // Update speech/silence duration
    if (hasSpeech) {
      this.speechDurationMs += elapsedMs;
      this.silenceDurationMs = 0;
    } else {
      this.silenceDurationMs += elapsedMs;
    }
    
    // Determine current state
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
    }
    
    if (wasEndingSpeech) {
      this.isCurrentlySpeaking = false;
    }
    
    return this.isCurrentlySpeaking;
  }
  
  /**
   * Check if silence has been finalized (user stopped speaking)
   */
  isSilenceFinalized(): boolean {
    return (
      !this.isCurrentlySpeaking &&
      this.silenceDurationMs >= this.config.minSilenceDuration
    );
  }
  
  /**
   * Reset detector state (after silence finalized)
   */
  reset(): void {
    this.isCurrentlySpeaking = false;
    this.silenceDurationMs = 0;
    this.speechDurationMs = 0;
    this.lastFrameTime = 0;
  }
  
  /**
   * Get current state for debugging
   */
  getState() {
    return {
      isCurrentlySpeaking: this.isCurrentlySpeaking,
      silenceDurationMs: this.silenceDurationMs,
      speechDurationMs: this.speechDurationMs,
      noiseFloor: this.noiseFloor.toFixed(6),
      threshold: (this.noiseFloor * this.config.silenceThreshold).toFixed(6),
    };
  }
  
  /**
   * Calculate RMS energy of frame
   * Frame is 16-bit signed little-endian PCM
   */
  private calculateRMS(frame: Buffer): number {
    let sum = 0;
    const samples = frame.length / 2;
    
    for (let i = 0; i < frame.length; i += 2) {
      // Read 16-bit signed sample (little-endian)
      const sample = frame.readInt16LE(i);
      sum += sample * sample;
    }
    
    const mean = sum / samples;
    const rms = Math.sqrt(mean);
    
    // Normalize to 0-1 range (max 32768 for 16-bit signed)
    return rms / 32768;
  }
}
