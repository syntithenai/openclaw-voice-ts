/**
 * WebSocket Client for OpenClaw Gateway
 * Provides real-time bidirectional communication with the gateway server
 */

import WebSocket from 'ws';
import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';

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

export interface GatewayWSClientOptions {
  gatewayUrl: string;
  token: string;
  sessionKey: string;
}

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

export class GatewayWSClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private connected = false;
  private pendingRequests = new Map<string, PendingRequest>();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 2000;
  
  constructor(private options: GatewayWSClientOptions) {
    super();
  }
  
  private log(message: string): void {
    process.stderr.write(`[GatewayWS] ${message}\n`);
  }
  
  /**
   * Connect to the gateway WebSocket server
   */
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const wsUrl = this.options.gatewayUrl.replace(/^http/, 'ws');
      
      // Add Origin header to pass browser origin checks
      this.ws = new WebSocket(wsUrl, {
        headers: {
          'Origin': 'http://openclaw-gateway:18789'
        }
      });
      
      this.ws.on('open', async () => {
        try {
          // Send hello handshake
          await this.sendHello();
          this.connected = true;
          this.reconnectAttempts = 0;
          this.emit('connected');
          resolve();
        } catch (error) {
          reject(error);
        }
      });
      
      this.ws.on('message', (data: WebSocket.Data) => {
        this.handleMessage(data);
      });
      
      this.ws.on('close', (code, reason) => {
        this.connected = false;
        this.emit('disconnected');
        this.attemptReconnect();
      });
      
      this.ws.on('error', (error) => {
        this.emit('error', error);
        if (!this.connected) {
          reject(error);
        }
      });
    });
  }
  
  /**
   * Send hello/handshake message
   */
  private async sendHello(): Promise<void> {
    const id = randomUUID();
    const connectRequest = {
      type: 'req',
      id,
      method: 'connect',
      params: {
        minProtocol: 3,
        maxProtocol: 3,
        client: {
          id: 'openclaw-control-ui',
          version: '0.1.0',
          platform: 'linux',
          mode: 'ui',
        },
        role: 'operator',
        scopes: ['operator.write'],
        caps: [],
        commands: [],
        auth: {
          token: this.options.token,
        },
      },
    };
    
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Connect handshake timeout'));
      }, 10000);
      
      const checkResponse = (data: WebSocket.Data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'res' && msg.id === id) {
            clearTimeout(timeout);
            this.ws?.off('message', checkResponse);
            if (msg.ok && msg.payload?.type === 'hello-ok') {
              resolve();
            } else {
              reject(new Error(`Connect failed: ${msg.error?.message || JSON.stringify(msg)}`));
            }
          }
        } catch (e) {
          // Ignore parse errors for other messages
        }
      };
      
      this.ws?.on('message', checkResponse);
      this.ws?.send(JSON.stringify(connectRequest));
    });
  }
  
  /**
   * Handle incoming WebSocket messages
   */
  private handleMessage(data: WebSocket.Data): void {
    try {
      const msg = JSON.parse(data.toString());
      
      // Handle RPC responses
      if (msg.type === 'res' && msg.id) {
        const pending = this.pendingRequests.get(msg.id);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pendingRequests.delete(msg.id);
          
          if (msg.ok) {
            pending.resolve(msg.payload);
          } else {
            pending.reject(new Error(msg.error?.message || 'Request failed'));
          }
        }
      }
      
      // Handle events
      if (msg.type === 'event') {
        this.emit('gateway-event', msg);
        
        // Emit specific events for assistant responses
        // Agent events have streaming text in payload.data.text
        if (msg.event === 'agent' && msg.payload?.stream === 'assistant') {
          this.emit('assistant-message', msg.payload);
        }
        // Also handle chat.message events for compatibility
        if (msg.event === 'chat.message' && msg.payload?.role === 'assistant') {
          this.emit('assistant-message', msg.payload);
        }
      }
    } catch (error) {
      this.emit('error', new Error(`Failed to parse message: ${error}`));
    }
  }
  
  /**
   * Send an RPC request to the gateway
   */
  private async request<T = any>(method: string, params: any, timeoutMs = 30000): Promise<T> {
    if (!this.connected || !this.ws) {
      throw new Error('Not connected to gateway');
    }
    
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timeout: ${method}`));
      }, timeoutMs);
      
      this.pendingRequests.set(id, { resolve, reject, timeout });
      
      this.ws!.send(JSON.stringify({
        type: 'req',
        id,
        method,
        params,
      }));
    });
  }
  
  /**
   * Send a chat message and get the response
   */
  async sendMessage(message: string): Promise<void> {
    const response = await this.request('agent', {
      sessionKey: this.options.sessionKey,
      message,
      idempotencyKey: randomUUID(),
    });
    
    // Response indicates the message was accepted
    // Actual assistant response will come as an event
    return response;
  }
  
  /**
   * Get chat history
   */
  async getChatHistory(limit = 10): Promise<ChatMessage[]> {
    const response = await this.request<{ messages?: ChatMessage[] }>('chat.history', {
      sessionKey: this.options.sessionKey,
      limit,
    });
    
    return response?.messages || [];
  }
  
  /**
   * Attempt to reconnect to the gateway
   */
  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.emit('error', new Error('Max reconnect attempts reached'));
      return;
    }
    
    this.reconnectAttempts++;
    const delay = this.reconnectDelay * this.reconnectAttempts;
    
    setTimeout(() => {
      this.connect().catch((error) => {
        this.emit('error', error);
      });
    }, delay);
  }
  
  /**
   * Disconnect from the gateway
   */
  disconnect(): void {
    this.connected = false;
    this.reconnectAttempts = this.maxReconnectAttempts; // Prevent auto-reconnect
    
    // Clear all pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Client disconnected'));
    }
    this.pendingRequests.clear();
    
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
  
  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.connected;
  }
}
