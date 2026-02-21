import { AudioCaptureInterface, AudioCaptureConfig } from './interface';
import { LinuxAudioCapture } from './capture-linux';
import { WindowsAudioCapture } from './capture-wasapi';

/**
 * Platform-agnostic audio capture factory
 * 
 * Automatically selects the appropriate implementation based on platform:
 * - Linux: PulseAudio/ALSA via parecord
 * - Windows: WASAPI native bindings  
 * - macOS: (future) CoreAudio
 * 
 * This maintains backward compatibility while enabling cross-platform support
 */

/**
 * Backward compatibility: Export AudioCapture with old constructor signature
 * Wraps the new config-based interface
 */
export class AudioCapture implements AudioCaptureInterface {
  private impl: AudioCaptureInterface;
  
  constructor(
    sampleRate: number = 16000,
    device: string = 'default',
    framesPerBuffer: number = 1024
  ) {
    const config: AudioCaptureConfig = {
      sampleRate,
      device,
      framesPerBuffer,
    };
    
    this.impl = createAudioCapture(config);
  }
  
  async *capture(): AsyncGenerator<Buffer> {
    yield* this.impl.capture();
  }
  
  stop(): void {
    this.impl.stop();
  }
  
  kill(): void {
    this.impl.kill();
  }
  
  getSampleRate(): number {
    return this.impl.getSampleRate();
  }
  
  isRunning(): boolean {
    return this.impl.isRunning();
  }
}

/**
 * Create audio capture instance based on current platform
 */
export function createAudioCapture(config: AudioCaptureConfig = {}): AudioCaptureInterface {
  const platform = process.platform;
  
  if (platform === 'win32') {
    console.log('[AudioCapture] Using Windows WASAPI for low-latency audio');
    return new WindowsAudioCapture(config);
  } else if (platform === 'linux') {
    console.log('[AudioCapture] Using Linux PulseAudio for audio capture');
    return new LinuxAudioCapture(config);
  } else if (platform === 'darwin') {
    // TODO: Implement CoreAudio for macOS
    console.warn('[AudioCapture] macOS CoreAudio not yet implemented, falling back to Linux implementation');
    return new LinuxAudioCapture(config);
  } else {
    throw new Error(`Unsupported platform: ${platform}`);
  }
}

// Re-export platform-specific implementations for testing
export { LinuxAudioCapture, WindowsAudioCapture };
