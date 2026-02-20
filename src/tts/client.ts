import { spawn } from 'child_process';
import { PassThrough } from 'stream';

/**
 * Piper TTS integration for text-to-speech synthesis
 * Sends text to Piper HTTP API and streams audio response
 */

export class TTSClient {
  private currentPlaybackProcess: any = null;
  private isSpeakingNow: boolean = false;
  
  constructor(
    private piperUrl: string,
    private defaultVoiceId: string = 'en_US-amy-medium'
  ) {
    this.piperUrl = this.piperUrl.replace(/\/$/, '');
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
    
    const payload = {
      text,
      voice,
      ...(rate !== undefined && { rate }),
      ...(stability !== undefined && { stability }),
    };
    
    const response = await fetch(`${this.piperUrl}/api/tts`, {
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
    
    // Get audio data (assuming WAV format)
    const buffer = await response.arrayBuffer();
    return Buffer.from(buffer);
  }
  
  /**
   * Play audio using system player (aplay)
   * Starts playback and can be interrupted via stopPlayback()
   */
  async playAudio(audioBuffer: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      // Use aplay (ALSA player) for audio playback
      this.currentPlaybackProcess = spawn('aplay', [
        '-v', // Show volume
      ]);
      
      this.isSpeakingNow = true;
      
      this.currentPlaybackProcess.on('error', (error: Error) => {
        this.isSpeakingNow = false;
        reject(new Error(`Audio playback failed: ${error.message}`));
      });
      
      this.currentPlaybackProcess.on('close', (code: number | null) => {
        this.isSpeakingNow = false;
        if (code === 0 || code === null) { // null = killed by us
          resolve();
        } else {
          reject(new Error(`Audio playback exited with code ${code}`));
        }
      });
      
      // Write audio data
      this.currentPlaybackProcess.stdin.write(audioBuffer);
      this.currentPlaybackProcess.stdin.end();
    });
  }
  
  /**
   * Stop current audio playback (for cut-in)
   * Kills the playback process immediately
   */
  stopPlayback(): void {
    if (this.currentPlaybackProcess && !this.currentPlaybackProcess.killed) {
      this.currentPlaybackProcess.kill('SIGTERM');
      // Force kill if SIGTERM doesn't work
      setTimeout(() => {
        if (this.currentPlaybackProcess && !this.currentPlaybackProcess.killed) {
          this.currentPlaybackProcess.kill('SIGKILL');
        }
      }, 100);
      this.isSpeakingNow = false;
    }
  }
  
  /**
   * Check if currently speaking
   */
  isSpeaking(): boolean {
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
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      const response = await fetch(`${this.piperUrl}/api/voices`, {
        method: 'GET',
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      return response.ok;
    } catch {
      return false;
    }
  }
}
