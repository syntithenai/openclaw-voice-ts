import { ClawGateway, SendMessageArgs, ClawResponse, Message, TTSDirective, HealthCheckResult, ClawProviderType } from '../claw-gateway';
import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';

export interface PicoClawConfig {
  gatewayUrl?: string;               // Optional: HTTP gateway URL (when exposed)
  workspaceHome: string;               // Path to ~/.picoclaw/workspace
  agentId?: string;                    // Agent to route to (default: any available)
  timeout?: number;                    // Request timeout in ms
}

/**
 * PicoClaw Provider - Ultra-lightweight AI assistant in Go
 * 
 * PicoClaw is an early-stage framework (v0.1.x) without formal public HTTP API.
 * This integration uses file-based message passing via workspace directories,
 * similar to TinyClaw.
 * 
 * Workspace structure:
 * ~/.picoclaw/workspace/
 *   ├── sessions/          # Conversation sessions
 *   ├── memory/            # Long-term memory
 *   └── (future: message queue dirs)
 */
export class PicoClawGateway implements ClawGateway {
  private config: PicoClawConfig;
  private timeout: number;

  constructor(config: PicoClawConfig) {
    this.config = config;
    this.timeout = config.timeout || 30000;
  }

  async sendMessage(args: SendMessageArgs): Promise<ClawResponse> {
    const messageId = `${Date.now()}-${randomUUID()}`;
    const sessionDir = path.join(this.config.workspaceHome, 'sessions');
    
    try {
      // Ensure sessions directory exists
      await fs.mkdir(sessionDir, { recursive: true });

      // Try HTTP gateway first if configured
      if (this.config.gatewayUrl) {
        try {
          return await this.sendViaHTTP(args);
        } catch (err) {
          console.warn(`PicoClaw HTTP gateway failed: ${err}, falling back to file-based messaging`);
        }
      }

      // Fallback: File-based message passing
      // Write message to session file (append to JSON lines)
      const sessionFile = path.join(sessionDir, `${args.sessionId}.jsonl`);
      
      const messageEntry = {
        id: messageId,
        timestamp: Date.now(),
        type: 'user',
        content: args.userInput,
        agent: args.agentId || this.config.agentId || 'default',
        metadata: args.metadata || {}
      };

      try {
        await fs.appendFile(
          sessionFile,
          JSON.stringify(messageEntry) + '\n',
          'utf8'
        );
      } catch (err) {
        console.warn(`Could not write to session file: ${err}`);
      }

      // PicoClaw in early development - return synthetic response
      // In production, would need to poll for agent responses
      const response: ClawResponse = {
        text: `Message queued for ${args.agentId || 'default'} agent (PicoClaw file-based mode)`,
        sessionId: args.sessionId,
        runId: messageId,
        ttsDirective: {
          voiceId: 'en_US-amy-medium',
          rate: 1.0,
          stability: 0.5
        }
      };

      return response;
    } catch (err) {
      console.error(`PicoClaw sendMessage failed: ${err}`);
      throw new Error(`PicoClaw message failed: ${String(err)}`);
    }
  }

  /**
   * Optional HTTP gateway communication (if PicoClaw exposes HTTP API)
   */
  private async sendViaHTTP(args: SendMessageArgs): Promise<ClawResponse> {
    if (!this.config.gatewayUrl) {
      throw new Error('No gateway URL configured');
    }

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(`${this.config.gatewayUrl}/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-Id': args.sessionId,
          'X-Agent-Id': args.agentId || 'default'
        },
        body: JSON.stringify({
          text: args.userInput,
          metadata: args.metadata || {},
          timestamp: Date.now()
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      }

      const data = (await response.json()) as any;
      
      return {
        text: data.text || data.response || '',
        sessionId: args.sessionId,
        runId: data.id || `picoclaw-${Date.now()}`,
        ttsDirective: this.parseTTSDirective(data.text)
      };
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  async getHistory(sessionId: string): Promise<Message[]> {
    const sessionDir = path.join(this.config.workspaceHome, 'sessions');
    const sessionFile = path.join(sessionDir, `${sessionId}.jsonl`);

    try {
      const content = await fs.readFile(sessionFile, 'utf8');
      const lines = content.trim().split('\n').filter(l => l);

      return lines.map((line, idx) => {
        try {
          const entry = JSON.parse(line) as any;
          return {
            role: (entry.type === 'user' ? 'user' : 'assistant') as 'user' | 'assistant' | 'system',
            content: entry.content || ''
          };
        } catch {
          console.warn(`Could not parse JSONL line ${idx}`);
          return { role: 'user' as const, content: '' };
        }
      });
    } catch (err) {
      if ((err as any).code === 'ENOENT') {
        return [];
      }
      console.warn(`Could not read PicoClaw session history: ${err}`);
      return [];
    }
  }

  async health(): Promise<HealthCheckResult> {
    try {
      // Check if workspace directory exists and is accessible
      await fs.access(this.config.workspaceHome);
      
      // If HTTP gateway configured, also test it
      if (this.config.gatewayUrl) {
        try {
          const controller = new AbortController();
          const timeoutHandle = setTimeout(() => controller.abort(), 5000);
          
          const response = await fetch(`${this.config.gatewayUrl}/health`, {
            signal: controller.signal
          });
          
          clearTimeout(timeoutHandle);
          return { ok: response.ok, provider: 'picoclaw' };
        } catch {
          console.debug('PicoClaw HTTP gateway not responding, but file-based mode is available');
          return { ok: true, provider: 'picoclaw' }; // File mode still works
        }
      }

      return { ok: true, provider: 'picoclaw' };
    } catch (err) {
      console.error(`PicoClaw health check failed: ${err}`);
      return { ok: false, provider: 'picoclaw', error: String(err) };
    }
  }

  getProviderType(): ClawProviderType {
    return 'picoclaw';
  }

  /**
   * Parse TTS directives from text (if agent includes them)
   * Format: 🎵[tts:voiceId=X,rate=Y,stability=Z]text
   */
  private parseTTSDirective(text: string): TTSDirective | undefined {
    const match = text.match(/🎵\[tts:([^\]]+)\]/);
    if (!match) {
      return {
        voiceId: 'en_US-amy-medium',
        rate: 1.0,
        stability: 0.5
      };
    }

    const params = match[1];
    const voiceIdMatch = params.match(/voiceId=([^,\]]+)/);
    const rateMatch = params.match(/rate=([^,\]]+)/);
    const stabilityMatch = params.match(/stability=([^,\]]+)/);

    return {
      voiceId: voiceIdMatch ? voiceIdMatch[1] : 'en_US-amy-medium',
      rate: rateMatch ? parseFloat(rateMatch[1]) : 1.0,
      stability: stabilityMatch ? parseFloat(stabilityMatch[1]) : 0.5
    };
  }
}
