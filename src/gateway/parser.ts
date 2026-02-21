import { ChatMessage } from './client';

/**
 * Parse TTS directives from agent responses
 * Format: 🎵[tts:voiceId=luna,rate=1.0,stability=0.5]Text to speak here
 */

export interface TTSDirective {
  voiceId?: string;
  rate?: number;
  stability?: number;
  text: string;
}

export class ResponseParser {
  private static readonly TTS_DIRECTIVE_REGEX = /🎵\[tts:([^\]]+)\]([^🎵]*?)(?=🎵\[tts:|$)/gs;
  
  /**
   * Extract all TTS directives from a response
   */
  static parse(response: ChatMessage): TTSDirective[] {
    if (typeof response.content !== 'string') {
      // If content is array of blocks, extract text
      const textContent = response.content
        .filter(block => block.type === 'text')
        .map(block => block.text || '')
        .join('\n');
      return this.parseText(textContent);
    }
    
    return this.parseText(response.content);
  }
  
  /**
   * Extract all TTS directives from plain text
   */
  static parseText(text: string): TTSDirective[] {
    const directives: TTSDirective[] = [];
    let match;
    
    // Reset regex state
    this.TTS_DIRECTIVE_REGEX.lastIndex = 0;
    
    while ((match = this.TTS_DIRECTIVE_REGEX.exec(text)) !== null) {
      const params = match[1];
      const textContent = match[2].trim();
      
      if (!textContent) {
        continue; // Skip empty directives
      }
      
      const directive: TTSDirective = {
        ...this.parseParams(params),
        text: textContent,
      };
      directives.push(directive);
    }
    
    return directives;
  }
  
  /**
   * Check if response contains TTS directives
   */
  static hasDirectives(response: ChatMessage): boolean {
    const content = typeof response.content === 'string'
      ? response.content
      : response.content
          .filter(block => block.type === 'text')
          .map(block => block.text || '')
          .join('\n');
    
    return /🎵\[tts:/.test(content);
  }
  
  /**
   * Get all text content, optionally without TTS directives
   */
  static getText(response: ChatMessage, stripDirectives: boolean = false): string {
    let content = typeof response.content === 'string'
      ? response.content
      : response.content
          .filter(block => block.type === 'text')
          .map(block => block.text || '')
          .join('\n');
    
    if (stripDirectives) {
      // Remove directive markers but keep text
      content = content.replace(/🎵\[tts:[^\]]+\]/g, '');
    }
    
    return content;
  }
  
  /**
   * Parse directive parameters
   * Format: voiceId=luna,rate=1.0,stability=0.5
   */
  private static parseParams(paramsStr: string): Omit<TTSDirective, 'text'> {
    const params = {
      voiceId: 'en_US-amy-medium',
      rate: 1.0,
      stability: 0.5,
    };
    
    const pairs = paramsStr.split(',');
    for (const pair of pairs) {
      const [key, value] = pair.trim().split('=');
      if (!key || !value) continue;
      
      const lowerKey = key.trim().toLowerCase();
      
      if (lowerKey === 'voiceid') {
        params.voiceId = value.trim();
      } else if (lowerKey === 'rate') {
        params.rate = parseFloat(value.trim()) || 1.0;
      } else if (lowerKey === 'stability') {
        params.stability = parseFloat(value.trim()) || 0.5;
      }
    }
    
    return params;
  }
}
