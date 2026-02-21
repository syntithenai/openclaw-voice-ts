/**
 * IronClaw Gateway Provider - WebSocket/SSE implementation
 */

import WebSocket from 'ws';
import { randomUUID } from 'crypto';
import fetch from 'node-fetch';
import { ClawGateway, ClawResponse, Message, SendMessageArgs, HealthCheckResult } from '../claw-gateway';

export interface IronClawConfig {
  gatewayUrl: string;
  token: string;
  useWebSocket?: boolean;
  agentId?: string;
  timeout?: number;
}

export class IronClawGateway implements ClawGateway {
  private config: IronClawConfig;
  private timeout: number;
  private ws: WebSocket | null = null;
  private responseHandlers: Map<string, (response: ClawResponse) => void> = new Map();
  private pendingErrors: Map<string, Error> = new Map();

  constructor(config: IronClawConfig) {
    this.config = {
      useWebSocket: true,
      agentId: 'default',
      timeout: 30000,
      ...config,
    };
    this.timeout = this.config.timeout!;
  }

  async sendMessage(args: SendMessageArgs): Promise<ClawResponse> {
    if (this.config.useWebSocket) {
      return this.sendViaWebSocket(args);
    } else {
      return this.sendViaHTTP(args);
    }
  }

  private async sendViaWebSocket(args: SendMessageArgs): Promise<ClawResponse> {
    await this.ensureWebSocketConnected();

    return new Promise((resolve, reject) => {
      const runId = randomUUID();
      let resolved = false;

      const timeout = setTimeout(() => {
        this.responseHandlers.delete(runId);
        this.pendingErrors.delete(runId);
        if (!resolved) {
          resolved = true;
          reject(new Error(`IronClaw WebSocket request timeout: ${runId}`));
        }
      }, this.timeout);

      this.responseHandlers.set(runId, (response: ClawResponse) => {
        clearTimeout(timeout);
        this.responseHandlers.delete(runId);
        this.pendingErrors.delete(runId);
        if (!resolved) {
          resolved = true;
          resolve(response);
        }
      });

      this.pendingErrors.set(runId, new Error('Pending'));

      try {
        this.ws!.send(
          JSON.stringify({
            type: 'message',
            runId,
            sessionId: args.sessionId,
            agentId: args.agentId || this.config.agentId,
            text: args.userInput,
            metadata: args.metadata,
          })
        );
      } catch (error) {
        clearTimeout(timeout);
        this.responseHandlers.delete(runId);
        this.pendingErrors.delete(runId);
        if (!resolved) {
          resolved = true;
          reject(error);
        }
      }
    });
  }

  private async sendViaHTTP(args: SendMessageArgs): Promise<ClawResponse> {
    const response = await this.fetchWithTimeout(
      `${this.config.gatewayUrl}/api/message`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.config.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          sessionId: args.sessionId,
          agentId: args.agentId || this.config.agentId,
          text: args.userInput,
          metadata: args.metadata,
        }),
      }
    );

    if (!response.ok) {
      throw new Error(
        `IronClaw HTTP request failed (${response.status}): ${response.statusText}`
      );
    }

    const data = await response.json() as any;

    return {
      text: data.text || data.response || '',
      ttsDirective: undefined,
      sessionId: args.sessionId,
      runId: data.runId || randomUUID(),
    };
  }

  async getHistory(sessionId: string, limit: number = 10): Promise<Message[]> {
    try {
      // Try HTTP endpoint for memory retrieval
      const response = await this.fetchWithTimeout(
        `${this.config.gatewayUrl}/api/memory?sessionId=${encodeURIComponent(
          sessionId
        )}&limit=${limit}`,
        {
          headers: {
            'Authorization': `Bearer ${this.config.token}`,
          },
        }
      );

      if (!response.ok) {
        return [];
      }

      const data = await response.json() as any;
      return (data.messages || []) as Message[];
    } catch {
      // Memory endpoint not available
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
            'Authorization': `Bearer ${this.config.token}`,
          },
        },
        5000
      );

      const latency = Date.now() - startTime;

      if (!response.ok) {
        return {
          ok: false,
          provider: 'ironclaw',
          latency,
          error: `Health check failed (${response.status})`,
        };
      }

      return {
        ok: true,
        provider: 'ironclaw',
        latency,
      };
    } catch (error) {
      return {
        ok: false,
        provider: 'ironclaw',
        error: `Health check error: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  getProviderType(): 'ironclaw' {
    return 'ironclaw';
  }

  private async ensureWebSocketConnected(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) {
      return;
    }

    return new Promise((resolve, reject) => {
      const wsUrl = `${this.config.gatewayUrl
        .replace(/^http/, 'ws')
        .replace(/\/$/, '')}/ws`;

      try {
        this.ws = new WebSocket(wsUrl);

        this.ws.on('open', () => {
          this.setupMessageHandler();
          resolve();
        });

        this.ws.on('error', (error: Error) => {
          reject(new Error(`WebSocket connection error: ${error.message}`));
        });

        setTimeout(() => {
          if (this.ws?.readyState !== WebSocket.OPEN) {
            reject(new Error('WebSocket connection timeout'));
          }
        }, 5000);
      } catch (error) {
        reject(error);
      }
    });
  }

  private setupMessageHandler(): void {
    if (!this.ws) return;

    this.ws.on('message', (data: WebSocket.Data) => {
      try {
        const message = JSON.parse(data.toString());

        if (message.runId && this.responseHandlers.has(message.runId)) {
          const handler = this.responseHandlers.get(message.runId)!;
          handler({
            text: message.text || message.response || '',
            ttsDirective: undefined,
            sessionId: message.sessionId,
            runId: message.runId,
          });
        }
      } catch (error) {
        // Ignore malformed messages
      }
    });

    this.ws.on('close', () => {
      this.ws = null;
      // Reject all pending handlers
      for (const [runId, handler] of this.responseHandlers) {
        handler({
          text: '',
          sessionId: '',
          runId,
        });
      }
      this.responseHandlers.clear();
    });

    this.ws.on('error', (error: Error) => {
      // Error handling - don't close connection, let client decide
    });
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
