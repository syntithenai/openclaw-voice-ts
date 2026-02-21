/**
 * Abstract gateway interface for all claw variants
 * Normalizes messaging APIs across OpenClaw, ZeroClaw, TinyClaw, IronClaw, and MimiClaw
 */

export interface TTSDirective {
  voiceId: string;
  rate: number;
  stability?: number;
}

export interface ClawResponse {
  text: string;
  ttsDirective?: TTSDirective;
  sessionId: string;
  runId: string;
}

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp?: number;
}

export interface HealthCheckResult {
  ok: boolean;
  latency?: number;
  provider?: string;
  error?: string;
}

export interface SendMessageArgs {
  userInput: string;
  sessionId: string;
  agentId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Gateway abstraction interface - implemented by each claw variant provider
 */
export interface ClawGateway {
  /**
   * Send a message and get response
   */
  sendMessage(args: SendMessageArgs): Promise<ClawResponse>;

  /**
   * Retrieve conversation history
   */
  getHistory(sessionId: string, limit?: number): Promise<Message[]>;

  /**
   * Check gateway health and connectivity
   */
  health(): Promise<HealthCheckResult>;

  /**
   * Get provider type
   */
  getProviderType(): ClawProviderType;
}

export type ClawProviderType = 'openclaw' | 'zeroclaw' | 'tinyclaw' | 'ironclaw' | 'mimiclaw';
