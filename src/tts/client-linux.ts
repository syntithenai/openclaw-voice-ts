import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AudioPlaybackInterface, TTSClientConfig } from '../audio/interface';

/**
 * Linux TTS client using Piper HTTP API for synthesis
 * and PulseAudio/ALSA for playback
 * 
 * Platform: Linux only
 * Dependencies: PulseAudio (paplay) or ALSA (aplay)
 */
export class LinuxTTSClient implements AudioPlaybackInterface {
  private piperUrl: string;
  private defaultVoiceId: string;
  private currentPlaybackProcess: any = null;
  private isSpeakingNow: boolean = false;
  private currentTempFile: string | null = null;
  private playbackDevice?: string;
  
  constructor(config: TTSClientConfig) {
    this.piperUrl = config.piperUrl.replace(/\/$/, '');
    this.defaultVoiceId = config.defaultVoiceId || 'en_US-amy-medium';
    this.playbackDevice = config.playbackDevice;
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
  stopPlayback(requestTimeHR?: bigint): void {
    const stopReceiveTimeHR = process.hrtime.bigint();
    const timeSinceRequestMicros = requestTimeHR ? Number(stopReceiveTimeHR - requestTimeHR) / 1000 : 0;
    
    if (this.currentPlaybackProcess && !this.currentPlaybackProcess.killed) {
      const sigTermTimeHR = process.hrtime.bigint();
      process.stderr.write(`[CUT-IN-LATENCY] 🛑 Sending SIGTERM to PID=${this.currentPlaybackProcess.pid} (request latency=${timeSinceRequestMicros.toFixed(2)}µs)\n`);
      this.currentPlaybackProcess.kill('SIGTERM');
      
      // Force kill if SIGTERM doesn't work - check immediately
      setTimeout(() => {
        if (this.currentPlaybackProcess && !this.currentPlaybackProcess.killed) {
          const killTimeHR = process.hrtime.bigint();
          const timeToKill = Number(killTimeHR - sigTermTimeHR) / 1000;
          process.stderr.write(`[CUT-IN-LATENCY] 💣 SIGTERM ineffective, sending SIGKILL to PID=${this.currentPlaybackProcess.pid} (${timeToKill.toFixed(2)}µs after SIGTERM)\n`);
          this.currentPlaybackProcess.kill('SIGKILL');
        }
      }, 50); // More aggressive timeout
      
      this.isSpeakingNow = false;
      process.stderr.write(`[CUT-IN-LATENCY] ✓ Playback stop sequence initiated (total latency=${(timeSinceRequestMicros/1000).toFixed(2)}ms)\n`);
    } else {
      process.stderr.write('[TTS] No active playback process to stop\n');
    }
    this.cleanupTempFile();
  }
  
  /**
   * Check if currently speaking
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

    // For ALSA, use playback device if specified
    const args = ['-q'];
    if (this.playbackDevice) {
      args.push('-D', this.playbackDevice);
    }
    return { command: 'aplay', args };
  }

  private cleanupTempFile(): void {
    if (this.currentTempFile) {
      void fs.unlink(this.currentTempFile).catch(() => undefined);
      this.currentTempFile = null;
    }
  }
  
  /**
   * Additional helper for backward compatibility
   */
  isSpeaking(): boolean {
    return this.isSpeakingNow;
  }
}
