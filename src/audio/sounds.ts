import { encodeWav } from './wav';

/**
 * Generate a simple click/beep sound for audio feedback
 * @param sampleRate Sample rate (default 16000)
 * @param durationMs Duration in milliseconds (default 50ms)
 * @param frequency Tone frequency in Hz (default 800Hz for pleasant click)
 * @returns WAV audio buffer ready for playback
 */
export function generateClickSound(
  sampleRate: number = 16000,
  durationMs: number = 50,
  frequency: number = 800
): Buffer {
  const samples = Math.floor((sampleRate * durationMs) / 1000);
  const pcm = Buffer.alloc(samples * 2); // 16-bit = 2 bytes per sample
  
  for (let i = 0; i < samples; i++) {
    // Generate sine wave with envelope to avoid clicks
    const t = i / sampleRate;
    const envelope = Math.sin((Math.PI * i) / samples); // Fade in/out to smooth edges
    const amplitude = 0.3 * envelope; // Moderate volume (30% of max)
    const sample = Math.sin(2 * Math.PI * frequency * t) * amplitude;
    
    // Convert to 16-bit PCM
    const pcmValue = Math.floor(sample * 32767);
    pcm.writeInt16LE(pcmValue, i * 2);
  }
  
  return encodeWav(pcm, sampleRate, 1, 16);
}
