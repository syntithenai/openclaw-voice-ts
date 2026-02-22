/**
 * Gateway factory - creates appropriate provider instance based on configuration
 */

import { ClawGateway, ClawProviderType } from './claw-gateway';
import { OpenClawGateway, OpenClawConfig } from './gateways/openclaw';
import { ZeroClawGateway, ZeroClawConfig } from './gateways/zeroclaw';
import { TinyClawGateway, TinyClawConfig } from './gateways/tinyclaw';
import { IronClawGateway, IronClawConfig } from './gateways/ironclaw';
import { MimiClawGateway, MimiClawConfig } from './gateways/mimiclaw';
import { PicoClawGateway, PicoClawConfig } from './gateways/picoclaw';
import { NanoBotGateway, NanoBotConfig } from './gateways/nanobot';

export interface GatewayConfig {
  provider: ClawProviderType;
  timeout?: number;
  sessionIdPrefix?: string;
  
  // OpenClaw
  openclaw?: OpenClawConfig;
  
  // ZeroClaw
  zeroclaw?: ZeroClawConfig;
  
  // TinyClaw
  tinyclaw?: TinyClawConfig;
  
  // IronClaw
  ironclaw?: IronClawConfig;
  
  // MimiClaw
  mimiclaw?: MimiClawConfig;
  
  // PicoClaw
  picoclaw?: PicoClawConfig;
  
  // NanoBot
  nanobot?: NanoBotConfig;
}

/**
 * Create a gateway instance for the specified provider
 */
export function createGateway(config: GatewayConfig): ClawGateway {
  switch (config.provider) {
    case 'openclaw':
      if (!config.openclaw) {
        throw new Error('OpenClaw configuration missing');
      }
      return new OpenClawGateway({
        timeout: config.timeout,
        ...config.openclaw,
      });

    case 'zeroclaw':
      if (!config.zeroclaw) {
        throw new Error('ZeroClaw configuration missing');
      }
      return new ZeroClawGateway({
        timeout: config.timeout,
        ...config.zeroclaw,
      });

    case 'tinyclaw':
      if (!config.tinyclaw) {
        throw new Error('TinyClaw configuration missing');
      }
      return new TinyClawGateway({
        timeout: config.timeout,
        ...config.tinyclaw,
      });

    case 'ironclaw':
      if (!config.ironclaw) {
        throw new Error('IronClaw configuration missing');
      }
      return new IronClawGateway({
        timeout: config.timeout,
        ...config.ironclaw,
      });

    case 'mimiclaw':
      if (!config.mimiclaw) {
        throw new Error('MimiClaw configuration missing');
      }
      return new MimiClawGateway({
        timeout: config.timeout,
        ...config.mimiclaw,
      });

    case 'picoclaw':
      if (!config.picoclaw) {
        throw new Error('PicoClaw configuration missing');
      }
      return new PicoClawGateway({
        timeout: config.timeout,
        ...config.picoclaw,
      });

    case 'nanobot':
      if (!config.nanobot) {
        throw new Error('NanoBot configuration missing');
      }
      return new NanoBotGateway({
        timeout: config.timeout,
        ...config.nanobot,
      });

    default:
      throw new Error(`Unknown provider: ${config.provider}`);
  }
}

/**
 * Load gateway configuration from environment variables
 */
export function loadGatewayConfig(): GatewayConfig {
  const provider = (process.env.VOICE_CLAW_PROVIDER || 'openclaw') as ClawProviderType;

  const baseConfig: GatewayConfig = {
    provider,
    timeout: process.env.VOICE_GATEWAY_TIMEOUT
      ? parseInt(process.env.VOICE_GATEWAY_TIMEOUT, 10)
      : 30000,
    sessionIdPrefix: process.env.VOICE_SESSION_PREFIX || 'voice',
  };

  switch (provider) {
    case 'openclaw':
      baseConfig.openclaw = {
        gatewayUrl: process.env.OPENCLAW_GATEWAY_URL || 'http://localhost:18789',
        token: process.env.OPENCLAW_GATEWAY_TOKEN || process.env.GATEWAY_AUTH_TOKEN || '',
        agentId: process.env.OPENCLAW_AGENT_ID || process.env.GATEWAY_AGENT_ID,
      };
      break;

    case 'zeroclaw':
      baseConfig.zeroclaw = {
        gatewayUrl: process.env.ZEROCLAW_GATEWAY_URL || 'http://localhost:3000',
        webhookToken: process.env.ZEROCLAW_WEBHOOK_TOKEN || '',
        channel: 'voice',
      };
      break;

    case 'tinyclaw':
      baseConfig.tinyclaw = {
        tinyClawHome: process.env.TINYCLAW_HOME || `${process.env.HOME}/.tinyclaw`,
      };
      break;

    case 'ironclaw':
      baseConfig.ironclaw = {
        gatewayUrl: process.env.IRONCLAW_GATEWAY_URL || 'http://localhost:8888',
        token: process.env.IRONCLAW_GATEWAY_TOKEN || '',
        useWebSocket: process.env.IRONCLAW_USE_WEBSOCKET === 'true',
      };
      break;

    case 'mimiclaw':
      baseConfig.mimiclaw = {
        deviceHost: process.env.MIMICLAW_DEVICE_HOST || 'localhost',
        devicePort: process.env.MIMICLAW_DEVICE_PORT
          ? parseInt(process.env.MIMICLAW_DEVICE_PORT, 10)
          : 18789,
        useWebSocket: process.env.MIMICLAW_USE_WEBSOCKET !== 'false',
      };
      break;

    case 'picoclaw':
      baseConfig.picoclaw = {
        workspaceHome: process.env.PICOCLAW_HOME || `${process.env.HOME}/.picoclaw/workspace`,
        gatewayUrl: process.env.PICOCLAW_GATEWAY_URL,
        agentId: process.env.PICOCLAW_AGENT_ID,
      };
      break;

    case 'nanobot':
      baseConfig.nanobot = {
        workspaceHome: process.env.NANOBOT_HOME || `${process.env.HOME}/.nanobot`,
        gatewayUrl: process.env.NANOBOT_GATEWAY_URL || process.env.NANOBOT_GATEWAY_URL || 'http://localhost:18790',
        agentId: process.env.NANOBOT_AGENT_ID,
      };
      break;
  }

  return baseConfig;
}
