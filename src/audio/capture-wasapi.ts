import { AudioCaptureInterface, AudioCaptureConfig } from './interface';

/**
 * Windows audio capture using WASAPI (Windows Audio Session API)
 * Yields 16-bit mono PCM audio frames at configured sample rate
 * 
 * Platform: Windows only
 * Dependencies: Native WASAPI bindings (wasapi-bindings module)
 * 
 * WASAPI provides low-latency audio capture (15-30ms) compared to FFmpeg (100-200ms)
 * Uses event-driven architecture with IAudioCaptureClient for frame-ready notifications
 */
export class WindowsAudioCapture implements AudioCaptureInterface {
  private wasapiCapture: any = null;
  private isCapturing: boolean = false;
  private sampleRate: number;
  private device: string;
  private bufferSize: number;
  private exclusiveMode: boolean;
  
  constructor(config: AudioCaptureConfig = {}) {
    this.sampleRate = config.sampleRate || 16000;
    this.device = config.device || 'default';
    this.bufferSize = config.framesPerBuffer || 1024;
    
    // Exclusive mode: lower latency (5-10ms) but single app access
    // Shared mode: compatible (15-30ms) with multiple apps
    this.exclusiveMode = process.env.WASAPI_EXCLUSIVE_MODE === 'true';
    
    // Check if wasapi-bindings module is available
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { WASAPICapture } = require('wasapi-bindings');
      
      this.wasapiCapture = new WASAPICapture({
        sampleRate: this.sampleRate,
        channels: 1,                  // Mono
        bufferSize: this.bufferSize,  // Frames per buffer (~64ms at 16kHz)
        loopback: false,              // Capture from microphone, not system audio
        exclusiveMode: this.exclusiveMode,
        deviceIndex: parseInt(this.device, 10) || 0,
      });
    } catch (error) {
      throw new Error(
        `Failed to load WASAPI bindings. Windows platform requires native wasapi-bindings module.\n` +
        `Error: ${error instanceof Error ? error.message : String(error)}\n` +
        `Build instructions: npm install && npm run build`
      );
    }
  }
  
  /**
   * Start audio capture and yield frames
   * Uses event-driven WASAPI architecture with Promise-based async frames
   */
  async *capture(): AsyncGenerator<Buffer> {
    this.isCapturing = true;
    
    try {
      // Start WASAPI capture (initializes IAudioClient and IAudioCaptureClient)
      await this.wasapiCapture.start();
      
      while (this.isCapturing) {
        try {
          // GetFrame() returns Promise<Buffer> when audio frame is ready
          // Timeout after 100ms to allow checking isCapturing flag
          const buffer = await this.wasapiCapture.getFrame(100);
          
          if (buffer && buffer.length > 0) {
            yield buffer;
          }
        } catch (error) {
          // Device disconnected or WASAPI error
          if (!this.isCapturing) {
            break;
          }
          
          console.error('[WindowsAudioCapture] WASAPI error:', error);
          throw error;
        }
      }
    } finally {
      if (this.wasapiCapture) {
        this.wasapiCapture.stop();
      }
    }
  }
  
  /**
   * Gracefully stop audio capture
   */
  stop(): void {
    this.isCapturing = false;
    if (this.wasapiCapture) {
      this.wasapiCapture.stop();
    }
  }
  
  /**
   * Force kill audio capture (same as stop for WASAPI)
   */
  kill(): void {
    this.stop();
  }
  
  /**
   * Get sample rate for calculations
   */
  getSampleRate(): number {
    return this.sampleRate;
  }
  
  /**
   * Check if still running
   */
  isRunning(): boolean {
    return this.isCapturing;
  }
  
  /**
   * List available WASAPI capture devices (static utility)
   */
  static async listDevices(): Promise<Array<{ index: number; name: string; guid: string }>> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { WASAPICapture } = require('wasapi-bindings');
      return await WASAPICapture.enumerateDevices();
    } catch (error) {
      console.warn('[WindowsAudioCapture] Cannot enumerate WASAPI devices:', error);
      return [];
    }
  }
}
