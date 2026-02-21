/**
 * Gateway configuration module
 * Loads and validates configuration for different claw providers
 */

import { loadGatewayConfig, createGateway } from '../providers/factory';
import { Logger } from '../utils/logger';

export interface ValidatedGatewayConfig {
  provider: string;
  gatewayUrl: string;
  token: string;
  agentId?: string;
  sessionPrefix: string;
}

/**
 * Load and validate gateway configuration from environment
 * Returns configuration compatible with both old and new systems
 */
export function loadAndValidateGatewayConfig(logger?: Logger): ValidatedGatewayConfig {
  const log = logger || new Logger('GatewayConfig');
  
  // Try to load new multi-provider config first
  try {
    const providerConfig = loadGatewayConfig();
    log.info(`Loading provider: ${providerConfig.provider}`);

    // For OpenClaw, we can use legacy env vars as fallback
    if (providerConfig.provider === 'openclaw') {
      const openclawConfig = providerConfig.openclaw;
      if (!openclawConfig) {
        throw new Error('OpenClaw configuration missing');
      }

      // Provider legacy env vars if new ones aren't set
      const gatewayUrl = openclawConfig.gatewayUrl || process.env.GATEWAY_URL;
      const token = openclawConfig.token || 
                   process.env.GATEWAY_AUTH_TOKEN || 
                   process.env.GATEWAY_TOKEN;
      const agentId = openclawConfig.agentId || process.env.GATEWAY_AGENT_ID;

      if (!gatewayUrl) {
        throw new Error(
          'Missing gateway URL. Set OPENCLAW_GATEWAY_URL or GATEWAY_URL'
        );
      }

      if (!token) {
        throw new Error(
          'Missing gateway token. Set OPENCLAW_GATEWAY_TOKEN or GATEWAY_AUTH_TOKEN'
        );
      }

      return {
        provider: 'openclaw',
        gatewayUrl,
        token,
        agentId: agentId,
        sessionPrefix: providerConfig.sessionIdPrefix || 'voice',
      };
    }

    // For other providers, validate required config based on provider type
    switch (providerConfig.provider) {
      case 'zeroclaw':
        if (!providerConfig.zeroclaw?.gatewayUrl) {
          throw new Error('Missing ZEROCLAW_GATEWAY_URL');
        }
        if (!providerConfig.zeroclaw?.webhookToken) {
          throw new Error('Missing ZEROCLAW_WEBHOOK_TOKEN');
        }
        return {
          provider: 'zeroclaw',
          gatewayUrl: providerConfig.zeroclaw.gatewayUrl,
          token: providerConfig.zeroclaw.webhookToken,
          sessionPrefix: providerConfig.sessionIdPrefix || 'voice',
        };

      case 'tinyclaw':
        if (!providerConfig.tinyclaw?.tinyClawHome) {
          throw new Error('Missing TINYCLAW_HOME');
        }
        return {
          provider: 'tinyclaw',
          gatewayUrl: providerConfig.tinyclaw.tinyClawHome,
          token: '', // Not applicable for TinyClaw
          sessionPrefix: providerConfig.sessionIdPrefix || 'voice',
        };

      case 'ironclaw':
        if (!providerConfig.ironclaw?.gatewayUrl) {
          throw new Error('Missing IRONCLAW_GATEWAY_URL');
        }
        if (!providerConfig.ironclaw?.token) {
          throw new Error('Missing IRONCLAW_GATEWAY_TOKEN');
        }
        return {
          provider: 'ironclaw',
          gatewayUrl: providerConfig.ironclaw.gatewayUrl,
          token: providerConfig.ironclaw.token,
          sessionPrefix: providerConfig.sessionIdPrefix || 'voice',
        };

      case 'mimiclaw':
        if (!providerConfig.mimiclaw?.deviceHost) {
          throw new Error('Missing MIMICLAW_DEVICE_HOST');
        }
        return {
          provider: 'mimiclaw',
          gatewayUrl: `ws://${providerConfig.mimiclaw.deviceHost}:${providerConfig.mimiclaw.devicePort || 18789}`,
          token: '', // Not applicable for MimiClaw
          sessionPrefix: providerConfig.sessionIdPrefix || 'voice',
        };

      default:
        throw new Error(`Unknown provider: ${providerConfig.provider}`);
    }
  } catch (error) {
    log.error('Failed to load gateway configuration:', error);
    throw error;
  }
}

/**
 * Create a gateway instance from environment configuration
 * This allows the orchestrator to switch providers without code changes
 */
export async function createGatewayFromEnv(logger?: Logger) {
  const log = logger || new Logger('GatewayFactory');
  const config = loadGatewayConfig();
  
  try {
    const gateway = createGateway(config);
    
    // Test connectivity
    const health = await gateway.health();
    if (!health.ok) {
      log.warn(`Gateway health check failed: ${health.error}`);
    } else {
      log.info(`Gateway connected: ${gateway.getProviderType()} (latency: ${health.latency}ms)`);
    }
    
    return gateway;
  } catch (error) {
    log.error('Failed to create gateway:', error);
    throw error;
  }
}
