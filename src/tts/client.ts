import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * Piper TTS integration for text-to-speech synthesis
 * Sends text to Piper HTTP API and streams audio response
 */

export class TTSClient {
  private currentPlaybackProcess: any = null;
  private isSpeakingNow: boolean = false;
  private currentTempFile: string | null = null;
  
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
    
    const payload: Record<string, any> = {
      text,
    };
    
    // Only include voice if it's not the default (Piper -m flag handles default)
    if (voiceId) {
      payload.voice = voice;
    }
    
    // Piper uses length_scale for speaking speed
    if (rate !== undefined) {
      payload.length_scale = rate;
    }
    
    // Piper uses noise_scale for variability
    if (stability !== undefined) {
      payload.noise_scale = stability;
    }
    
    // Piper HTTP API is at the root endpoint /
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
    
    // Get audio data (WAV format)
    const buffer = await response.arrayBuffer();
    return Buffer.from(buffer);
  }
  
  /**
    * Play audio using system player (paplay/aplay)
   * Starts playback and can be interrupted via stopPlayback()
   */
  async playAudio(audioBuffer: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      const player = this.resolvePlayerCommand();
      const tempFile = join(tmpdir(), `tts-${randomUUID()}.wav`);
      this.currentTempFile = tempFile;

      void fs.writeFile(tempFile, audioBuffer).then(() => {
        this.currentPlaybackProcess = spawn(player.command, [...player.args, tempFile]);
        this.isSpeakingNow = true;

        this.currentPlaybackProcess.on('error', (error: Error) => {
          this.cleanupTempFile();
          this.isSpeakingNow = false;
          reject(new Error(`Audio playback failed: ${error.message}`));
        });

        this.currentPlaybackProcess.on('close', (code: number | null) => {
          this.cleanupTempFile();
          this.isSpeakingNow = false;
          if (code === 0 || code === null) {
            resolve();
          } else {
            reject(new Error(`Audio playback exited with code ${code}`));
          }
        });
      }).catch((error) => {
        this.cleanupTempFile();
        reject(new Error(`Failed to write temp audio file: ${error.message}`));
      });
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
    this.cleanupTempFile();
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
      const response = await fetch(`${this.piperUrl}/voices`, {
        method: 'GET',
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      return response.ok;
    } catch {
      return false;
    }
  }

  private resolvePlayerCommand(): { command: string; args: string[] } {
    const mode = (process.env.AUDIO_PLAYBACK || 'auto').toLowerCase();
    const hasPulse = Boolean(process.env.PULSE_SERVER || process.env.XDG_RUNTIME_DIR);

    if (mode === 'pulse' || (mode === 'auto' && hasPulse)) {
      return { command: 'paplay', args: [] };
    }

    return { command: 'aplay', args: ['-q'] };
  }

  private cleanupTempFile(): void {
    if (this.currentTempFile) {
      void fs.unlink(this.currentTempFile).catch(() => undefined);
      this.currentTempFile = null;
    }
  }
}
