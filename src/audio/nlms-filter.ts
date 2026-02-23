/**
 * NLMS (Normalized Least Mean Squares) Adaptive Filter
 * 
 * Learns the best linear approximation of acoustic echo path:
 *   echo ≈ WH(n) * reference(n-delay)
 * 
 * Where WH(n) is a time-varying weight vector that adapts to changes in:
 * - Speaker-to-mic acoustic path
 * - Room reflections and multipath
 * - Frequency-dependent response
 * 
 * Advantages over fixed subtraction:
 * - Handles room acoustics and speaker characteristics automatically
 * - Adapts to frequency-dependent delays
 * - Minimizes remaining error (RMS of cancellation residual)
 * - Robust to imperfect delay estimation
 */

export interface NLMSConfig {
  filterLength: number;     // Taps in the FIR filter (e.g., 512 for 10ms @ 48kHz)
  stepSize: number;         // Learning rate (0.1-1.0, typical 0.5)
  regularization: number;   // Normalization floor (1e-8 typical) to prevent divide-by-zero
  constrained: boolean;     // Clamp weights to [-1, 1] range
  leakage: number;          // Exponential decay factor (1.0 = no decay, 0.9999 = slow decay)
}

export class NLMSFilter {
  private weights: Float32Array;
  private config: NLMSConfig;
  private referenceBuffer: Float32Array;
  private refBufferPtr: number = 0;
  private initialized: boolean = false;

  constructor(config: NLMSConfig) {
    this.config = config;
    this.weights = new Float32Array(config.filterLength);
    this.referenceBuffer = new Float32Array(config.filterLength);
    
    // Initialize weights to small value (not zero, helps with learning)
    for (let i = 0; i < this.weights.length; i++) {
      this.weights[i] = 0.001;
    }
  }

  /**
   * Add a reference sample to the filter buffer
   * Call this for each new playback sample to build the reference history
   * 
   * @param sample Normalized 16-bit sample (-1 to 1)
   */
  pushReferenceFrame(frame: Buffer): void {
    const samples = new Int16Array(frame.buffer, frame.byteOffset, frame.length / 2);
    for (let i = 0; i < samples.length; i++) {
      const normalized = samples[i] / 32768;
      this.referenceBuffer[this.refBufferPtr] = normalized;
      this.refBufferPtr = (this.refBufferPtr + 1) % this.config.filterLength;
    }
    this.initialized = true;
  }

  /**
   * Push a single normalized reference sample into the buffer
   * Used for efficient offline processing where samples come one at a time
   */
  pushReferenceSample(normalizedSample: number): void {
    this.referenceBuffer[this.refBufferPtr] = normalizedSample;
    this.refBufferPtr = (this.refBufferPtr + 1) % this.config.filterLength;
    this.initialized = true;
  }

  /**
   * Estimate echo and return the error signal (residual)
   * 
   * The NLMS algorithm:
   *   1. Estimate echo: echo_hat = sum(w[k] * ref[n-k]) for k=0..L-1
   *   2. Compute error: e = mic - echo_hat
   *   3. Update weights: w[k] += (mu / (refEnergy + eps)) * e * ref[n-k]
   * 
   * Where mu is step size and eps is regularization
   * 
   * @param micSample Microphone sample (-1 to 1)
   * @returns { estimated: estimated echo, error: residual, convergence: adaptation magnitude }
   */
  processFrame(micSample: number): {
    estimated: number;
    error: number;
    convergence: number;
  } {
    if (!this.initialized) {
      return { estimated: 0, error: micSample, convergence: 0 };
    }

    // Estimate echo using current weights
    let estimated = 0;
    let refEnergy = 0;

    for (let k = 0; k < this.config.filterLength; k++) {
      const refIdx = (this.refBufferPtr - 1 - k + this.config.filterLength) % this.config.filterLength;
      const refSample = this.referenceBuffer[refIdx];

      estimated += this.weights[k] * refSample;
      refEnergy += refSample * refSample;
    }

    // Clamp estimate to valid range
    estimated = Math.max(-1, Math.min(1, estimated));

    // Compute error (residual)
    const error = micSample - estimated;

    // Normalize and adapt weights
    const normalization = refEnergy + this.config.regularization;
    const stepFactor = (this.config.stepSize / normalization) * error;

    let convergence = 0;

    for (let k = 0; k < this.config.filterLength; k++) {
      const refIdx = (this.refBufferPtr - 1 - k + this.config.filterLength) % this.config.filterLength;
      const refSample = this.referenceBuffer[refIdx];

      // Weight update with leakage
      const delta = stepFactor * refSample;
      const newWeight = this.config.leakage * this.weights[k] + delta;

      if (this.config.constrained) {
        this.weights[k] = Math.max(-1, Math.min(1, newWeight));
      } else {
        this.weights[k] = newWeight;
      }

      convergence += Math.abs(delta);
    }

    return {
      estimated: estimated * 32768,
      error: error * 32768,
      convergence: convergence,
    };
  }

  /**
   * Process a complete frame (multiple samples)
   * Returns array of residuals and average convergence
   */
  processBuffer(micBuffer: Buffer): {
    residuals: Buffer;
    avgConvergence: number;
    estimatedEcho: Buffer;
  } {
    const micSamples = new Int16Array(micBuffer.buffer, micBuffer.byteOffset, micBuffer.length / 2);
    const residuals = new Int16Array(micSamples.length);
    const estimatedEcho = new Int16Array(micSamples.length);

    let totalConvergence = 0;

    for (let i = 0; i < micSamples.length; i++) {
      const micNorm = micSamples[i] / 32768;
      const result = this.processFrame(micNorm);

      // Scale normalized float values back to int16 range
      residuals[i] = Math.round(result.error * 32768);
      estimatedEcho[i] = Math.round(result.estimated * 32768);
      totalConvergence += result.convergence;
    }

    const avgConvergence = totalConvergence / micSamples.length;

    return {
      residuals: Buffer.from(residuals.buffer, residuals.byteOffset, residuals.byteLength),
      avgConvergence: avgConvergence,
      estimatedEcho: Buffer.from(estimatedEcho.buffer, estimatedEcho.byteOffset, estimatedEcho.byteLength),
    };
  }

  /**
   * Get the learned filter coefficients
   * Useful for diagnostics and understanding what the filter learned
   */
  getWeights(): Float32Array {
    return new Float32Array(this.weights);
  }

  /**
   * Get the current reference buffer
   * Useful for monitoring the history
   */
  getReferenceBuffer(): Float32Array {
    return new Float32Array(this.referenceBuffer);
  }

  /**
   * Reset the filter for a new session
   */
  reset(): void {
    this.weights.fill(0.001);
    this.referenceBuffer.fill(0);
    this.refBufferPtr = 0;
    this.initialized = false;
  }

  /**
   * Get filter statistics for monitoring
   */
  getStats(): {
    filterLength: number;
    weightsRms: number;
    maxWeight: number;
    minWeight: number;
    initialized: boolean;
  } {
    let sumSq = 0;
    let maxW = -Infinity;
    let minW = Infinity;

    for (let i = 0; i < this.weights.length; i++) {
      sumSq += this.weights[i] * this.weights[i];
      maxW = Math.max(maxW, this.weights[i]);
      minW = Math.min(minW, this.weights[i]);
    }

    return {
      filterLength: this.config.filterLength,
      weightsRms: Math.sqrt(sumSq / this.weights.length),
      maxWeight: maxW,
      minWeight: minW,
      initialized: this.initialized,
    };
  }
}

/**
 * Multi-channel NLMS for stereo or multi-mic scenarios
 * Not currently used but available for future expansion
 */
export class MultiChannelNLMS {
  private filters: NLMSFilter[];

  constructor(channels: number, config: NLMSConfig) {
    this.filters = Array(channels)
      .fill(null)
      .map(() => new NLMSFilter(config));
  }

  pushReferenceFrame(frame: Buffer): void {
    for (const filter of this.filters) {
      filter.pushReferenceFrame(frame);
    }
  }

  processFrames(micBuffers: Buffer[]): {
    residuals: Buffer[];
    avgConvergences: number[];
  } {
    const residuals = [];
    const avgConvergences = [];

    for (let i = 0; i < this.filters.length; i++) {
      const result = this.filters[i].processBuffer(micBuffers[i]);
      residuals.push(result.residuals);
      avgConvergences.push(result.avgConvergence);
    }

    return { residuals, avgConvergences };
  }

  reset(): void {
    for (const filter of this.filters) {
      filter.reset();
    }
  }
}
