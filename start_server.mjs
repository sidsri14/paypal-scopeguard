import { AgentPayPalController } from './src/agent_paypal_controller.mjs';
import { OpenAICompatibleIntentAdapter } from './src/intent_adapter.mjs';
import { ScopeGuardService } from './src/scopeguard_service.mjs';
import { createScopeGuardServer } from './src/server.mjs';

const host = process.env.HOST || '127.0.0.1';
const port = Number.parseInt(process.env.PORT || '8787', 10);
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error('PORT is invalid');
if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
  throw new Error('ScopeGuard binds to loopback only; use a separate authenticated gateway for remote access');
}

const appBaseUrl = process.env.APP_BASE_URL || `http://${host}:${port}`;
const allowedMerchantCategories = [
  'AI_INFERENCE',
  'CLOUD_COMPUTE',
  'DEVELOPER_TOOLS',
  'DATA_FEEDS',
];
const controller = new AgentPayPalController({
  agentId: process.env.AGENT_ID || 'scopeguard-demo-agent',
  maxPerTransactionMinor: Number.parseInt(process.env.MAX_PER_TRANSACTION_MINOR || '2500', 10),
  maxWindowMinor: Number.parseInt(process.env.MAX_WINDOW_MINOR || '10000', 10),
  allowedMerchantCategories,
  paypal: {
    clientId: process.env.PAYPAL_CLIENT_ID,
    clientSecret: process.env.PAYPAL_CLIENT_SECRET,
    environment: 'sandbox',
  },
});
const intentAdapter = new OpenAICompatibleIntentAdapter({
  allowedCurrencies: ['USD'],
  allowedMerchantCategories,
});
const service = new ScopeGuardService({ controller, intentAdapter });
const server = createScopeGuardServer({ service, controller, appBaseUrl });

server.listen(port, host, () => {
  console.log(`PayPal ScopeGuard listening at ${appBaseUrl}`);
  console.log('Sandbox mode: an approved PayPal order still requires an explicit capture click.');
});
