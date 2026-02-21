/**
 * MimiClaw Gateway Provider - WebSocket/Telegram implementation
 */

import WebSocket from 'ws';
import { randomUUID } from 'crypto';
import fetch from 'node-fetch';
import { ClawGateway, ClawResponse, Message, SendMessageArgs, HealthCheckResult } from '../claw-gateway';

export interface MimiClawConfig {
  deviceHost: string;
  devicePort?: number;
  useWebSocket?: boolean;
  telegramBotToken?: string;
  telegramChatId?: string;
  timeout?: number;
}

export class MimiClawGateway implements ClawGateway {
  private config: MimiClawConfig;
  private timeout: number;
  private ws: WebSocket | null = null;
  private responseHandlers: Map<string, (response: ClawResponse) => void> = new Map();

  constructor(config: MimiClawConfig) {
    this.config = {
      devicePort: 18789,
      useWebSocket: true,
      timeout: 30000,
      ...config,
    };
    this.timeout = this.config.timeout!;
  }

  async sendMessage(args: SendMessageArgs): Promise<ClawResponse> {
    if (this.config.useWebSocket) {
      return this.sendViaWebSocket(args);
    } else if (this.config.telegramBotToken && this.config.telegramChatId) {
      return this.sendViaTelegram(args);
    } else {
      throw new Error(
        'MimiClaw: Must configure either WebSocket (useWebSocket=true) or Telegram (telegramBotToken + telegramChatId)'
      );
    }
  }

  private async sendViaWebSocket(args: SendMessageArgs): Promise<ClawResponse> {
    await this.ensureWebSocketConnected();

    return new Promise((resolve, reject) => {
      const requestId = randomUUID();
      let resolved = false;

      const timeout = setTimeout(() => {
        this.responseHandlers.delete(requestId);
        if (!resolved) {
          resolved = true;
          reject(new Error(`MimiClaw WebSocket request timeout: ${requestId}`));
        }
      }, this.timeout);

      this.responseHandlers.set(requestId, (response: ClawResponse) => {
        clearTimeout(timeout);
        this.responseHandlers.delete(requestId);
        if (!resolved) {
          resolved = true;
          resolve(response);
        }
      });

      try {
        this.ws!.send(
          JSON.stringify({
            requestId,
            sessionId: args.sessionId,
            userInput: args.userInput,
            timestamp: Date.now(),
            metadata: args.metadata,
          })
        );
      } catch (error) {
        clearTimeout(timeout);
        this.responseHandlers.delete(requestId);
        if (!resolved) {
          resolved = true;
          reject(error);
        }
      }
    });
  }

  private async sendViaTelegram(args: SendMessageArgs): Promise<ClawResponse> {
    if (!this.config.telegramBotToken || !this.config.telegramChatId) {
      throw new Error('Telegram configuration incomplete');
    }

    const message = args.userInput;
    const botToken = this.config.telegramBotToken;
    const chatId = this.config.telegramChatId;

    try {
      const response = await this.fetchWithTimeout(
        `https://api.telegram.org/bot${botToken}/sendMessage`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            chat_id: chatId,
            text: message,
            parse_mode: 'HTML',
          }),
        }
      );

      if (!response.ok) {
        throw new Error(
          `Telegram API error (${response.status}): ${response.statusText}`
        );
      }

      const data = await response.json() as any;
      const messageId = data.result?.message_id || randomUUID();

      return {
        text: `Message sent via Telegram (ID: ${messageId})`,
        ttsDirective: undefined,
        sessionId: args.sessionId,
        runId: String(messageId),
      };
    } catch (error) {
      throw new Error(
        `Telegram send failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async getHistory(sessionId: string, limit: number = 10): Promise<Message[]> {
    if (this.config.useWebSocket) {
      return this.getHistoryViaWebSocket(sessionId, limit);
    }
    // Telegram doesn't expose history API in this context
    return [];
  }

  private async getHistoryViaWebSocket(
    sessionId: string,
    limit: number
  ): Promise<Message[]> {
    await this.ensureWebSocketConnected();

    return new Promise((resolve) => {
      const requestId = randomUUID();

      const timeout = setTimeout(() => {
        this.responseHandlers.delete(requestId);
        resolve([]);
      }, 5000);

      this.responseHandlers.set(requestId, (response: ClawResponse) => {
        clearTimeout(timeout);
        this.responseHandlers.delete(requestId);
        // Response handler converts to history
        resolve([
          {
            role: 'user',
            content: response.text,
            timestamp: Date.now(),
          },
        ]);
      });

      try {
        this.ws!.send(
          JSON.stringify({
            command: 'get_history',
            requestId,
            sessionId,
            limit,
          })
        );
      } catch {
        clearTimeout(timeout);
        this.responseHandlers.delete(requestId);
        resolve([]);
      }
    });
  }

  async health(): Promise<HealthCheckResult> {
    const startTime = Date.now();

    if (this.config.useWebSocket) {
      try {
        await this.ensureWebSocketConnected();
        const latency = Date.now() - startTime;
        return {
          ok: true,
          provider: 'mimiclaw',
          latency,
        };
      } catch (error) {
        return {
          ok: false,
          provider: 'mimiclaw',
          error: `WebSocket connection failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
    }

    // Telegram health check
    if (this.config.telegramBotToken) {
      try {
        const response = await this.fetchWithTimeout(
          `https://api.telegram.org/bot${this.config.telegramBotToken}/getMe`,
          { headers: { 'Content-Type': 'application/json' } },
          5000
        );

        const latency = Date.now() - startTime;

        if (!response.ok) {
          return {
            ok: false,
            provider: 'mimiclaw',
            latency,
            error: `Telegram API error (${response.status})`,
          };
        }

        return {
          ok: true,
          provider: 'mimiclaw',
          latency,
        };
      } catch (error) {
        return {
          ok: false,
          provider: 'mimiclaw',
          error: `Telegram health check failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
    }

    return {
      ok: false,
      provider: 'mimiclaw',
      error: 'No transport configured (WebSocket or Telegram)',
    };
  }

  getProviderType(): 'mimiclaw' {
    return 'mimiclaw';
  }

  private async ensureWebSocketConnected(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) {
      return;
    }

    return new Promise((resolve, reject) => {
      const wsUrl = `ws://${this.config.deviceHost}:${this.config.devicePort || 18789}`;

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

        if (message.requestId && this.responseHandlers.has(message.requestId)) {
          const handler = this.responseHandlers.get(message.requestId)!;
          handler({
            text: message.response || message.message || '',
            ttsDirective: undefined,
            sessionId: message.sessionId,
            runId: message.requestId,
          });
        }
      } catch {
        // Ignore malformed messages
      }
    });

    this.ws.on('close', () => {
      this.ws = null;
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
