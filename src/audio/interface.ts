/**
 * Platform-agnostic audio capture interface
 * 
 * Implementations:
 * - Linux: PulseAudio/ALSA via parecord
 * - Windows: WASAPI native bindings
 * - macOS: CoreAudio (future)
 */
export interface AudioCaptureInterface {
  /**
   * Start audio capture and yield frames
   * Yields 16-bit mono PCM audio frames at configured sample rate
   */
  capture(): AsyncGenerator<Buffer>;
  
  /**
   * Gracefully stop audio capture
   */
  stop(): void;
  
  /**
   * Force kill audio capture (emergency only)
   */
  kill(): void;
  
  /**
   * Get sample rate for calculations
   */
  getSampleRate(): number;
  
  /**
   * Check if still running
   */
  isRunning(): boolean;
}

/**
 * Audio capture configuration
 */
export interface AudioCaptureConfig {
  sampleRate?: number;
  device?: string;
  framesPerBuffer?: number;
}

/**
 * Platform-agnostic audio playback interface
 * 
 * Implementations:
 * - Linux: ALSA via aplay/paplay
 * - Windows: WASAPI native bindings
 * - macOS: CoreAudio (future)
 */
export interface AudioPlaybackInterface {
  /**
   * Play audio buffer (WAV format)
   * Returns promise that resolves when playback completes
   */
  playAudio(buffer: Buffer): Promise<void>;
  
  /**
   * Stop current audio playback (for interruption/cut-in)
   */
  stopPlayback(requestTimeHR?: bigint): void;
  
  /**
   * Check if currently playing
   */
  isPlaying(): boolean;
  
  /**
   * Health check for audio system
   */
  healthCheck(): Promise<boolean>;
  
  /**
   * Set callback to receive playback audio for echo cancellation
   * Called when audio starts playing with the WAV buffer
   */
  setPlaybackCallback(callback: ((buffer: Buffer) => void) | null): void;
}

/**
 * TTS client configuration
 */
export interface TTSClientConfig {
  piperUrl: string;
  defaultVoiceId?: string;
  playbackDevice?: string; // For ALSA playback
}
