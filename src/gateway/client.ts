/**
 * HTTP Client for OpenClaw Gateway hooks endpoint
 * Sends transcribed text to agent and retrieves responses
 */

export interface HooksAgentResponse {
  runId: string;
  status: 'running' | 'completed' | 'failed';
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string | ContentBlock[];
}

export interface ContentBlock {
  type: 'text' | 'tool_use' | 'tool_result';
  text?: string;
  id?: string;
  name?: string;
  input?: any;
  content?: string;
}

export class GatewayClient {
  constructor(
    private gatewayUrl: string,
    private hookToken: string,
    private agentId: string,
    private sessionPrefix: string = 'voice:'
  ) {
    // Remove trailing slash from gateway URL
    this.gatewayUrl = this.gatewayUrl.replace(/\/$/, '');
  }
  
  /**
   * Send transcribed text to agent via /hooks/agent endpoint
   * Returns runId for tracking response
   */
  async sendTranscription(
    sessionKey: string,
    transcribedText: string
  ): Promise<string> {
    const endpoint = `${this.gatewayUrl}/hooks/agent`;
    
    const payload = {
      sessionKey: this.formatSessionKey(sessionKey),
      agentId: this.agentId,
      message: transcribedText,
    };
    
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.hookToken}`,
      },
      body: JSON.stringify(payload),
    });
    
    if (!response.ok) {
      throw new Error(
        `Failed to send transcription: ${response.status} ${response.statusText}`
      );
    }
    
    const data = await response.json() as any as HooksAgentResponse;
    return data.runId;
  }
  
  /**
   * Get conversation history including assistant response
   * Uses /chat.history endpoint for polling
   */
  async getResponse(sessionKey: string, limit: number = 10): Promise<ChatMessage[]> {
    const endpoint = `${this.gatewayUrl}/chat.history`;
    const params = new URLSearchParams({
      sessionKey: this.formatSessionKey(sessionKey),
      limit: limit.toString(),
    });
    
    const response = await fetch(`${endpoint}?${params.toString()}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${this.hookToken}`,
      },
    });
    
    if (!response.ok) {
      throw new Error(
        `Failed to get response: ${response.status} ${response.statusText}`
      );
    }
    
    const data = await response.json();
    return (data as any).messages || [];
  }
  
  /**
   * Wait for assistant response with timeout
   * Polls /chat.history until new assistant message appears
   */
  async waitForResponse(
    sessionKey: string,
    timeout: number = 30000,
    pollIntervalMs: number = 500
  ): Promise<ChatMessage | null> {
    const startTime = Date.now();
    let lastMessageCount = 0;
    
    while (Date.now() - startTime < timeout) {
      try {
        const messages = await this.getResponse(sessionKey);
        
        // Check if new assistant message appeared
        if (messages.length > lastMessageCount) {
          lastMessageCount = messages.length;
          
          // Find latest assistant message
          for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === 'assistant') {
              return messages[i];
            }
          }
        }
      } catch (error) {
        // Log but continue polling
        console.warn('Error polling for response:', error);
      }
      
      // Wait before next poll
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }
    
    return null; // Timeout
  }
  
  /**
   * Format session key with prefix if needed
   */
  private formatSessionKey(sessionKey: string): string {
    if (!sessionKey.startsWith(this.sessionPrefix)) {
      return this.sessionPrefix + sessionKey;
    }
    return sessionKey;
  }
  
  /**
   * Check gateway connectivity
   */
  async healthCheck(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      const response = await fetch(`${this.gatewayUrl}/health`, {
        method: 'GET',
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      return response.ok;
    } catch {
      return false;
    }
  }
}
