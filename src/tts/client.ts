import { AudioPlaybackInterface, TTSClientConfig } from '../audio/interface';
import { LinuxTTSClient } from './client-linux';
import { WindowsTTSClient } from './client-wasapi';

/**
 * Platform-agnostic TTS client factory
 * 
 * Automatically selects the appropriate implementation based on platform:
 * - Linux: PulseAudio/ALSA playback via subprocess
 * - Windows: WASAPI native playback
 * - macOS: (future) CoreAudio
 * 
 * Synthesis uses Piper HTTP API on all platforms
 * This maintains backward compatibility while enabling cross-platform support
 */

/**
 * Backward compatibility: Export TTSClient with old constructor signature
 * Wraps the new config-based interface
 */
export class TTSClient {
  private impl: any; // LinuxTTSClient or WindowsTTSClient (both extend interface)
  
  constructor(
    piperUrl: string,
    defaultVoiceId: string = 'en_US-amy-medium',
    playbackDevice?: string
  ) {
    const config: TTSClientConfig = {
      piperUrl,
      defaultVoiceId,
      playbackDevice,
    };
    
    this.impl = createTTSClient(config);
  }
  
  async synthesize(
    text: string,
    voiceId?: string,
    rate?: number,
    stability?: number
  ): Promise<Buffer> {
    return this.impl.synthesize(text, voiceId, rate, stability);
  }
  
  async playAudio(audioBuffer: Buffer): Promise<void> {
    return this.impl.playAudio(audioBuffer);
  }
  
  stopPlayback(requestTimeHR?: bigint): void {
    this.impl.stopPlayback(requestTimeHR);
  }
  
  isSpeaking(): boolean {
    return this.impl.isSpeaking ? this.impl.isSpeaking() : this.impl.isPlaying();
  }
  
  async speak(
    text: string,
    voiceId?: string,
    rate?: number,
    stability?: number
  ): Promise<void> {
    return this.impl.speak(text, voiceId, rate, stability);
  }
  
  async healthCheck(): Promise<boolean> {
    return this.impl.healthCheck();
  }
  
  setPlaybackCallback(callback: ((buffer: Buffer) => void) | null): void {
    this.impl.setPlaybackCallback(callback);
  }
}

/**
 * Create TTS client instance based on current platform
 */
export function createTTSClient(config: TTSClientConfig): AudioPlaybackInterface {
  const platform = process.platform;
  
  if (platform === 'win32') {
    console.log('[TTSClient] Using Windows WASAPI for low-latency audio playback');
    return new WindowsTTSClient(config);
  } else if (platform === 'linux') {
    console.log('[TTSClient] Using Linux PulseAudio/ALSA for audio playback');
    return new LinuxTTSClient(config);
  } else if (platform === 'darwin') {
    // TODO: Implement CoreAudio for macOS
    console.warn('[TTSClient] macOS CoreAudio not yet implemented, falling back to Linux implementation');
    return new LinuxTTSClient(config);
  } else {
    throw new Error(`Unsupported platform: ${platform}`);
  }
}

// Re-export platform-specific implementations for testing
export { LinuxTTSClient, WindowsTTSClient };
