/**
 * OpenClaw Gateway Provider - HTTP hooks-based implementation
 */

import fetch from 'node-fetch';
import { ClawGateway, ClawResponse, Message, SendMessageArgs, HealthCheckResult, TTSDirective } from '../claw-gateway';

export interface OpenClawConfig {
  gatewayUrl: string;
  token: string;
  agentId?: string;
  sessionPrefix?: string;
  timeout?: number;
}

export class OpenClawGateway implements ClawGateway {
  private config: OpenClawConfig;
  private timeout: number;

  constructor(config: OpenClawConfig) {
    this.config = {
      sessionPrefix: 'voice',
      timeout: 30000,
      ...config,
    };
    this.timeout = this.config.timeout!;
  }

  async sendMessage(args: SendMessageArgs): Promise<ClawResponse> {
    const sessionKey = this.buildSessionKey(args.sessionId);
    const agentId = args.agentId || this.config.agentId || 'assistant';

    const response = await this.fetchWithTimeout(
      `${this.config.gatewayUrl}/hooks/agent`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.config.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          sessionKey,
          agentId,
          userMessage: args.userInput,
        }),
      }
    );

    if (!response.ok) {
      throw new Error(
        `OpenClaw request failed (${response.status}): ${response.statusText}`
      );
    }

    const data = await response.json() as any;

    // Extract text from response (could be direct or nested)
    const text = typeof data.message === 'string' 
      ? data.message 
      : typeof data.content === 'string'
      ? data.content
      : '';

    return {
      text,
      ttsDirective: this.parseTTSDirective(text),
      sessionId: args.sessionId,
      runId: data.runId || `run_${Date.now()}`,
    };
  }

  async getHistory(sessionId: string, limit: number = 10): Promise<Message[]> {
    const sessionKey = this.buildSessionKey(sessionId);
    const params = new URLSearchParams({
      sessionKey,
      limit: String(limit),
    });

    const response = await this.fetchWithTimeout(
      `${this.config.gatewayUrl}/chat.history?${params.toString()}`,
      {
        headers: {
          'Authorization': `Bearer ${this.config.token}`,
        },
      }
    );

    if (!response.ok) {
      throw new Error(
        `OpenClaw history request failed (${response.status}): ${response.statusText}`
      );
    }

    const data = await response.json() as any;
    return (data.messages || []) as Message[];
  }

  async health(): Promise<HealthCheckResult> {
    const startTime = Date.now();

    try {
      const response = await this.fetchWithTimeout(
        `${this.config.gatewayUrl}/health`,
        {
          headers: {
            'Authorization': `Bearer ${this.config.token}`,
          },
        },
        5000 // Health check timeout
      );

      const latency = Date.now() - startTime;

      if (!response.ok) {
        return {
          ok: false,
          provider: 'openclaw',
          latency,
          error: `Health check failed (${response.status})`,
        };
      }

      return {
        ok: true,
        provider: 'openclaw',
        latency,
      };
    } catch (error) {
      return {
        ok: false,
        provider: 'openclaw',
        error: `Health check error: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  getProviderType(): 'openclaw' {
    return 'openclaw';
  }

  private buildSessionKey(sessionId: string): string {
    const prefix = this.config.sessionPrefix || 'voice';
    return `${prefix}:${sessionId}`;
  }

  private parseTTSDirective(text: string): TTSDirective | undefined {
    // OpenClaw TTS directive format: 🎵[tts:voiceId=name,rate=1.0,stability=0.5]
    const match = text.match(
      /🎵\[tts:voiceId=([^,\]]+),rate=([\d.]+)(?:,stability=([\d.]+))?\]/
    );

    if (!match) {
      return undefined;
    }

    return {
      voiceId: match[1],
      rate: parseFloat(match[2]),
      stability: match[3] ? parseFloat(match[3]) : undefined,
    };
  }

  private async fetchWithTimeout(
    url: string,
    options: any,
    timeoutMs?: number
  ): Promise<any> {
    const timeout = timeoutMs || this.timeout;
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), timeout);

    try {
      return await fetch(url, {
        ...options,
        signal: controller.signal as any,
      });
    } finally {
      clearTimeout(timeoutHandle);
    }
  }
}
