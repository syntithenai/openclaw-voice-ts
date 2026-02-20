/**
 * Simple logger utility
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export class Logger {
  constructor(
    private namespace: string = 'App',
    private minLevel: LogLevel = 'info'
  ) {}
  
  private shouldLog(level: LogLevel): boolean {
    const levels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
    return levels.indexOf(level) >= levels.indexOf(this.minLevel);
  }
  
  debug(message: string, data?: any): void {
    if (this.shouldLog('debug')) {
      console.debug(`[${this.namespace}]`, message, data || '');
    }
  }
  
  info(message: string, data?: any): void {
    if (this.shouldLog('info')) {
      console.log(`[${this.namespace}]`, message, data || '');
    }
  }
  
  warn(message: string, data?: any): void {
    if (this.shouldLog('warn')) {
      console.warn(`[${this.namespace}]`, message, data || '');
    }
  }
  
  error(message: string, error?: any): void {
    if (this.shouldLog('error')) {
      console.error(`[${this.namespace}]`, message, error || '');
    }
  }
}
