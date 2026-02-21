import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import { Readable } from 'stream';
import { decodeWav } from './wav';

/**
 * Audio capture using PulseAudio parecord
 * Yields 16-bit mono PCM audio frames at configured sample rate
 */
export class AudioCapture {
  private process: any = null;
  private stream: Readable | null = null;
  private bufferSize: number;
  private stopped: boolean = false;
  
  constructor(
    private sampleRate: number = 16000,
    private device: string = 'default',
    private framesPerBuffer: number = 1024,
    private inputFile?: string,
    private inputFormat: 'wav' | 'raw' = 'wav'
  ) {
    // Buffer size in bytes: 16-bit (2 bytes) × num frames
    this.bufferSize = framesPerBuffer * 2;
  }
  
  /**
   * Start audio capture and yield frames
   */
  async *capture(): AsyncGenerator<Buffer> {
    this.stopped = false;

    if (this.inputFile) {
      yield* this.captureFromFile(this.inputFile);
      return;
    }

    yield* this.captureFromPulse();
  }

  private async *captureFromPulse(): AsyncGenerator<Buffer> {
    // parecord arguments
    const args = [
      '--format=s16',           // 16-bit signed PCM
      '--rate=' + this.sampleRate,
      '--channels=1',           // Mono
      '--device=' + this.device,
      '--raw',                  // Raw output (no WAV header)
    ];

    this.process = spawn('parecord', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.stream = this.process.stdout;

    // Track if process exited unexpectedly
    let processExited = false;
    
    this.process.on('exit', (code: number | null, signal: string | null) => {
      processExited = true;
      if (!this.stopped) {
        console.error(`[AudioCapture] parecord exited unexpectedly: code=${code} signal=${signal}`);
      }
    });

    this.process.on('error', (error: Error) => {
      if (!this.stopped) {
        console.error('[AudioCapture] parecord error:', error);
        throw error;
      }
    });

    this.process.stderr?.on('data', (data: Buffer) => {
      // Log PulseAudio warnings but don't fail
      const msg = data.toString().trim();
      // Filter out common non-critical messages
      if (!msg.includes('Connection failure') && !msg.includes('Broken pipe')) {
        console.warn('[AudioCapture]', msg);
      } else if (msg.includes('Broken pipe')) {
        console.error('[AudioCapture]', msg);
      }
    });

    let buffer = Buffer.alloc(0);
    let lastYieldTime = Date.now();

    try {
      for await (const chunk of this.stream as AsyncIterable<Buffer>) {
        if (this.stopped || processExited) {
          break;
        }
        
        // Periodically check if process is still alive
        if (Date.now() - lastYieldTime > 5000) {
          if (processExited) {
            console.error('[AudioCapture] Process died, ending stream');
            break;
          }
          lastYieldTime = Date.now();
        }
        
        buffer = Buffer.concat([buffer, chunk]);

        while (buffer.length >= this.bufferSize) {
          const frame = buffer.slice(0, this.bufferSize);
          buffer = buffer.slice(this.bufferSize);
          yield frame;
          lastYieldTime = Date.now();
        }
      }
    } finally {
      if (buffer.length > 0 && !this.stopped) {
        yield buffer;
      }
      
      // Clean up process if it's still running
      if (this.process && !this.process.killed && !processExited) {
        this.process.kill('SIGTERM');
      }
    }
  }

  private async *captureFromFile(filePath: string): AsyncGenerator<Buffer> {
    const data = Buffer.from(await fs.readFile(filePath));
    let pcm = data;

    if (this.inputFormat === 'wav' || filePath.toLowerCase().endsWith('.wav')) {
      const decoded = decodeWav(data);
      this.sampleRate = decoded.sampleRate;
      pcm = Buffer.from(decoded.pcm);
    }

    const frameDurationMs = (this.bufferSize / 2 / this.sampleRate) * 1000;

    for (let offset = 0; offset < pcm.length; offset += this.bufferSize) {
      if (this.stopped) {
        break;
      }
      const frame = pcm.slice(offset, offset + this.bufferSize);
      yield frame;
      await new Promise((resolve) => setTimeout(resolve, frameDurationMs));
    }
  }
  
  /**
   * Gracefully stop audio capture
   */
  stop(): void {
    this.stopped = true;
    if (this.process && !this.process.killed) {
      this.process.kill('SIGTERM');
      this.process = null;
      this.stream = null;
    }
  }
  
  /**
   * Force kill audio capture (emergency only)
   */
  kill(): void {
    this.stopped = true;
    if (this.process && !this.process.killed) {
      this.process.kill('SIGKILL');
      this.process = null;
      this.stream = null;
    }
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
    return this.process && !this.process.killed;
  }
}
