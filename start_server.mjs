import { fileURLToPath } from 'node:url';
import { AgentPayPalController } from './src/agent_paypal_controller.mjs';
import { OpenAICompatibleIntentAdapter } from './src/intent_adapter.mjs';
import { InMemoryPayPalClient } from './src/paypal_client.mjs';
import { PayPalWebhookVerifier } from './src/paypal_webhook_verifier.mjs';
import { ScopeGuardService } from './src/scopeguard_service.mjs';
import { createScopeGuardServer } from './src/server.mjs';
import { SimulatedIntentAdapter } from './src/simulated_adapter.mjs';
import { JsonFileStateStore } from './src/state_store.mjs';

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

const hasPayPalKeys = Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);
const hasAiKeys = Boolean(process.env.AI_API_KEY && process.env.AI_MODEL);
const stateStore = new JsonFileStateStore(
  process.env.SCOPEGUARD_STATE_FILE
    || fileURLToPath(new URL('./data/scopeguard-state.json', import.meta.url)),
);
const initialState = await stateStore.load();

const mockClient = hasPayPalKeys ? undefined : new InMemoryPayPalClient();

const controller = new AgentPayPalController({
  agentId: process.env.AGENT_ID || 'scopeguard-demo-agent',
  maxPerTransactionMinor: Number.parseInt(process.env.MAX_PER_TRANSACTION_MINOR || '2500', 10),
  maxWindowMinor: Number.parseInt(process.env.MAX_WINDOW_MINOR || '10000', 10),
  allowedMerchantCategories,
  stateStore,
  initialState,
  client: mockClient,
  paypal: hasPayPalKeys
    ? {
        clientId: process.env.PAYPAL_CLIENT_ID,
        clientSecret: process.env.PAYPAL_CLIENT_SECRET,
        environment: 'sandbox',
      }
    : undefined,
});

const webhookVerifier = process.env.PAYPAL_WEBHOOK_ID && hasPayPalKeys
  ? new PayPalWebhookVerifier({
      webhookId: process.env.PAYPAL_WEBHOOK_ID,
      environment: 'sandbox',
    })
  : undefined;

const intentAdapter = hasAiKeys
  ? new OpenAICompatibleIntentAdapter({
      allowedCurrencies: ['USD'],
      allowedMerchantCategories,
    })
  : new SimulatedIntentAdapter({
      allowedCurrencies: ['USD'],
      allowedMerchantCategories,
    });

const service = new ScopeGuardService({ controller, intentAdapter });
const server = createScopeGuardServer({ service, controller, webhookVerifier, appBaseUrl });

server.listen(port, host, () => {
  console.log(`PayPal ScopeGuard listening at ${appBaseUrl}`);
  if (!hasPayPalKeys || !hasAiKeys) {
    console.log('Mode: Local Simulation & Evaluation Mode (Zero API keys required)');
  } else {
    console.log('Mode: Live PayPal Sandbox + OpenAI Integration Mode');
  }
  console.log('Sandbox security: an approved PayPal order still requires an explicit capture click.');
  console.log(`Restart-safe state: ${stateStore.filePath}`);
  if (!webhookVerifier) {
    console.log('Webhook verification: disabled until PayPal keys and PAYPAL_WEBHOOK_ID are set.');
  }
});
