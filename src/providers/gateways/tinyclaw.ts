/**
 * TinyClaw Gateway Provider - File-based queue implementation
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { ClawGateway, ClawResponse, Message, SendMessageArgs, HealthCheckResult } from '../claw-gateway';

export interface TinyClawConfig {
  tinyClawHome: string;
  agentId?: string;
  timeout?: number;
}

export class TinyClawGateway implements ClawGateway {
  private config: TinyClawConfig;
  private timeout: number;
  private queueDir: string;

  constructor(config: TinyClawConfig) {
    this.config = {
      agentId: 'default',
      timeout: 30000,
      ...config,
    };
    this.timeout = this.config.timeout!;
    this.queueDir = path.join(this.config.tinyClawHome, 'queue');
  }

  async sendMessage(args: SendMessageArgs): Promise<ClawResponse> {
    const messageId = `${Date.now()}-${randomUUID()}`;

    try {
      // Create queue directories if they don't exist
      await this.ensureQueueDir();

      // Write message to incoming queue
      const incomingPath = path.join(this.queueDir, 'incoming', `${messageId}.json`);
      await fs.writeFile(
        incomingPath,
        JSON.stringify(
          {
            id: messageId,
            sessionId: args.sessionId,
            agentId: args.agentId || this.config.agentId,
            message: args.userInput,
            timestamp: Date.now(),
            source: 'voice',
            metadata: args.metadata,
          },
          null,
          2
        )
      );

      // Wait for agent to process and write response to outgoing queue
      const response = await this.waitForResponse(messageId, this.timeout);

      return {
        text: response.response || response.message || '',
        ttsDirective: undefined,
        sessionId: args.sessionId,
        runId: messageId,
      };
    } catch (error) {
      throw new Error(
        `TinyClaw send failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async getHistory(sessionId: string, limit: number = 10): Promise<Message[]> {
    try {
      // TinyClaw stores per-channel conversations in various locations
      // Try multiple possible paths
      const possiblePaths = [
        path.join(this.config.tinyClawHome, 'conversations', `${sessionId}.jsonl`),
        path.join(this.config.tinyClawHome, 'agents', 'conversations', `${sessionId}.jsonl`),
        path.join(this.config.tinyClawHome, 'sessions', `${sessionId}.jsonl`),
      ];

      for (const filePath of possiblePaths) {
        try {
          const content = await fs.readFile(filePath, 'utf-8');
          const messages: Message[] = [];

          // Parse JSONL format
          for (const line of content.split('\n')) {
            if (!line.trim()) continue;
            try {
              const obj = JSON.parse(line);
              if (obj.role && obj.content) {
                messages.push({
                  role: obj.role,
                  content: obj.content,
                  timestamp: obj.timestamp,
                });
              }
            } catch {
              // Skip malformed lines
            }
          }

          return messages.slice(-limit);
        } catch {
          // Try next path
        }
      }

      // No history found
      return [];
    } catch {
      return [];
    }
  }

  async health(): Promise<HealthCheckResult> {
    const startTime = Date.now();

    try {
      // Check if queue directory is accessible
      await fs.access(this.queueDir).catch(() =>
        fs.mkdir(this.queueDir, { recursive: true })
      );

      const latency = Date.now() - startTime;

      return {
        ok: true,
        provider: 'tinyclaw',
        latency,
      };
    } catch (error) {
      return {
        ok: false,
        provider: 'tinyclaw',
        error: `Health check error: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  getProviderType(): 'tinyclaw' {
    return 'tinyclaw';
  }

  private async ensureQueueDir(): Promise<void> {
    const dirs = [
      path.join(this.queueDir, 'incoming'),
      path.join(this.queueDir, 'outgoing'),
      path.join(this.queueDir, 'processing'),
    ];

    for (const dir of dirs) {
      await fs.mkdir(dir, { recursive: true });
    }
  }

  private async waitForResponse(messageId: string, timeoutMs: number): Promise<any> {
    const outgoingPath = path.join(this.queueDir, 'outgoing', `${messageId}.json`);
    const startTime = Date.now();
    const pollInterval = 100; // Poll every 100ms

    while (Date.now() - startTime < timeoutMs) {
      try {
        const data = await fs.readFile(outgoingPath, 'utf-8');
        // Clean up processed message
        await fs.unlink(outgoingPath).catch(() => {});
        return JSON.parse(data);
      } catch {
        // File not ready yet, wait and retry
        await new Promise(resolve => setTimeout(resolve, pollInterval));
      }
    }

    throw new Error(
      `TinyClaw response timeout for ${messageId} after ${timeoutMs}ms`
    );
  }
}
