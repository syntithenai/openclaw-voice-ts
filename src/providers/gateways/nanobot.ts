import { ClawGateway, SendMessageArgs, ClawResponse, Message, TTSDirective, HealthCheckResult, ClawProviderType } from '../claw-gateway';
import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';

export interface NanoBotConfig {
  gatewayUrl?: string;               // Optional: HTTP gateway URL (when exposed, default: http://localhost:18790)
  workspaceHome: string;               // Path to ~/.nanobot
  agentId?: string;                    // Agent ID (NanoBot uses single agent)
  timeout?: number;                    // Request timeout in ms
}

/**
 * NanoBot Provider - Ultra-lightweight personal AI assistant in Python
 * 
 * NanoBot is a stable, well-documented framework (~4000 lines of code)
 * with MCP support. It doesn't expose a formal public HTTP API by default,
 * so this integration uses file-based message passing via workspace.
 * 
 * Workspace structure:
 * ~/.nanobot/
 *   ├── config.json       # Configuration
 *   ├── workspace/        # Working directory
 *   │   ├── sessions/     # Conversation sessions (JSON)
 *   │   ├── memory/       # Long-term memory
 *   │   └── history/      # Conversation history
 */
export class NanoBotGateway implements ClawGateway {
  private config: NanoBotConfig;
  private timeout: number;

  constructor(config: NanoBotConfig) {
    this.config = config;
    this.timeout = config.timeout || 30000;
  }

  async sendMessage(args: SendMessageArgs): Promise<ClawResponse> {
    const messageId = `${Date.now()}-${randomUUID()}`;
    const workspaceDir = path.join(this.config.workspaceHome, 'workspace');
    
    try {
      // Ensure workspace directory exists
      await fs.mkdir(workspaceDir, { recursive: true });

      // Try HTTP gateway first if configured
      if (this.config.gatewayUrl) {
        try {
          return await this.sendViaHTTP(args);
        } catch (err) {
          console.warn(`NanoBot HTTP gateway failed: ${err}, falling back to file-based messaging`);
        }
      }

      // Fallback: File-based message passing
      // NanoBot stores sessions as JSON per channel:chat_id
      const channelKey = `voice:${args.sessionId}`;
      const sessionFile = path.join(workspaceDir, 'sessions', `${channelKey}.json`);
      
      try {
        // Ensure sessions directory exists
        await fs.mkdir(path.join(workspaceDir, 'sessions'), { recursive: true });

        // Read existing session or create new one
        let session: any;
        try {
          const existing = await fs.readFile(sessionFile, 'utf8');
          session = JSON.parse(existing);
        } catch {
          session = {
            channel: 'voice',
            chat_id: args.sessionId,
            messages: [],
            created_at: Date.now(),
            updated_at: Date.now()
          };
        }

        // Append message
        session.messages.push({
          id: messageId,
          role: 'user',
          content: args.userInput,
          timestamp: Date.now(),
          metadata: args.metadata || {}
        });
        session.updated_at = Date.now();

        // Write session back
        await fs.writeFile(sessionFile, JSON.stringify(session, null, 2), 'utf8');
      } catch (err) {
        console.warn(`Could not write to NanoBot session file: ${err}`);
      }

      // NanoBot in file-based mode - return synthetic response
      const response: ClawResponse = {
        text: `Message queued for NanoBot (file-based mode)`,
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
      console.error(`NanoBot sendMessage failed: ${err}`);
      throw new Error(`NanoBot message failed: ${String(err)}`);
    }
  }

  private async sendViaHTTP(args: SendMessageArgs): Promise<ClawResponse> {
    if (!this.config.gatewayUrl) {
      throw new Error('No gateway URL configured');
    }

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(`${this.config.gatewayUrl}/message`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-Id': args.sessionId,
          'X-Channel': 'voice'
        },
        body: JSON.stringify({
          text: args.userInput,
          chat_id: args.sessionId,
          channel: 'voice',
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
        runId: data.id || `nanobot-${Date.now()}`,
        ttsDirective: this.parseTTSDirective(data.text)
      };
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  async getHistory(sessionId: string): Promise<Message[]> {
    const workspaceDir = path.join(this.config.workspaceHome, 'workspace');
    const channelKey = `voice:${sessionId}`;
    const sessionFile = path.join(workspaceDir, 'sessions', `${channelKey}.json`);

    try {
      const content = await fs.readFile(sessionFile, 'utf8');
      const session = JSON.parse(content) as any;

      if (session.messages && Array.isArray(session.messages)) {
        return session.messages.map((msg: any) => ({
          role: (msg.role || 'user') as 'user' | 'assistant' | 'system',
          content: msg.content || ''
        }));
      }

      return [];
    } catch (err) {
      if ((err as any).code === 'ENOENT') {
        return [];
      }
      console.warn(`Could not read NanoBot session history: ${err}`);
      return [];
    }
  }

  async health(): Promise<HealthCheckResult> {
    try {
      const workspaceDir = path.join(this.config.workspaceHome, 'workspace');
      await fs.access(workspaceDir);
      
      if (this.config.gatewayUrl) {
        try {
          const controller = new AbortController();
          const timeoutHandle = setTimeout(() => controller.abort(), 5000);
          
          const response = await fetch(`${this.config.gatewayUrl}/health`, {
            signal: controller.signal
          });
          
          clearTimeout(timeoutHandle);
          return { ok: response.ok, provider: 'nanobot' };
        } catch {
          console.debug('NanoBot HTTP gateway not responding, but file-based mode is available');
          return { ok: true, provider: 'nanobot' };
        }
      }

      return { ok: true, provider: 'nanobot' };
    } catch (err) {
      console.error(`NanoBot health check failed: ${err}`);
      return { ok: false, provider: 'nanobot', error: String(err) };
    }
  }

  getProviderType(): ClawProviderType {
    return 'nanobot';
  }

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
