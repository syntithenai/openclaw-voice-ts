import { AudioCapture } from '../audio/capture';
import { VoiceActivityDetector } from '../audio/vad';
import { encodeWav } from '../audio/wav';
import { generateClickSound } from '../audio/sounds';
import { GatewayWSClient } from '../gateway/ws-client';
import { ResponseParser, TTSDirective } from '../gateway/parser';
import { WhisperClient } from '../stt/whisper';
import { TTSClient } from '../tts/client';
import { Logger } from '../utils/logger';

/**
 * Voice orchestrator - main event loop
 * Handles: listening → sending → waiting → speaking → cut-in
 */

export type VoiceState = 'idle' | 'listening' | 'sending' | 'waiting' | 'speaking' | 'error';

export interface OrchestratorConfig {
  sessionKey: string;
  gatewayUrl: string;
  gatewayToken: string;
  agentId: string;
  whisperUrl?: string;
  whisperLanguage?: string;
  whisperModel?: string;
  piperUrl?: string;
  piperVoiceId?: string;
  audioCaptureDevice?: string;
  audioPlaybackDevice?: string;
  sampleRate?: number;
  maxListenMs?: number;
  preRollMs?: number;
  vadSilenceThreshold?: number;
  vadNoiseFloorThreshold?: number;
  vadMinSpeechMs?: number;
  vadMinSilenceMs?: number;
  vadDebug?: boolean;
  vadAbsoluteRms?: number;
  vadAbsoluteSilenceRms?: number;
  cutInAbsoluteRms?: number;
  cutInMinSpeechMs?: number;
  ttsDedupeWindowMs?: number;
  wakeWord?: string | string[];
  wakeWordTimeout?: number;
  sleepPhrase?: string;
  audioInputFile?: string;
  audioInputLoop?: boolean;
}

export class VoiceOrchestrator {
  private currentState: VoiceState = 'idle';
  private logger: Logger;
  private audioCapture: AudioCapture;
  private vad: VoiceActivityDetector;
  private gatewayClient: GatewayWSClient;
  private whisperClient: WhisperClient | null = null;
  private ttsClient: TTSClient;
  private isRunning: boolean = false;
  private shouldExit: boolean = false;
  private pendingAssistantResponse: string | null = null;
  private captureEnabled: boolean = true;
  private ttsHealthy: boolean | null = null;
  private whisperHealthy: boolean | null = null;
  
  // Queue-based architecture for non-blocking operation
  private messageQueue: string[] = [];
  private ttsQueue: TTSDirective[] = [];
  private lastQueuedTTSText: string = '';
  private lastQueuedTTSAt: number = 0;
  private gatewayTextBuffer: string = ''; // Buffer partial text until sentence completes
  private gatewayFlushTimeout: NodeJS.Timeout | null = null; // Flush buffer after timeout
  
  // Shared audio stream for continuous capture
  private audioStream: AsyncGenerator<Buffer> | null = null;
  
  // Circular audio buffer to prevent parecord blocking
  private audioBuffer: Buffer[] = [];
  private readonly maxBufferFrames: number = 300; // ~6 seconds at 20ms frames
  private bufferLock: boolean = false;
  
  // Wake word timeout state
  private isAwake: boolean = true;
  private lastActivityTime: number = Date.now();
  private lastTtsActivityTime: number = 0;
  
  // Wake word audio feedback
  private wakeClickSound: Buffer;
  
  constructor(
    private config: OrchestratorConfig,
    logger?: Logger
  ) {
    this.logger = logger || new Logger('VoiceOrchestrator');
    
    this.audioCapture = new AudioCapture(
      config.sampleRate || 16000,
      config.audioCaptureDevice || 'default',
      1024
    );
    
    this.vad = new VoiceActivityDetector(config.sampleRate || 16000, {
      silenceThreshold: config.vadSilenceThreshold,
      absoluteSpeechRms: config.vadAbsoluteRms,
      absoluteSilenceRms: config.vadAbsoluteSilenceRms,
      noiseFloorThreshold: config.vadNoiseFloorThreshold,
      minSpeechDuration: config.vadMinSpeechMs,
      minSilenceDuration: config.vadMinSilenceMs,
    });
    
    this.gatewayClient = new GatewayWSClient({
      gatewayUrl: config.gatewayUrl,
      token: config.gatewayToken,
      sessionKey: config.sessionKey,
    });
    
    // Listen for assistant messages and queue TTS
    this.gatewayClient.on('assistant-message', (message: any) => {
      const text = this.extractTextFromMessage(message);
      if (text.trim()) {
        // Gateway sends COMPLETE text each time (not deltas)
        // Always replace buffer with latest text
        this.gatewayTextBuffer = text;
        
        // Check if we have sentence-ending punctuation
        const sentenceMatch = this.gatewayTextBuffer.match(/(.+?[.!?])\s*$/);
        
        if (sentenceMatch) {
          // Complete sentence found
          const completeSentence = sentenceMatch[1].trim();
          
          // Clear buffer and timeout
          this.gatewayTextBuffer = '';
          if (this.gatewayFlushTimeout) {
            clearTimeout(this.gatewayFlushTimeout);
            this.gatewayFlushTimeout = null;
          }
          
          const windowMs = this.config.ttsDedupeWindowMs ?? 800;
          const now = Date.now();
          const isWithinWindow = windowMs > 0 && (now - this.lastQueuedTTSAt) <= windowMs;
          const getLeadingWords = (s: string): string => {
            const words = s.split(/\s+/).slice(0, 3).join(' ');
            return words.toLowerCase();
          };
          const thisSentenceStart = getLeadingWords(completeSentence);
          const prevSentenceStart = getLeadingWords(this.lastQueuedTTSText);

          if (isWithinWindow && thisSentenceStart === prevSentenceStart) {
            this.logger.info(`[GATEWAY-SENTENCE] Duplicate shard within ${windowMs}ms, skipped: "${completeSentence.substring(0, 80)}..."`);
          } else {
            this.logger.info(`[GATEWAY-SENTENCE] Queuing: "${completeSentence.substring(0, 80)}..."`);
            this.lastQueuedTTSText = completeSentence;
            this.lastQueuedTTSAt = now;
            const directives = this.parseTTSDirectives(completeSentence);
            this.ttsQueue.push(...directives);
          }
        } else if (this.gatewayTextBuffer.trim().length > 20) {
          // Text is accumulating - set timeout to flush if no sentence end comes
          if (!this.gatewayFlushTimeout) {
            this.gatewayFlushTimeout = setTimeout(() => {
              if (this.gatewayTextBuffer.trim()) {
                const hesitant = this.gatewayTextBuffer.trim();
                const windowMs = this.config.ttsDedupeWindowMs ?? 800;
                const now = Date.now();
                const isWithinWindow = windowMs > 0 && (now - this.lastQueuedTTSAt) <= windowMs;
                const getLeadingWords = (s: string): string => {
                  const words = s.split(/\s+/).slice(0, 3).join(' ');
                  return words.toLowerCase();
                };
                const thisSentenceStart = getLeadingWords(hesitant);
                const prevSentenceStart = getLeadingWords(this.lastQueuedTTSText);

                if (isWithinWindow && thisSentenceStart === prevSentenceStart) {
                  this.logger.info(`[GATEWAY-SENTENCE] Timeout duplicate shard within ${windowMs}ms, skipped: "${hesitant.substring(0, 80)}..."`);
                } else {
                  this.logger.info(`[GATEWAY-SENTENCE] Timeout flush (no punctuation): "${hesitant.substring(0, 80)}..."`);
                  const directives = this.parseTTSDirectives(hesitant);
                  this.ttsQueue.push(...directives);
                  this.lastQueuedTTSText = hesitant;
                  this.lastQueuedTTSAt = now;
                }
                this.gatewayTextBuffer = '';
              }
              this.gatewayFlushTimeout = null;
            }, 5000); // 5 second timeout
          }
        }
      }
    });
    
    this.gatewayClient.on('error', (error: Error) => {
      this.logger.error('Gateway error:', error);
    });
    
    if (config.whisperUrl) {
      this.whisperClient = new WhisperClient(config.whisperUrl);
    }

    this.ttsClient = new TTSClient(
      config.piperUrl || 'http://piper:5002',
      config.piperVoiceId || 'en_US-amy-medium',
      config.audioPlaybackDevice
    );
    
    // Pre-generate wake word click sound
    this.wakeClickSound = generateClickSound(config.sampleRate || 16000, 50, 800);
  }
  
  /**
   * Extract text content from assistant message
   */
  private extractTextFromMessage(message: any): string {
    // Agent events have streaming text in data.text
    if (message.data?.text) {
      return message.data.text;
    }
    // Chat message format  
    if (typeof message.content === 'string') {
      return message.content;
    }
    if (Array.isArray(message.content)) {
      return message.content
        .filter((block: any) => block.type === 'text')
        .map((block: any) => block.text || '')
        .join('\n');
    }
    return '';
  }
  
  /**
   * Start the main voice interaction loop with parallel tasks
   */
  async start(): Promise<void> {
    this.isRunning = true;
    this.shouldExit = false;
    
    try {
      // Connect to gateway WebSocket
      await this.gatewayClient.connect();
      this.logger.info('Connected to gateway');
      
      // Health check TTS
      this.ttsHealthy = await this.ttsClient.healthCheck();
      if (!this.ttsHealthy) {
        this.logger.warn('TTS service not responding, speech playback may fail');
      }

      // Health check Whisper
      if (this.whisperClient) {
        this.whisperHealthy = await this.whisperClient.healthCheck();
        if (!this.whisperHealthy) {
          this.logger.warn('Whisper service not responding, transcription may fail');
        }
      }
      
      // Start continuous audio stream ONCE
      this.audioStream = this.audioCapture.capture();
      this.logger.info('Audio stream started');
      
      this.logger.info('Voice orchestrator started');
      
      // Run 4 parallel tasks:
      // 1. Audio buffer task (continuously drains parecord to prevent blocking)
      // 2. Continuous capture/transcribe/queue
      // 3. Message sender (drains queue to gateway)
      // 4. TTS player (plays queued responses)
      await Promise.all([
        this.audioBufferTask(),
        this.continuousCaptureLoop(),
        this.backgroundMessageSender(),
        this.backgroundTTSPlayer(),
      ]);
      
    } catch (error) {
      this.logger.error('Fatal error in orchestrator:', error);
      this.setStateChange('error');
    } finally {
      this.cleanup();
    }
  }
  
  /**
   * Stop the orchestrator gracefully
   */
  stop(): void {
    this.shouldExit = true;
    this.isRunning = false;
  }

  setCaptureEnabled(enabled: boolean): void {
    if (this.captureEnabled === enabled) {
      return;
    }
    this.captureEnabled = enabled;
    if (!enabled) {
      const clearedFrames = this.audioBuffer.length;
      this.audioBuffer = [];
      this.logger.info(`[CONTROL] Capture disabled (cleared ${clearedFrames} frames)`);
      this.setStateChange('idle');
      return;
    }
    this.logger.info('[CONTROL] Capture enabled');
  }

  setAwakeState(awake: boolean): void {
    if (this.isAwake === awake) {
      return;
    }
    this.isAwake = awake;
    this.lastActivityTime = Date.now();
    if (!awake) {
      this.logger.info('[CONTROL] Sleep requested');
      this.ttsQueue = [];
      if (this.ttsClient.isSpeaking()) {
        this.ttsClient.stopPlayback();
      }
    } else {
      this.logger.info('[CONTROL] Wake requested');
    }
  }

  getStatus(): Record<string, unknown> {
    return {
      isRunning: this.isRunning,
      captureEnabled: this.captureEnabled,
      isAwake: this.isAwake,
      currentState: this.currentState,
      ttsSpeaking: this.ttsClient.isSpeaking(),
      ttsQueueSize: this.ttsQueue.length,
      messageQueueSize: this.messageQueue.length,
      lastActivityTime: this.lastActivityTime,
      lastTtsActivityTime: this.lastTtsActivityTime,
      models: {
        piperVoiceId: this.config.piperVoiceId,
        whisperModel: this.config.whisperModel,
        whisperLanguage: this.config.whisperLanguage,
      },
      readiness: {
        ttsHealthy: this.ttsHealthy,
        whisperHealthy: this.whisperHealthy,
      },
      wakeWord: this.config.wakeWord,
      wakeWordTimeout: this.config.wakeWordTimeout,
      sleepPhrase: this.config.sleepPhrase,
    };
  }
  
  /**
   * Audio buffer task - continuously drains audio stream to prevent parecord blocking
   * This is critical: parecord will crash with "Broken pipe" if we don't consume frames fast enough
   */
  private async audioBufferTask(): Promise<void> {
    this.logger.info('Starting audio buffer task');
    let frameCount = 0;
    let droppedFrames = 0;
    let lastLogTime = Date.now();
    let lastFrameCount = 0;
    
    while (this.isRunning && !this.shouldExit) {
      try {
        if (!this.audioStream) {
          await new Promise(resolve => setTimeout(resolve, 100));
          continue;
        }
        
        for await (const frame of this.audioStream) {
          if (this.shouldExit) {
            break;
          }

          if (!this.captureEnabled) {
            frameCount++;
            continue;
          }
          
          frameCount++;
          
          // Add to circular buffer
          while (this.bufferLock) {
            await new Promise(resolve => setTimeout(resolve, 1));
          }
          
          this.audioBuffer.push(frame);
          
          // Trim buffer if too large (keep most recent frames)
          if (this.audioBuffer.length > this.maxBufferFrames) {
            this.audioBuffer.shift();
            droppedFrames++;
          }
          
          // Log stats periodically
          if (Date.now() - lastLogTime > 10000) {
            const framesThisInterval = frameCount - lastFrameCount;
            const isTTSPlaying = this.currentState === 'speaking';
            this.logger.info(`[BUFFER] ${frameCount} total frames captured (${framesThisInterval}/10s), buffer size: ${this.audioBuffer.length}/${this.maxBufferFrames}, dropped: ${droppedFrames}, TTS playing: ${isTTSPlaying}`);
            lastLogTime = Date.now();
            lastFrameCount = frameCount;
          }
        }
        
        // Stream ended, try to restart
        if (!this.shouldExit && !this.config.audioInputFile) {
          this.logger.warn('Audio stream ended in buffer task, restarting...');
          this.audioStream = this.audioCapture.capture();
          this.logger.info('Audio stream restarted');
        }
        
      } catch (error) {
        this.logger.error('Error in audio buffer task:', error);
        
        if (!this.shouldExit && !this.config.audioInputFile) {
          await new Promise(resolve => setTimeout(resolve, 1000));
          try {
            this.audioStream = this.audioCapture.capture();
            this.logger.info('Audio stream restarted after error');
          } catch (restartError) {
            this.logger.error('Failed to restart audio stream:', restartError);
          }
        }
      }
    }
  }
  
  /**
   * Continuous capture loop - never blocks on gateway responses
   * Captures speech, transcribes, and queues messages
   */
  private async continuousCaptureLoop(): Promise<void> {
    this.logger.info('Starting continuous capture loop');
    
    while (this.isRunning && !this.shouldExit) {
      try {
        if (!this.captureEnabled) {
          await new Promise(resolve => setTimeout(resolve, 200));
          continue;
        }
        // Skip capture while TTS is playing
        if (this.currentState === 'speaking') {
          await new Promise(resolve => setTimeout(resolve, 50));
          continue;
        }
        
        // STATE: LISTENING - Capture speech from microphone
        this.setStateChange('listening');
        this.vad.reset();

        const capturedAudio = await this.captureSpeechAudio();
        if (!capturedAudio || capturedAudio.length === 0) {
          continue;
        }

        const transcribedText = await this.transcribeCapturedAudio(capturedAudio);
        
        if (!transcribedText.trim()) {
          continue; // Try again if nothing was said
        }
        
        // Queue message for sending (non-blocking)
        this.logger.info(`[CAPTURE] User said: "${transcribedText.substring(0, 100)}..." (TTS queue: ${this.ttsQueue.length})`);
        this.messageQueue.push(transcribedText);
        
        // Update last activity timestamp
        this.lastActivityTime = Date.now();
        
      } catch (error) {
        this.logger.error('Error in capture loop:', error);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }
  
  /**
   * Background message sender - drains message queue to gateway
   */
  private async backgroundMessageSender(): Promise<void> {
    this.logger.info('Starting background message sender');
    
    while (this.isRunning && !this.shouldExit) {
      try {
        // Check wake word timeout if configured
        if (this.config.wakeWordTimeout && this.isAwake && this.hasWakeWordConfigured()) {
          // Prevent timeout from firing while TTS is generating or speaking
          if (this.currentState === 'speaking' || this.ttsClient.isSpeaking()) {
            await new Promise(resolve => setTimeout(resolve, 50));
            continue;
          }
          const baseTime = this.lastTtsActivityTime || this.lastActivityTime;
          const timeSinceActivity = Date.now() - baseTime;
          if (timeSinceActivity > this.config.wakeWordTimeout) {
            this.isAwake = false;
            this.logger.info(`Wake word timeout: ${timeSinceActivity}ms since last activity. Going to sleep.`);
            
            // Stop any current TTS playback
            if (this.ttsClient.isSpeaking()) {
              this.logger.info('Stopping TTS playback due to timeout');
              this.ttsClient.stopPlayback();
            }
            
            // Clear TTS queue
            this.ttsQueue = [];
          }
        }
        
        if (this.messageQueue.length > 0) {
          const message = this.messageQueue.shift();
          if (message) {
            // Check for sleep phrase
            if (this.shouldGoToSleep(message)) {
              this.isAwake = false;
              this.logger.info('Sleep phrase detected. Going to sleep.');
              
              // Stop any current TTS playback
              if (this.ttsClient.isSpeaking()) {
                this.logger.info('Stopping TTS playback due to sleep phrase');
                this.ttsClient.stopPlayback();
              }
              
              // Clear TTS queue so nothing plays after sleep
              this.ttsQueue = [];
              
              continue; // Don't send this message
            }
            
            // Check if system is asleep
            if (!this.isAwake) {
              // If wake word is configured, check for it
              if (this.hasWakeWordConfigured()) {
                if (this.containsWakeWord(message)) {
                  this.isAwake = true;
                  this.lastActivityTime = Date.now();
                  this.logger.info('Wake word detected. Waking up.');
                  
                  // Play wake word click sound (non-blocking)
                  this.ttsClient.playAudio(this.wakeClickSound).catch((err) => {
                    this.logger.debug('Failed to play wake click sound:', err);
                  });
                  
                  // Send the message that contains wake word
                } else {
                  this.logger.debug('Skipping message - system is asleep and no wake word detected');
                  continue; // Don't send, waiting for wake word
                }
              } else {
                // No wake word configured, system stays asleep - skip message
                this.logger.debug('Skipping message - system is asleep (no wake word configured)');
                continue;
              }
            }
            
            // STATE: SENDING
            this.setStateChange('sending');
            this.logger.info(`[GATEWAY-SEND] Sending message: "${message.substring(0, 100)}..."`);
            await this.gatewayClient.sendMessage(message);
            this.lastActivityTime = Date.now();
          }
        }
        
        // Small delay to avoid CPU spinning
        await new Promise(resolve => setTimeout(resolve, 50));
        
      } catch (error) {
        this.logger.error('Error sending message:', error);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }
  
  /**
   * Background TTS player - plays queued responses
   */
  private async backgroundTTSPlayer(): Promise<void> {
    this.logger.info('Starting background TTS player');
    
    while (this.isRunning && !this.shouldExit) {
      try {
        if (this.ttsQueue.length > 0) {
          const directive = this.ttsQueue.shift();
          if (directive) {
            // CRITICAL: Clear buffer BEFORE starting TTS to prevent processing accumulated audio
            const prePlayBufferSize = this.audioBuffer.length;
            this.audioBuffer = [];
            this.logger.info(`[TTS-START] Cleared ${prePlayBufferSize} buffered frames before TTS`);
            this.logger.info(`[TTS-START] Playing: "${directive.text.substring(0, 80)}..."`);
            
            // STATE: SPEAKING
            this.setStateChange('speaking');
            const wasCutIn = await this.playWithCutIn(directive);
            
            if (wasCutIn) {
              // Cut-in detected - user interrupted TTS
              this.logger.info('[CUT-IN] Handling cut-in interruption');
              
              // Skip echo wait - user is already speaking
              // Keep a short pre-roll so we can capture the user's cut-in speech
              const cutInPreRollMs = this.config.preRollMs ?? 300;
              const lastFrame = this.audioBuffer[this.audioBuffer.length - 1];
              const frameMs = lastFrame ? this.frameDurationMs(lastFrame) : 20;
              const keepFrames = Math.max(1, Math.floor(cutInPreRollMs / frameMs));
              const preTrimSize = this.audioBuffer.length;
              if (preTrimSize > keepFrames) {
                this.audioBuffer = this.audioBuffer.slice(preTrimSize - keepFrames);
              }
              this.logger.info(`[CUT-IN] Preserved ${this.audioBuffer.length}/${preTrimSize} frames (~${cutInPreRollMs}ms) for cut-in capture`);
              
              // Start wake timeout from TTS cancellation
              this.lastActivityTime = Date.now();
              this.lastTtsActivityTime = this.lastActivityTime;

              // State back to listening - user speech will be captured
              this.setStateChange('listening');
              
            } else {
              // Normal completion - wait for echo to clear
              this.logger.info(`[TTS-END] Playback completed, waiting for audio echo to clear...`);
              
              // Wait a moment for TTS audio to fully clear from the microphone
              await new Promise(resolve => setTimeout(resolve, 500));
              
              // Clear audio buffer again to remove any TTS echo or concurrent audio capture
              const postPlayBufferSize = this.audioBuffer.length;
              this.audioBuffer = [];
              this.logger.info(`[TTS-END] Cleared ${postPlayBufferSize} frames captured during TTS`);

              // Start wake timeout from TTS completion
              this.lastActivityTime = Date.now();
              this.lastTtsActivityTime = this.lastActivityTime;
              
              // Return to listening state after TTS finishes
              this.setStateChange('listening');
            }
          }
        }
        
        // Small delay to avoid CPU spinning
        await new Promise(resolve => setTimeout(resolve, 50));
        
      } catch (error) {
        this.logger.error('[TTS-ERROR]', error);
        // Clear buffer and return to listening on error
        const errorBufferSize = this.audioBuffer.length;
        this.audioBuffer = [];
        this.logger.warn(`[TTS-ERROR] Cleared ${errorBufferSize} frames on error`);
        // Start wake timeout from TTS failure
        this.lastActivityTime = Date.now();
        this.lastTtsActivityTime = this.lastActivityTime;
        this.setStateChange('listening');
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }
  
  
  /**
   * Parse TTS directives from response text
   * Simple implementation - just speak the whole response
   */
  private parseTTSDirectives(text: string): TTSDirective[] {
    if (!text.trim()) {
      return [];
    }
    
    // Sanitize text: remove markdown, HTML, and non-speakable characters
    let cleanText = text
      // Remove markdown bold, italic, strikethrough, code formatting
      .replace(/\*\*([^\*]+)\*\*/g, '$1')  // **bold** → bold
      .replace(/__([^_]+)__/g, '$1')       // __italic__ → italic
      .replace(/\*([^\*]+)\*/g, '$1')      // *italic* → italic
      .replace(/_([^_]+)_/g, '$1')         // _italic_ → italic
      .replace(/~~([^~]+)~~/g, '$1')       // ~~strikethrough~~ → strikethrough
      .replace(/`([^`]+)`/g, '$1')         // `code` → code
      // Remove HTML tags
      .replace(/<[^>]+>/g, '')
      // Remove other markdown
      .replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1')  // [link](url) → link
      // Clean up extra spaces
      .trim();
    
    return [{
      text: cleanText,
      voiceId: undefined,
      rate: undefined,
      stability: undefined,
    }];
  }
  
  /**
   * Play audio with cut-in support
   * Returns true if cut-in was detected, false if playback completed normally
   */
  private async playWithCutIn(directive: TTSDirective): Promise<boolean> {
    let cutInDetected = false;
    const playStartHR = process.hrtime.bigint();
    try {
      // Synthesize audio
      const synStartHR = process.hrtime.bigint();
      const audioBuffer = await this.ttsClient.synthesize(
        directive.text,
        directive.voiceId,
        directive.rate,
        directive.stability
      );
      const synDurationMS = Number(process.hrtime.bigint() - synStartHR) / 1_000_000;
      this.logger.info(`[CUT-IN-LATENCY] Synthesis took ${synDurationMS.toFixed(2)}ms for ${audioBuffer.length} bytes`);
      
      this.logger.info(`[CUT-IN] Starting TTS playback (${audioBuffer.length} bytes)`);
      
      // Start playback in background
      const playbackPromise = this.ttsClient.playAudio(audioBuffer);

      // In file-input test mode, skip cut-in detection
      if (this.config.audioInputFile) {
        await playbackPromise;
        return false;
      }
      
      // Monitor for cut-in while playing
      const monitorStartHR = process.hrtime.bigint();
      const cutInPromise = this.monitorForCutIn();
      
      // Whichever finishes first wins
      const raceStartHR = process.hrtime.bigint();
      const winner = await Promise.race([
        playbackPromise.then(() => 'playback'),
        cutInPromise.then(() => 'cutin')
      ]);
      const raceDurationMicros = Number(process.hrtime.bigint() - raceStartHR) / 1000;
      
      // If cut-in detected, stop playback IMMEDIATELY
      if (winner === 'cutin') {
        const stopStartHR = process.hrtime.bigint();
        cutInDetected = true;
        this.logger.info(`[CUT-IN-LATENCY] Race finished at ${(raceDurationMicros/1000).toFixed(2)}ms: CUTIN WON`);
        this.logger.info('[CUT-IN] ⚡ Speech detected - stopping TTS immediately');
        if (this.ttsClient.isSpeaking()) {
          this.ttsClient.stopPlayback(stopStartHR); // Pass timing reference
        }
      } else {
        this.logger.info(`[CUT-IN-LATENCY] Race finished at ${(raceDurationMicros/1000).toFixed(2)}ms: PLAYBACK WON`);
        this.logger.info('[TTS] ✓ Playback completed normally');
      }
      
    } catch (error) {
      this.logger.error('Error in playback/cut-in:', error);
    }
    
    return cutInDetected;
  }
  
  /**
   * Monitor for speech during playback (cut-in detection)
   * Uses direct RMS threshold instead of VAD state machine for immediate response
   * Tracks detailed latency at each step
   */
  private async monitorForCutIn(): Promise<void> {
    const cutInRmsThreshold = this.config.cutInAbsoluteRms ?? this.config.vadAbsoluteRms ?? 0.002;
    const minFramesAboveThreshold = Math.max(1, Math.floor((this.config.cutInMinSpeechMs ?? 50) / 20)); // ~50ms = 2-3 frames at 20ms
    const monitorStartTime = Date.now();
    const monitorStartHR = process.hrtime.bigint();
    
    this.logger.info(`[CUT-IN] Starting cut-in monitor with RMS threshold=${cutInRmsThreshold.toFixed(6)}, min speech=${minFramesAboveThreshold} frames`);
    
    let lastBufferIndex = this.audioBuffer.length;
    let framesAboveThreshold = 0;
    let frameCount = 0;
    let firstHighRmsTime = 0n; // High-resolution time of first high-RMS frame
    
    // Monitor audio buffer for cut-in instead of creating new stream
    while (this.isRunning && !this.shouldExit) {
      // Wait for new frames in buffer
      if (lastBufferIndex >= this.audioBuffer.length) {
        await new Promise(resolve => setTimeout(resolve, 5)); // More responsive monitoring
        continue;
      }
      
      // Process new frames with simple RMS threshold
      while (lastBufferIndex < this.audioBuffer.length) {
        const frameCheckTimeHR = process.hrtime.bigint();
        const frame = this.audioBuffer[lastBufferIndex];
        lastBufferIndex++;
        frameCount++;
        
        if (!frame) {
          framesAboveThreshold = 0;
          continue;
        }
        
        // Calculate RMS of frame
        const rmsCalcStartHR = process.hrtime.bigint();
        const rms = this.calculateRms(frame);
        const rmsCalcDurationMicros = Number(process.hrtime.bigint() - rmsCalcStartHR) / 1000;
        
        // Direct RMS threshold check - no VAD state needed
        if (rms >= cutInRmsThreshold) {
          if (framesAboveThreshold === 0) {
            // First high-RMS frame detected
            firstHighRmsTime = frameCheckTimeHR;
            this.logger.info(`[CUT-IN-LATENCY] ⚡ First high-RMS detected: RMS=${rms.toFixed(6)} (threshold=${cutInRmsThreshold.toFixed(6)}) at frame ${frameCount} (${rmsCalcDurationMicros.toFixed(2)}µs to calc)`);
          }
          framesAboveThreshold++;
          
          // If we have enough consecutive high-RMS frames, it's definitely speech
          if (framesAboveThreshold >= minFramesAboveThreshold) {
            const decisionTimeHR = process.hrtime.bigint();
            const timeSinceFirstHighRms = Number(decisionTimeHR - firstHighRmsTime) / 1000; // micros
            const timeSinceMonitorStart = Number(decisionTimeHR - monitorStartHR) / 1000; // micros
            this.logger.info(`[CUT-IN-LATENCY] ✂️  Cut-in decision triggered: accumulated ${framesAboveThreshold} high-RMS frames, time from 1st high-RMS=${timeSinceFirstHighRms.toFixed(2)}µs, total monitor time=${timeSinceMonitorStart.toFixed(2)}µs (${(timeSinceMonitorStart/1000).toFixed(2)}ms)`);
            return;
          }
        } else {
          if (framesAboveThreshold > 0) {
            this.logger.info(`[CUT-IN-LATENCY] ↓ Low-RMS detected: RMS=${rms.toFixed(6)}, resetting counter (had ${framesAboveThreshold} high-RMS frames)`);
          }
          // Reset counter if we drop below threshold
          framesAboveThreshold = 0;
        }
      }
      
      // Small delay between checks
      await new Promise(resolve => setTimeout(resolve, 5)); // More responsive
    }
  }
  
  /**
   * Log state changes
   */
  private setStateChange(newState: VoiceState): void {
    if (newState !== this.currentState) {
      this.logger.info(`State: ${this.currentState} → ${newState}`);
      this.currentState = newState;
    }
  }

  private hasWakeWordConfigured(): boolean {
    if (!this.config.wakeWord) {
      return false;
    }
    if (Array.isArray(this.config.wakeWord)) {
      return this.config.wakeWord.some(word => word.trim().length > 0);
    }
    return this.config.wakeWord.trim().length > 0;
  }

  private async captureSpeechAudio(): Promise<Buffer | null> {
    const maxListenMs = this.config.maxListenMs ?? 10000;
    const preRollMs = this.config.preRollMs ?? 300;
    const frames: Buffer[] = [];
    const preRoll: Buffer[] = [];
    let hasStartedSpeech = false;
    const startTime = Date.now();
    let lastVadLog = 0;
    let frameCount = 0;

    // File input mode: read entire buffer once
    if (this.config.audioInputFile && this.audioBuffer.length > 0) {
      return Buffer.concat(this.audioBuffer);
    }

    try {
      // Read from circular buffer
      while (this.isRunning && !this.shouldExit) {
        // CRITICAL: Exit immediately if state changes to 'speaking' to allow TTS cut-in detection
        if (this.currentState !== 'idle' && this.currentState !== 'listening' && this.currentState !== 'sending') {
          this.logger.debug('[CAPTURE] Exiting captureSpeechAudio - state changed to ' + this.currentState);
          return null;
        }
        
        // Wait for frames to be available in buffer
        while (this.audioBuffer.length === 0) {
          if (this.shouldExit) {
            break;
          }
          // Check state again while waiting
          if (this.currentState !== 'idle' && this.currentState !== 'listening' && this.currentState !== 'sending') {
            this.logger.debug('[CAPTURE] Exiting frame wait - state changed during wait');
            return null;
          }
          await new Promise(resolve => setTimeout(resolve, 10));
          
          // Check timeout
          if (!hasStartedSpeech && Date.now() - startTime > maxListenMs) {
            return null;
          }
        }
        
        if (this.shouldExit) {
          break;
        }
        
        // Get and remove frame from buffer (FIFO queue)
        const frame = this.audioBuffer.shift();
        if (!frame) {
          continue;
        }
        frameCount++;

        const hasSpeech = this.vad.analyze(frame);
        if (this.config.vadDebug && Date.now() - lastVadLog > 1000) {
          lastVadLog = Date.now();
          const rms = this.calculateRms(frame).toFixed(6);
          const state = this.vad.getState();
          this.logger.info(
            `VAD debug: rms=${rms} nf=${state.noiseFloor} thr=${state.threshold} speaking=${hasSpeech} buf=${this.audioBuffer.length}`
          );
        }
        
        preRoll.push(frame);

        const maxPreRollFrames = Math.max(1, Math.floor(preRollMs / this.frameDurationMs(frame)));
        while (preRoll.length > maxPreRollFrames) {
          preRoll.shift();
        }

        if (!hasStartedSpeech && hasSpeech) {
          hasStartedSpeech = true;
          frames.push(...preRoll);
          this.logger.debug(`Speech started, captured ${preRoll.length} pre-roll frames`);
        }

        if (hasStartedSpeech) {
          frames.push(frame);
          if (this.vad.isSilenceFinalized()) {
            this.logger.debug(`Silence finalized after ${frameCount} frames, ending capture`);
            break;
          }
        }

        // Don't time out if we've already started capturing speech
        if (!hasStartedSpeech && Date.now() - startTime > maxListenMs) {
          return null;
        }
      }
      
    } catch (error) {
      this.logger.error('Error in audio capture from buffer:', error);
      return null;
    }

    if (this.config.audioInputFile && !this.config.audioInputLoop) {
      this.shouldExit = true;
    }

    return frames.length > 0 ? Buffer.concat(frames) : null;
  }

  private frameDurationMs(frame: Buffer): number {
    const samples = frame.length / 2;
    return (samples / this.audioCapture.getSampleRate()) * 1000;
  }

  private calculateRms(frame: Buffer): number {
    let sum = 0;
    const samples = frame.length / 2;
    for (let i = 0; i < frame.length; i += 2) {
      const sample = frame.readInt16LE(i);
      sum += sample * sample;
    }
    const mean = sum / samples;
    return Math.sqrt(mean) / 32768;
  }

  private async transcribeCapturedAudio(capturedAudio: Buffer): Promise<string> {
    if (!this.whisperClient) {
      this.logger.warn('Whisper client not configured; skipping transcription');
      return '';
    }

    const wavBuffer = encodeWav(capturedAudio, this.audioCapture.getSampleRate());

    try {
      const startTime = Date.now();
      const result = await this.whisperClient.transcribe(wavBuffer, this.config.whisperLanguage);
      const latencyMs = Date.now() - startTime;
      this.logger.info(`STT latency: ${latencyMs}ms`);
      return result;
    } catch (error) {
      this.logger.error('Whisper transcription failed:', error);
      return '';
    }
  }
  
  /**
   * Get current state
   */
  getState(): VoiceState {
    return this.currentState;
  }
  
  /**
   * Check if transcript contains wake word (case-insensitive partial match)
   */
  private containsWakeWord(text: string): boolean {
    const wakeWordConfig = this.config.wakeWord;
    if (!this.hasWakeWordConfigured() || !wakeWordConfig) {
      return false;
    }
    const normalize = (value: string): string => value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const normalizedText = normalize(text);
    const wakeWords = Array.isArray(wakeWordConfig)
      ? wakeWordConfig
      : [wakeWordConfig];
    return wakeWords
      .map(word => normalize(word))
      .filter(word => word.length > 0)
      .some(word => normalizedText.includes(word));
  }
  
  /**
   * Check if transcript matches sleep phrase using fuzzy matching
   * Matches variations like "go to sleep", "going to sleep", "go sleep", etc.
   */
  private shouldGoToSleep(text: string): boolean {
    if (!this.config.sleepPhrase || !this.hasWakeWordConfigured()) {
      return false;
    }
    
    const normalizedText = text.toLowerCase().trim();
    const normalizedSleepPhrase = this.config.sleepPhrase.toLowerCase().trim();
    
    // Direct match
    if (normalizedText.includes(normalizedSleepPhrase)) {
      return true;
    }
    
    // Fuzzy match for common variations
    const sleepPatterns = [
      /\b(go|going)\s+(to\s+)?sleep\b/,
      /\bsleep\s+(now|please)\b/,
      /\bshut\s+down\b/,
      /\bstop\s+listening\b/,
      /\bturn\s+off\b/,
    ];
    
    return sleepPatterns.some(pattern => pattern.test(normalizedText));
  }
  
  /**
   * Cleanup resources
   */
  private cleanup(): void {
    this.logger.info('Cleaning up resources');
    
    // Clear gateway text buffer timeout
    if (this.gatewayFlushTimeout) {
      clearTimeout(this.gatewayFlushTimeout);
      this.gatewayFlushTimeout = null;
    }
    
    this.audioCapture.stop();
    this.ttsClient.stopPlayback();
    this.gatewayClient.disconnect();
  }
}
