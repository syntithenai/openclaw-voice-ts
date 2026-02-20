import { spawn } from 'child_process';
import { Readable } from 'stream';

/**
 * Audio capture using PulseAudio parecord
 * Yields 16-bit mono PCM audio frames at configured sample rate
 */
export class AudioCapture {
  private process: any = null;
  private stream: Readable | null = null;
  private bufferSize: number;
  
  constructor(
    private sampleRate: number = 16000,
    private device: string = 'default',
    private framesPerBuffer: number = 1024
  ) {
    // Buffer size in bytes: 16-bit (2 bytes) × num frames
    this.bufferSize = framesPerBuffer * 2;
  }
  
  /**
   * Start audio capture and yield frames
   */
  async *capture(): AsyncGenerator<Buffer> {
    return new Promise((resolve, reject) => {
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
      
      this.process.on('error', reject);
      this.process.stderr?.on('data', (data: Buffer) => {
        // Log PulseAudio warnings but don't fail
        console.warn('[AudioCapture]', data.toString().trim());
      });
      
      // Buffer to accumulate partial frames
      let buffer = Buffer.alloc(0);
      
      this.stream?.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        
        // Yield complete frames
        while (buffer.length >= this.bufferSize) {
          const frame = buffer.slice(0, this.bufferSize);
          buffer = buffer.slice(this.bufferSize);
          resolve(frame);
        }
      });
      
      this.stream?.on('end', () => {
        // Yield any remaining partial frame
        if (buffer.length > 0) {
          resolve(buffer);
        }
      });
      
      this.stream?.on('error', reject);
    }) as any;
  }
  
  /**
   * Gracefully stop audio capture
   */
  stop(): void {
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
