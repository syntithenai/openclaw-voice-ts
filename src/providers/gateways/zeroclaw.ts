/**
 * ZeroClaw Gateway Provider - HTTP webhook-based implementation
 */

import fetch from 'node-fetch';
import { ClawGateway, ClawResponse, Message, SendMessageArgs, HealthCheckResult } from '../claw-gateway';

export interface ZeroClawConfig {
  gatewayUrl: string;
  webhookToken: string;
  channel?: string;
  timeout?: number;
}

export class ZeroClawGateway implements ClawGateway {
  private config: ZeroClawConfig;
  private timeout: number;

  constructor(config: ZeroClawConfig) {
    this.config = {
      channel: 'voice',
      timeout: 30000,
      ...config,
    };
    this.timeout = this.config.timeout!;
  }

  async sendMessage(args: SendMessageArgs): Promise<ClawResponse> {
    const response = await this.fetchWithTimeout(
      `${this.config.gatewayUrl}/webhook`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.config.webhookToken}`,
          'Content-Type': 'application/json',
          'X-Session-Id': args.sessionId,
          'X-Agent-Id': args.agentId || 'default',
          'X-Channel': this.config.channel!,
        },
        body: JSON.stringify({
          text: args.userInput,
          metadata: {
            channel: 'voice',
            ...args.metadata,
          },
        }),
      }
    );

    if (!response.ok) {
      throw new Error(
        `ZeroClaw request failed (${response.status}): ${response.statusText}`
      );
    }

    const data = await response.json() as any;

    // ZeroClaw returns provider-agnostic response
    const text = data.response || data.text || data.message || '';

    return {
      text,
      ttsDirective: undefined, // ZeroClaw doesn't have built-in TTS directives
      sessionId: args.sessionId,
      runId: data.id || `run_${Date.now()}`,
    };
  }

  async getHistory(sessionId: string, limit: number = 10): Promise<Message[]> {
    // ZeroClaw stores memory in configurable backend (SQLite, PostgreSQL, Markdown)
    // History retrieval requires backend-specific implementation
    // For now, return empty array - in production, would need:
    // 1. Access to configured memory backend
    // 2. Backend-specific query mechanism
    // 3. Fallback to in-memory session tracking

    try {
      const response = await this.fetchWithTimeout(
        `${this.config.gatewayUrl}/memory?sessionId=${encodeURIComponent(sessionId)}&limit=${limit}`,
        {
          headers: {
            'Authorization': `Bearer ${this.config.webhookToken}`,
          },
        }
      );

      if (!response.ok) {
        // ZeroClaw may not expose memory endpoint, return empty
        return [];
      }

      const data = await response.json() as any;
      return (data.messages || []) as Message[];
    } catch {
      // Memory retrieval not available, fallback to empty history
      return [];
    }
  }

  async health(): Promise<HealthCheckResult> {
    const startTime = Date.now();

    try {
      const response = await this.fetchWithTimeout(
        `${this.config.gatewayUrl}/health`,
        {
          headers: {
            'Authorization': `Bearer ${this.config.webhookToken}`,
          },
        },
        5000
      );

      const latency = Date.now() - startTime;

      if (!response.ok) {
        return {
          ok: false,
          provider: 'zeroclaw',
          latency,
          error: `Health check failed (${response.status})`,
        };
      }

      return {
        ok: true,
        provider: 'zeroclaw',
        latency,
      };
    } catch (error) {
      return {
        ok: false,
        provider: 'zeroclaw',
        error: `Health check error: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  getProviderType(): 'zeroclaw' {
    return 'zeroclaw';
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
