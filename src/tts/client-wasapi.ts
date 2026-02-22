import { AudioPlaybackInterface, TTSClientConfig } from '../audio/interface';

/**
 * Windows TTS client using WASAPI for audio playback
 * 
 * Platform: Windows only
 * Dependencies: Native WASAPI bindings (wasapi-bindings module)
 * 
 * Note: Synthesis still uses Piper HTTP API (same as Linux), but playback
 * uses WASAPI for low-latency audio output (15-30ms) vs subprocess overhead
 */
export class WindowsTTSClient implements AudioPlaybackInterface {
  private piperUrl: string;
  private defaultVoiceId: string;
  private wasapiPlayback: any = null;
  private isSpeakingNow: boolean = false;
  
  constructor(config: TTSClientConfig) {
    this.piperUrl = config.piperUrl.replace(/\/$/, '');
    this.defaultVoiceId = config.defaultVoiceId || 'en_US-amy-medium';
    
    // Initialize WASAPI playback
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { WASAPIPlayback } = require('wasapi-bindings');
      
      this.wasapiPlayback = new WASAPIPlayback({
        sampleRate: 16000,        // Match Piper output
        channels: 1,              // Mono
        bufferSize: 1024,
        exclusiveMode: process.env.WASAPI_EXCLUSIVE_MODE === 'true',
      });
    } catch (error) {
      throw new Error(
        `Failed to load WASAPI playback bindings. Windows platform requires native wasapi-bindings module.\n` +
        `Error: ${error instanceof Error ? error.message : String(error)}\n` +
        `Build instructions: npm install && npm run build`
      );
    }
  }
  
  /**
   * Synthesize text to speech via Piper API
   * Returns audio buffer in WAV format
   */
  async synthesize(
    text: string,
    voiceId?: string,
    rate?: number,
    stability?: number
  ): Promise<Buffer> {
    const voice = voiceId || this.defaultVoiceId;
    
    const payload: Record<string, any> = {
      text,
    };
    
    if (voiceId) {
      payload.voice = voice;
    }
    
    if (rate !== undefined) {
      payload.length_scale = rate;
    }
    
    if (stability !== undefined) {
      payload.noise_scale = stability;
    }
    
    const response = await fetch(this.piperUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    
    if (!response.ok) {
      throw new Error(
        `TTS synthesis failed: ${response.status} ${response.statusText}`
      );
    }
    
    const buffer = await response.arrayBuffer();
    return Buffer.from(buffer);
  }
  
  /**
   * Play audio using WASAPI native playback
   * Low-latency direct hardware access
   */
  async playAudio(buffer: Buffer): Promise<void> {
    this.isSpeakingNow = true;
    try {
      // WASAPI play() method accepts Buffer and returns Promise
      await this.wasapiPlayback.play(buffer);
    } catch (error) {
      throw new Error(
        `WASAPI playback failed: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      this.isSpeakingNow = false;
    }
  }
  
  /**
   * Stop current audio playback (for cut-in)
   * WASAPI provides immediate stop with no subprocess overhead
   */
  stopPlayback(requestTimeHR?: bigint): void {
    const stopReceiveTimeHR = process.hrtime.bigint();
    const timeSinceRequestMicros = requestTimeHR ? Number(stopReceiveTimeHR - requestTimeHR) / 1000 : 0;
    
    if (this.isSpeakingNow && this.wasapiPlayback) {
      const stopStartTimeHR = process.hrtime.bigint();
      process.stderr.write(`[CUT-IN-LATENCY] 🛑 Stopping WASAPI playback (request latency=${timeSinceRequestMicros.toFixed(2)}µs)\n`);
      
      this.wasapiPlayback.stop();
      this.isSpeakingNow = false;
      
      const stopDurationMicros = Number(process.hrtime.bigint() - stopStartTimeHR) / 1000;
      process.stderr.write(`[CUT-IN-LATENCY] ✓ WASAPI stop complete (stop duration=${stopDurationMicros.toFixed(2)}µs, total=${(timeSinceRequestMicros/1000).toFixed(2)}ms)\n`);
    } else {
      process.stderr.write('[TTS] No active WASAPI playback to stop\n');
    }
  }
  
  /**
   * Check if currently playing
   */
  isPlaying(): boolean {
    return this.isSpeakingNow;
  }
  
  /**
   * Synthesize and play (combined operation)
   */
  async speak(
    text: string,
    voiceId?: string,
    rate?: number,
    stability?: number
  ): Promise<void> {
    const audioBuffer = await this.synthesize(text, voiceId, rate, stability);
    return this.playAudio(audioBuffer);
  }
  
  /**
   * Test Piper connectivity
   */
  async healthCheck(): Promise<boolean> {
    try {
      // Check Piper connectivity
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      const response = await fetch(`${this.piperUrl}/voices`, {
        method: 'GET',
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        return false;
      }
      
      // Check WASAPI device availability
      const devices = await this.wasapiPlayback.listDevices();
      return devices && devices.length > 0;
    } catch {
      return false;
    }
  }
  
  /**
   * Additional helper for backward compatibility
   */
  isSpeaking(): boolean {
    return this.isSpeakingNow;
  }
  
  /**
   * Set callback to receive playback audio for echo cancellation
   * Note: Windows implementation - currently no-op (echo cancellation not implemented for Windows yet)
   */
  setPlaybackCallback(callback: ((buffer: Buffer) => void) | null): void {
    // TODO: Implement echo cancellation for Windows WASAPI
    // For now, this is a no-op to satisfy the interface
  }
  
  /**
   * List available WASAPI playback devices (static utility)
   */
  static async listDevices(): Promise<Array<{ index: number; name: string; guid: string }>> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { WASAPIPlayback } = require('wasapi-bindings');
      const playback = new WASAPIPlayback({ sampleRate: 16000, channels: 1 });
      return await playback.listDevices();
    } catch (error) {
      console.warn('[WindowsTTSClient] Cannot enumerate WASAPI devices:', error);
      return [];
    }
  }
}
