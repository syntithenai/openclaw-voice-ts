import { AudioCapture } from '../audio/capture';
import { VoiceActivityDetector } from '../audio/vad';
import { GatewayClient } from '../gateway/client';
import { ResponseParser, TTSDirective } from '../gateway/parser';
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
  piperUrl?: string;
  audioDevice?: string;
  sampleRate?: number;
}

export class VoiceOrchestrator {
  private currentState: VoiceState = 'idle';
  private logger: Logger;
  private audioCapture: AudioCapture;
  private vad: VoiceActivityDetector;
  private gatewayClient: GatewayClient;
  private ttsClient: TTSClient;
  private isRunning: boolean = false;
  private shouldExit: boolean = false;
  
  constructor(
    private config: OrchestratorConfig,
    logger?: Logger
  ) {
    this.logger = logger || new Logger('VoiceOrchestrator');
    
    this.audioCapture = new AudioCapture(
      config.sampleRate || 16000,
      config.audioDevice || 'default'
    );
    
    this.vad = new VoiceActivityDetector(config.sampleRate || 16000);
    
    this.gatewayClient = new GatewayClient(
      config.gatewayUrl,
      config.gatewayToken,
      config.agentId
    );
    
    this.ttsClient = new TTSClient(config.piperUrl || 'http://piper:5002');
  }
  
  /**
   * Start the main voice interaction loop
   */
  async start(): Promise<void> {
    this.isRunning = true;
    this.shouldExit = false;
    
    try {
      // Health checks
      if (!await this.gatewayClient.healthCheck()) {
        throw new Error('Gateway is not responding');
      }
      if (!await this.ttsClient.healthCheck()) {
        this.logger.warn('TTS service not responding, speech playback may fail');
      }
      
      this.logger.info('Voice orchestrator started');
      
      while (this.isRunning && !this.shouldExit) {
        await this.interactionLoop();
      }
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
  
  /**
   * Main interaction loop state machine
   */
  private async interactionLoop(): Promise<void> {
    try {
      // STATE: LISTENING - Capture speech from microphone
      this.setStateChange('listening');
      this.vad.reset();
      
      let transcribedText = '';
      let capturedAudio = Buffer.alloc(0);
      
      // Capture until silence detected
      for await (const frame of this.audioCapture.capture()) {
        // Analyze frame for speech
        const hasSpeech = this.vad.analyze(frame);
        capturedAudio = Buffer.concat([capturedAudio, frame]);
        
        // Check if silence finalized (user stopped speaking)
        if (this.vad.isSilenceFinalized()) {
          this.logger.debug('Silence finalized, ending capture');
          break;
        }
      }
      
      // TODO: Send audio to Whisper for STT
      // For now, skip and use placeholder
      transcribedText = '[Transcribed text from Whisper would go here]';
      
      if (!transcribedText.trim()) {
        return; // Try again if nothing was said
      }
      
      // STATE: SENDING - Send transcription to agent
      this.setStateChange('sending');
      this.logger.info(`Sending: ${transcribedText.substring(0, 100)}...`);
      
      const runId = await this.gatewayClient.sendTranscription(
        this.config.sessionKey,
        transcribedText
      );
      this.logger.debug(`Agent runId: ${runId}`);
      
      // STATE: WAITING - Poll for agent response
      this.setStateChange('waiting');
      const response = await this.gatewayClient.waitForResponse(this.config.sessionKey);
      
      if (!response) {
        this.logger.warn('No response from agent within timeout');
        return;
      }
      
      this.logger.info(`Agent response: ${ResponseParser.getText(response).substring(0, 100)}...`);
      
      // Parse TTS directives
      const directives = ResponseParser.parse(response);
      
      if (directives.length === 0) {
        this.logger.debug('No TTS directives in response');
        return;
      }
      
      // STATE: SPEAKING - Synthesize and play each directive with cut-in support
      this.setStateChange('speaking');
      
      for (const directive of directives) {
        await this.playWithCutIn(directive);
        
        if (this.shouldExit) {
          break;
        }
      }
      
    } catch (error) {
      this.logger.error('Error in interaction loop:', error);
      // Continue to next iteration instead of crashing
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  
  /**
   * Play audio with cut-in support
   * Kills playback if user starts speaking
   */
  private async playWithCutIn(directive: TTSDirective): Promise<void> {
    try {
      // Synthesize audio
      const audioBuffer = await this.ttsClient.synthesize(
        directive.text,
        directive.voiceId,
        directive.rate,
        directive.stability
      );
      
      // Start playback in background
      const playbackPromise = this.ttsClient.playAudio(audioBuffer);
      
      // Monitor for cut-in while playing
      const cutInPromise = this.monitorForCutIn();
      
      // Whichever finishes first wins
      await Promise.race([playbackPromise, cutInPromise]);
      
      // If cut-in detected, stop playback
      if (this.ttsClient.isSpeaking()) {
        this.logger.info('Cut-in detected, stopping playback');
        this.ttsClient.stopPlayback();
      }
      
    } catch (error) {
      this.logger.error('Error in playback/cut-in:', error);
    }
  }
  
  /**
   * Monitor for speech during playback (cut-in detection)
   */
  private async monitorForCutIn(): Promise<void> {
    this.vad.reset();
    
    for await (const frame of this.audioCapture.capture()) {
      const hasSpeech = this.vad.analyze(frame);
      
      // Immediate cut-in on speech detection
      if (hasSpeech) {
        return;
      }
      
      // Small delay between frames to avoid CPU spinning
      await new Promise(resolve => setTimeout(resolve, 10));
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
  
  /**
   * Get current state
   */
  getState(): VoiceState {
    return this.currentState;
  }
  
  /**
   * Cleanup resources
   */
  private cleanup(): void {
    this.logger.info('Cleaning up resources');
    this.audioCapture.stop();
    this.ttsClient.stopPlayback();
  }
}
