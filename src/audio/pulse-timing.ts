/**
 * PulseAudio Timing Utilities
 * 
 * Extract timing information from PulseAudio to aid echo cancellation alignment.
 * Uses `pactl` and process management to query stream latency.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface PulseStreamInfo {
  moduleIndex: number;
  state: string;
  sampleRate: number;
  channels: number;
  latencyUsec: number | null;
  bufferSize: number | null;
}

export interface PulseTimingInfo {
  sinkLatencyUsec: number;
  sourceLatencyUsec: number;
  totalLatencyMs: number;
}

/**
 * PulseAudio timing extractor
 * Queries PulseAudio for stream latency information
 */
export class PulseAudioTiming {
  /**
   * Get sink (playback) latency from PulseAudio
   * Returns latency in microseconds, or null if not available
   */
  static async getSinkLatency(sinkName?: string): Promise<number | null> {
    try {
      const { stdout } = await execFileAsync('pactl', ['list', 'sinks']);
      
      // Parse sink list for latency info
      const sinks = stdout.split('\n\n');
      let targetSink = sinks[0]; // default to first
      
      if (sinkName) {
        targetSink = sinks.find(s => s.includes(`Name: ${sinkName}`)) || targetSink;
      }
      
      // Look for "Latency: X usec"
      const match = targetSink?.match(/Latency:\s+(\d+)\s+usec/);
      if (match && match[1]) {
        return parseInt(match[1], 10);
      }
      
      return null;
    } catch (error) {
      console.error('[PA-TIMING] Failed to get sink latency:', error);
      return null;
    }
  }

  /**
   * Get source (capture) latency from PulseAudio
   * Returns latency in microseconds, or null if not available
   */
  static async getSourceLatency(sourceName?: string): Promise<number | null> {
    try {
      const { stdout } = await execFileAsync('pactl', ['list', 'sources']);
      
      const sources = stdout.split('\n\n');
      let targetSource = sources[0];
      
      if (sourceName) {
        targetSource = sources.find(s => s.includes(`Name: ${sourceName}`)) || targetSource;
      }
      
      const match = targetSource?.match(/Latency:\s+(\d+)\s+usec/);
      if (match && match[1]) {
        return parseInt(match[1], 10);
      }
      
      return null;
    } catch (error) {
      console.error('[PA-TIMING] Failed to get source latency:', error);
      return null;
    }
  }

  /**
   * Get combined timing info for echo cancellation
   * Estimates total acoustic delay from playback to capture
   */
  static async getEchoCancellationTiming(
    sinkName?: string,
    sourceName?: string,
  ): Promise<PulseTimingInfo | null> {
    try {
      const [sinkLatency, sourceLatency] = await Promise.all([
        this.getSinkLatency(sinkName),
        this.getSourceLatency(sourceName),
      ]);
      
      if (sinkLatency === null || sourceLatency === null) {
        console.error('[PA-TIMING] Could not retrieve all latencies');
        return null;
      }
      
      // Total latency = sink buffering + source buffering
      // (acoustic propagation time is typically <3ms and negligible)
      const totalUsec = sinkLatency + sourceLatency;
      const totalMs = totalUsec / 1000;
      
      return {
        sinkLatencyUsec: sinkLatency,
        sourceLatencyUsec: sourceLatency,
        totalLatencyMs: totalMs,
      };
    } catch (error) {
      console.error('[PA-TIMING] Failed to get timing info:', error);
      return null;
    }
  }

  /**
   * List all PulseAudio sinks with their latency
   * Useful for diagnostics
   */
  static async listSinks(): Promise<
    Array<{ name: string; description: string; latencyUsec: number | null }>
  > {
    try {
      const { stdout } = await execFileAsync('pactl', ['list', 'sinks']);
      const sinks = stdout.split('\n\n');
      
      return sinks
        .filter(s => s.trim().length > 0)
        .map(sink => {
          const nameMatch = sink.match(/Name:\s+(.+)/);
          const descMatch = sink.match(/Description:\s+(.+)/);
          const latencyMatch = sink.match(/Latency:\s+(\d+)\s+usec/);
          
          return {
            name: nameMatch?.[1] || 'unknown',
            description: descMatch?.[1] || 'unknown',
            latencyUsec: latencyMatch?.[1] ? parseInt(latencyMatch[1], 10) : null,
          };
        });
    } catch (error) {
      console.error('[PA-TIMING] Failed to list sinks:', error);
      return [];
    }
  }

  /**
   * List all PulseAudio sources with their latency
   */
  static async listSources(): Promise<
    Array<{ name: string; description: string; latencyUsec: number | null }>
  > {
    try {
      const { stdout } = await execFileAsync('pactl', ['list', 'sources']);
      const sources = stdout.split('\n\n');
      
      return sources
        .filter(s => s.trim().length > 0)
        .map(source => {
          const nameMatch = source.match(/Name:\s+(.+)/);
          const descMatch = source.match(/Description:\s+(.+)/);
          const latencyMatch = source.match(/Latency:\s+(\d+)\s+usec/);
          
          return {
            name: nameMatch?.[1] || 'unknown',
            description: descMatch?.[1] || 'unknown',
            latencyUsec: latencyMatch?.[1] ? parseInt(latencyMatch[1], 10) : null,
          };
        });
    } catch (error) {
      console.error('[PA-TIMING] Failed to list sources:', error);
      return [];
    }
  }
}
