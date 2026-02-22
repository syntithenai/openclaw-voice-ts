import { AudioCapture } from '../audio/capture';
import { VoiceActivityDetector } from '../audio/vad';
import { EchoCanceller, EchoCancellationConfig } from '../audio/echo-cancel';
import { encodeWav } from '../audio/wav';
import { generateClickSound } from '../audio/sounds';
import { GatewayWSClient } from '../gateway/ws-client';
import { ResponseParser, TTSDirective } from '../gateway/parser';
import { WhisperClient } from '../stt/whisper';
import { OpenWakeWordClient } from '../stt/openwakeword';
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
  cutInTtsAbsoluteRms?: number;
  cutInTtsMinSpeechMs?: number;
  postTtsListenMs?: number;
  ttsDedupeWindowMs?: number;
  wakeWord?: string | string[];
  wakeWordTimeout?: number;
  wakeWordEngine?: 'whisper' | 'openwakeword';
  openWakeWordUrl?: string;
  openWakeWordConfidenceThreshold?: number;
  openWakeWordDebug?: boolean;
  sleepPhrase?: string;
  audioInputFile?: string;
  audioInputLoop?: boolean;
  echoCancel?: boolean;
  echoCancelAttenuation?: number;
  echoCancelTailLength?: number;
  echoCancelRecalibrateInterval?: number;
  echoCancelMinCorrelation?: number;
}

interface BufferedFrame {
  idx: number;
  data: Buffer;
}

export class VoiceOrchestrator {
  private currentState: VoiceState = 'idle';
  private logger: Logger;
  private audioCapture: AudioCapture;
  private vad: VoiceActivityDetector;
  private echoCanceller: EchoCanceller;
  private gatewayClient: GatewayWSClient;
  private whisperClient: WhisperClient | null = null;
  private openWakeWordClient: OpenWakeWordClient | null = null;
  private wakeWordEngine: 'whisper' | 'openwakeword' = 'whisper';
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
  private audioBuffer: BufferedFrame[] = [];
  private readonly maxBufferFrames: number = 300; // ~6 seconds at 20ms frames
  private bufferLock: boolean = false;
  private bufferSeq: number = 0;
  private captureCursor: number = 0;
  private cutInCursor: number = 0;
  
  // Pre-roll buffer: keeps recent frames to bridge gaps between utterances
  // This ensures contiguity between successive Whisper transcriptions
  // and prevents audio loss during OpenWakeWord detection latency
  private preRollBuffer: Buffer[] = [];
  private readonly maxPreRollFrames: number = 100; // ~2 seconds of pre-context
  
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
    
    // Initialize echo cancellation
    const aecConfig: EchoCancellationConfig = {
      enabled: config.echoCancel ?? false,
      sampleRate: config.sampleRate || 48000,
      frameSize: 1024,
      tailLength: config.echoCancelTailLength ?? 150,
      attenuation: config.echoCancelAttenuation ?? 0.7,
      recalibrateInterval: config.echoCancelRecalibrateInterval ?? 0,
      minCorrelation: config.echoCancelMinCorrelation ?? 0.3,
    };
    console.error(`[ORCHESTRATOR-DEBUG] ECHO config: raw=${config.echoCancel}, aecEnabled=${aecConfig.enabled}, attenuation=${aecConfig.attenuation}`);
    this.echoCanceller = new EchoCanceller(aecConfig);
    console.error(`[ORCHESTRATOR-DEBUG] EchoCanceller created successfully`);
    
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
    
    // Initialize wake word engine
    this.wakeWordEngine = config.wakeWordEngine || 'whisper';
    
    if (this.wakeWordEngine === 'openwakeword' && config.openWakeWordUrl) {
      // Use openWakeWord for fast audio-based detection
      this.openWakeWordClient = new OpenWakeWordClient({
        url: config.openWakeWordUrl,
        confidenceThreshold: config.openWakeWordConfidenceThreshold,
        debug: config.openWakeWordDebug,
      });
      this.logger.info(`[INIT] Using openWakeWord for fast wake word detection (${config.openWakeWordUrl})`);
    } else if (config.whisperUrl) {
      // Fallback to Whisper (text-based detection)
      this.whisperClient = new WhisperClient(config.whisperUrl);
      this.logger.info(`[INIT] Using Whisper for wake word detection`);
    }

    this.ttsClient = new TTSClient(
      config.piperUrl || 'http://piper:5002',
      config.piperVoiceId || 'en_US-amy-medium',
      config.audioPlaybackDevice
    );
    
    // Set up echo cancellation playback callback
    this.ttsClient.setPlaybackCallback((buffer: Buffer) => {
      this.echoCanceller.addPlaybackAudio(buffer);
    });
    
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
      this.captureCursor = this.bufferSeq;
      this.cutInCursor = this.bufferSeq;
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
          
          // Apply echo cancellation before processing
          const timestamp = Date.now();
          const processedFrame = this.echoCanceller.processFrame(frame, timestamp);
          
          // Add to circular buffer
          while (this.bufferLock) {
            await new Promise(resolve => setTimeout(resolve, 1));
          }
          
          const bufferedFrame: BufferedFrame = {
            idx: this.bufferSeq++,
            data: processedFrame,
          };
          this.audioBuffer.push(bufferedFrame);
          
          // Also maintain pre-roll buffer for continuity across utterances
          // This bridges pauses between wake word and command, and handles OpenWakeWord detection latency
          this.preRollBuffer.push(processedFrame);
          if (this.preRollBuffer.length > this.maxPreRollFrames) {
            this.preRollBuffer.shift();
          }
          
          // Trim buffer if too large (keep most recent frames)
          if (this.audioBuffer.length > this.maxBufferFrames) {
            const dropped = this.audioBuffer.shift();
            if (dropped) {
              if (this.captureCursor <= dropped.idx) {
                this.captureCursor = dropped.idx + 1;
              }
              if (this.cutInCursor <= dropped.idx) {
                this.cutInCursor = dropped.idx + 1;
              }
            }
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
   * After wake word detection, waits up to 2 seconds for a command
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

        // If using OpenWakeWord and system is asleep, do NOT transcribe.
        // Only wake when audio-based wake word is detected.
        if (!this.isAwake && this.wakeWordEngine === 'openwakeword') {
          const preRollAudio = this.preRollBuffer.length > 0
            ? Buffer.concat(this.preRollBuffer)
            : undefined;
          if (preRollAudio && await this.detectWakeWordWithEngine('', preRollAudio)) {
            this.isAwake = true;
            this.lastActivityTime = Date.now();
            this.logger.info('Wake word detected (openWakeWord). Waking up.');
            this.ttsClient.playAudio(this.wakeClickSound).catch((err) => {
              this.logger.debug('Failed to play wake click sound:', err);
            });
          } else {
            await new Promise(resolve => setTimeout(resolve, 50));
          }
          continue;
        }

        this.vad.reset();

        // After wake word is detected and sent, wait longer for the actual command
        // Default maxListenMs (10s) applies to normal listening
        // Extended timeout (5s) applies after wake word to allow command pause
        let maxListenMs = !this.isAwake ? (this.config.maxListenMs ?? 10000) : 5000;
        const postTtsListenMs = this.config.postTtsListenMs ?? 0;
        if (postTtsListenMs > 0 && this.lastTtsActivityTime > 0) {
          const timeSinceTts = Date.now() - this.lastTtsActivityTime;
          if (timeSinceTts >= 0 && timeSinceTts < postTtsListenMs) {
            const remainingMs = postTtsListenMs - timeSinceTts;
            if (remainingMs > maxListenMs) {
              maxListenMs = remainingMs;
            }
          }
        }
        this.logger.debug(`[CAPTURE] Starting capture with maxListenMs=${maxListenMs}ms (isAwake=${this.isAwake})`);
        const capturedAudio = await this.captureSpeechAudio(maxListenMs);
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
        // Check wake word timeout if configured (only when not actively doing TTS/speaking)
        if (this.config.wakeWordTimeout && this.isAwake && this.hasWakeWordConfigured()) {
          // Only apply timeout when truly idle - not during TTS synthesis or playback
          if (!this.ttsClient.isSpeaking() && this.currentState !== 'speaking') {
            const timeSinceActivity = Date.now() - this.lastActivityTime;
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
                  
                  // Strip wake word from transcript and use remaining text as message
                  let processedMessage = this.stripWakeWord(message);
                  if (!processedMessage.trim()) {
                    this.logger.debug('Wake word detected but no command text after stripping');
                    continue; // Just the wake word, no command
                  }
                  
                  // STATE: SENDING
                  this.setStateChange('sending');
                  this.logger.info(`[GATEWAY-SEND] Sending message: "${processedMessage.substring(0, 100)}..."`);
                  await this.gatewayClient.sendMessage(processedMessage);
                  this.lastActivityTime = Date.now();
                  continue;
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
            
            // Skip empty messages
            if (!message.trim()) {
              this.logger.debug('Skipping empty message');
              continue;
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
            // NOTE: Do not clear the audio buffer here to avoid losing user speech
            // during or immediately after TTS playback. We keep continuity and rely
            // on VAD/cut-in handling to segment speech.
            const prePlayBufferSize = this.audioBuffer.length;
            this.logger.info(`[TTS-START] Buffer size before TTS: ${prePlayBufferSize} frames`);
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
              const frameMs = lastFrame ? this.frameDurationMs(lastFrame.data) : 20;
              const keepFrames = Math.max(1, Math.floor(cutInPreRollMs / frameMs));
              const preTrimSize = this.audioBuffer.length;
              this.logger.info(`[CUT-IN] Buffer size at cut-in: ${preTrimSize} frames (~${cutInPreRollMs}ms pre-roll available)`);
              
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
              
              // Do not clear buffer here to avoid losing user speech around TTS completion
              const postPlayBufferSize = this.audioBuffer.length;
              this.logger.info(`[TTS-END] Buffer size after TTS: ${postPlayBufferSize} frames`);

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
        // Do not clear buffer on error to avoid losing user speech
        const errorBufferSize = this.audioBuffer.length;
        this.logger.warn(`[TTS-ERROR] Buffer size on error: ${errorBufferSize} frames`);
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
    
    // Sanitize text: remove URLs, markdown, HTML, and non-speakable characters
    let cleanText = text
      // Remove URLs (don't speak links!) - both plain URLs and <url> format
      .replace(/https?:\/\/[^\s)>]+/g, '')  // Plain URLs like https://...
      .replace(/<https?:\/\/[^>]+>/g, '')     // <url> wrapped URLs
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
      .replace(/\s+/g, ' ')  // Multiple spaces → single space
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
    const monitorStartTime = Date.now();
    const monitorStartHR = process.hrtime.bigint();
    
    let lastCursor = this.cutInCursor;
    let framesAboveThreshold = 0;
    let frameCount = 0;
    let firstHighRmsTime = 0n; // High-resolution time of first high-RMS frame
    let lastTtsState = false;
    let currentThreshold = this.config.cutInAbsoluteRms ?? this.config.vadAbsoluteRms ?? 0.002;
    let currentMinSpeechMs = this.config.cutInMinSpeechMs ?? 50;
    
    // Monitor audio buffer for cut-in instead of creating new stream
    while (this.isRunning && !this.shouldExit) {
      // Check TTS state on every iteration (dynamic threshold switching)
      const ttsIsSpeaking = this.ttsClient.isSpeaking();
      const cutInRmsThreshold = ttsIsSpeaking
        ? (this.config.cutInTtsAbsoluteRms ?? this.config.cutInAbsoluteRms ?? this.config.vadAbsoluteRms ?? 0.002)
        : (this.config.cutInAbsoluteRms ?? this.config.vadAbsoluteRms ?? 0.002);
      const cutInMinSpeechMs = ttsIsSpeaking
        ? (this.config.cutInTtsMinSpeechMs ?? this.config.cutInMinSpeechMs ?? 50)
        : (this.config.cutInMinSpeechMs ?? 50);
      const minFramesAboveThreshold = Math.max(1, Math.floor(cutInMinSpeechMs / 20)); // ~20ms frames
      
      // Log when TTS state changes
      if (ttsIsSpeaking !== lastTtsState) {
        this.logger.info(`[CUT-IN] TTS state changed: ${lastTtsState ? 'playing' : 'idle'} → ${ttsIsSpeaking ? 'playing' : 'idle'}, switching threshold: ${currentThreshold.toFixed(6)} → ${cutInRmsThreshold.toFixed(6)}`);
        lastTtsState = ttsIsSpeaking;
        currentThreshold = cutInRmsThreshold;
        currentMinSpeechMs = cutInMinSpeechMs;
        // Reset detection when threshold changes
        framesAboveThreshold = 0;
        firstHighRmsTime = 0n;
      }
      
      const nextFrame = this.getNextBufferedFrame(lastCursor);
      if (!nextFrame) {
        await new Promise(resolve => setTimeout(resolve, 5)); // More responsive monitoring
        continue;
      }
      const frameCheckTimeHR = process.hrtime.bigint();
      const frame = nextFrame.data;
      lastCursor = nextFrame.idx + 1;
      this.cutInCursor = lastCursor;
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

  private async captureSpeechAudio(maxListenMs?: number): Promise<Buffer | null> {
    if (maxListenMs === undefined) {
      maxListenMs = this.config.maxListenMs ?? 10000;
    }
    const preRollMs = this.config.preRollMs ?? 300;
    const frames: Buffer[] = [];
    const preRoll: Buffer[] = [];
    let hasStartedSpeech = false;
    const startTime = Date.now();
    let lastVadLog = 0;
    let frameCount = 0;

    // File input mode: read entire buffer once
    if (this.config.audioInputFile && this.audioBuffer.length > 0) {
      return Buffer.concat(this.audioBuffer.map((frame) => frame.data));
    }

    try {
      // Start with pre-roll buffer to ensure audio continuity with previous capture
      // This bridges silence between utterances (Whisper) and handles OpenWakeWord detection latency
      frames.push(...this.preRollBuffer);
      if (this.preRollBuffer.length > 0) {
        this.logger.debug(`[PRE-ROLL] Starting capture with ${this.preRollBuffer.length} pre-roll frames (~${Math.round(this.preRollBuffer.length * 20)}ms)`);
      }
      
      // Read from circular buffer until speech detected and silence finalized
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
        
        // Get next frame from buffer using capture cursor (contiguous reads)
        const nextFrame = this.getNextBufferedFrame(this.captureCursor);
        if (!nextFrame) {
          await new Promise(resolve => setTimeout(resolve, 10));
          continue;
        }
        this.captureCursor = nextFrame.idx + 1;
        const frame = nextFrame.data;
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
          this.logger.debug(`Speech started, captured ${preRoll.length} intra-capture pre-roll frames`);
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

    if (frames.length > 0) {
      this.logger.debug(`[CAPTURE] Captured ${frames.length} total frames (with pre-roll bridge)`);
      return Buffer.concat(frames);
    }
    return null;
  }

  private frameDurationMs(frame: Buffer): number {
    const samples = frame.length / 2;
    return (samples / this.audioCapture.getSampleRate()) * 1000;
  }

  private getNextBufferedFrame(cursor: number): BufferedFrame | null {
    if (this.audioBuffer.length === 0) {
      return null;
    }
    // Buffer is ordered by idx; find first frame at/after cursor
    for (const frame of this.audioBuffer) {
      if (frame.idx >= cursor) {
        return frame;
      }
    }
    return null;
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
   * Strip wake word from transcript, returning the remaining text
   */
  private stripWakeWord(text: string): string {
    const wakeWordConfig = this.config.wakeWord;
    if (!this.hasWakeWordConfigured() || !wakeWordConfig) {
      return text;
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
    
    // Try exact match first (case/punctuation insensitive but substring exact)
    for (const wakeWord of wakeWords) {
      const normalized = normalize(wakeWord);
      if (normalized.length > 0) {
        const index = normalizedText.indexOf(normalized);
        if (index !== -1) {
          // Found at position, remove it from the original text
          // We need to map this back to the original text positions
          const beforeWakeWord = text.substring(0, text.toLowerCase().indexOf(wakeWord.toLowerCase()));
          const afterIndex = wakeWord.length;
          const remainderStart = text.toLowerCase().indexOf(wakeWord.toLowerCase()) + afterIndex;
          const afterWakeWord = text.substring(remainderStart);
          return (beforeWakeWord + afterWakeWord).trim();
        }
      }
    }
    
    // If no exact match found, return original text
    return text;
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
    
    // Get fuzzy match threshold from config or use default (0.75 = 75% similarity)
    const fuzzyThreshold = (this.config as any).wakeWordFuzzyThreshold ?? 0.75;
    
    // Try both exact substring match first (fast path)
    for (const wakeWord of wakeWords) {
      const normalized = normalize(wakeWord);
      if (normalized.length > 0 && normalizedText.includes(normalized)) {
        return true;
      }
    }
    
    // Then try fuzzy matching if no exact match found
    return wakeWords
      .map(word => normalize(word))
      .filter(word => word.length > 0)
      .some(wakeWord => {
        // Use fuzzy matching for partial matches within the text
        const words = normalizedText.split(' ');
        const wakeWords = wakeWord.split(' ');
        
        // Try matching wake word sequence at each position
        for (let i = 0; i <= words.length - wakeWords.length; i++) {
          const sequence = words.slice(i, i + wakeWords.length).join(' ');
          const similarity = this.calculateSimilarity(wakeWord, sequence);
          if (similarity >= fuzzyThreshold) {
            this.logger.debug(`[FUZZY-MATCH] "${sequence}" matched "${wakeWord}" (${(similarity * 100).toFixed(1)}%)`);
            return true;
          }
        }
        
        return false;
      });
  }

  /**
   * Calculate similarity between two strings using Levenshtein distance
   * Returns value between 0 and 1 (1 = identical, 0 = completely different)
   */
  private calculateSimilarity(str1: string, str2: string): number {
    const longer = str1.length > str2.length ? str1 : str2;
    const shorter = str1.length > str2.length ? str2 : str1;
    
    if (longer.length === 0) return 1.0;
    
    const editDistance = this.getLevenshteinDistance(longer, shorter);
    return (longer.length - editDistance) / longer.length;
  }

  /**
   * Calculate Levenshtein distance between two strings
   * (minimum number of single-character edits needed)
   */
  private getLevenshteinDistance(str1: string, str2: string): number {
    const costs: number[] = [];
    
    for (let i = 0; i <= str1.length; i++) {
      let lastValue = i;
      for (let j = 0; j <= str2.length; j++) {
        if (i === 0) {
          costs[j] = j;
        } else if (j > 0) {
          let newValue = costs[j - 1];
          if (str1.charAt(i - 1) !== str2.charAt(j - 1)) {
            newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
          }
          costs[j - 1] = lastValue;
          lastValue = newValue;
        }
      }
      if (i > 0) costs[str2.length] = lastValue;
    }
    
    return costs[str2.length];
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
   * Detect wake word using configured engine
   * Supports both openWakeWord (fast audio-based) and Whisper (text-based)
   */
  async detectWakeWordWithEngine(
    text: string,
    audioBuffer?: Buffer
  ): Promise<boolean> {
    if (!this.hasWakeWordConfigured()) {
      return false;
    }

    // Try openWakeWord first if available (fast audio-based detection)
    if (this.wakeWordEngine === 'openwakeword' && this.openWakeWordClient && audioBuffer) {
      try {
        const wakeWordConfig = this.config.wakeWord;
        const wakeWords = (Array.isArray(wakeWordConfig)
          ? wakeWordConfig
          : [wakeWordConfig]) as string[];

        const result = await this.openWakeWordClient.detectWakeWord(audioBuffer, wakeWords);

        if (result.detected && result.topMatch) {
          this.logger.info(
            `[WAKE-WORD] Detected via openWakeWord: "${result.topMatch}" ` +
            `(confidence: ${(result.confidence * 100).toFixed(1)}%)`
          );
          return true;
        }
      } catch (error) {
        this.logger.debug(`[WAKE-WORD] openWakeWord detection failed: ${error}`);
        // Fall through to text-based matching
      }
    }

    // Fallback to text-based matching (Whisper or fuzzy matching)
    if (this.containsWakeWord(text)) {
      if (this.wakeWordEngine === 'whisper') {
        this.logger.info(`[WAKE-WORD] Detected via Whisper text matching`);
      } else {
        this.logger.info(`[WAKE-WORD] Detected via fallback text matching`);
      }
      return true;
    }

    return false;
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
