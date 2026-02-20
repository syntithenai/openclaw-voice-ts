import * as dotenv from 'dotenv';
import { VoiceOrchestrator } from './orchestrator';
import { Logger } from './utils/logger';

// Load environment variables
dotenv.config();

const logger = new Logger('Main', process.env.LOG_LEVEL as any || 'info');

async function main() {
  try {
    logger.info('OpenClaw Voice Service starting...');
    
    // Validate required configuration
    const requiredEnvs = [
      'GATEWAY_URL',
      'GATEWAY_HOOK_TOKEN',
      'GATEWAY_AGENT_ID',
    ];
    
    for (const env of requiredEnvs) {
      if (!process.env[env]) {
        throw new Error(`Missing required environment variable: ${env}`);
      }
    }
    
    // Generate session key
    const sessionKey = `${process.env.GATEWAY_SESSION_PREFIX || 'voice:'}${Date.now()}`;
    logger.info(`Session key: ${sessionKey}`);
    
    // Create orchestrator
    const orchestrator = new VoiceOrchestrator({
      sessionKey,
      gatewayUrl: process.env.GATEWAY_URL!,
      gatewayToken: process.env.GATEWAY_HOOK_TOKEN!,
      agentId: process.env.GATEWAY_AGENT_ID!,
      piperUrl: process.env.PIPER_URL,
      audioDevice: process.env.AUDIO_DEVICE,
      sampleRate: process.env.AUDIO_SAMPLE_RATE ? parseInt(process.env.AUDIO_SAMPLE_RATE) : 16000,
    }, logger);
    
    // Handle graceful shutdown
    process.on('SIGINT', () => {
      logger.info('SIGINT received, shutting down...');
      orchestrator.stop();
    });
    
    process.on('SIGTERM', () => {
      logger.info('SIGTERM received, shutting down...');
      orchestrator.stop();
    });
    
    // Start the orchestrator
    await orchestrator.start();
    
    logger.info('Voice service exiting');
    process.exit(0);
    
  } catch (error) {
    logger.error('Fatal error:', error);
    process.exit(1);
  }
}

main();
