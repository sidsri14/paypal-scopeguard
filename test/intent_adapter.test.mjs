import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentPayPalController } from '../src/agent_paypal_controller.mjs';
import {
  OpenAICompatibleIntentAdapter,
  validatePurchaseIntent,
} from '../src/intent_adapter.mjs';
import { InMemoryPayPalClient } from '../src/paypal_client.mjs';
import { ScopeGuardService } from '../src/scopeguard_service.mjs';

const allowed = {
  allowedCurrencies: ['USD'],
  allowedMerchantCategories: ['AI_INFERENCE', 'DEVELOPER_TOOLS'],
};

function aiResponse(content) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('AI adapter requests strict structured output and validates the result', async () => {
  let captured;
  const adapter = new OpenAICompatibleIntentAdapter({
    apiKey: 'test-key',
    model: 'test-model',
    baseUrl: 'https://ai.example.test/v1',
    ...allowed,
    fetch: async (url, init) => {
      captured = { url, init };
      return aiResponse(JSON.stringify({
        amountMinor: 1_200,
        currency: 'USD',
        merchantCategory: 'AI_INFERENCE',
        purpose: 'Purchase inference credits',
      }));
    },
  });

  const intent = await adapter.interpret('Buy exactly $12 of inference credits.');
  assert.deepEqual(intent, {
    amountMinor: 1_200,
    currency: 'USD',
    merchantCategory: 'AI_INFERENCE',
    purpose: 'Purchase inference credits',
  });
  assert.equal(captured.url, 'https://ai.example.test/v1/chat/completions');
  assert.equal(captured.init.headers.Authorization, 'Bearer test-key');

  const body = JSON.parse(captured.init.body);
  assert.equal(body.response_format.type, 'json_schema');
  assert.equal(body.response_format.json_schema.strict, true);
  assert.equal(body.response_format.json_schema.schema.additionalProperties, false);
  assert.deepEqual(JSON.parse(body.messages[1].content), {
    purchaseRequest: 'Buy exactly $12 of inference credits.',
  });
});

test('schema validation rejects unsafe or ambiguous model output', () => {
  assert.throws(
    () => validatePurchaseIntent({
      amountMinor: 10.5,
      currency: 'USD',
      merchantCategory: 'AI_INFERENCE',
      purpose: 'Fractional minor units',
    }, allowed),
    /positive safe integer/,
  );
  assert.throws(
    () => validatePurchaseIntent({
      amountMinor: 500,
      currency: 'USD',
      merchantCategory: 'GAMBLING',
      purpose: 'Disallowed category',
    }, allowed),
    /merchant category is not enabled/,
  );
  assert.throws(
    () => validatePurchaseIntent({
      amountMinor: 500,
      currency: 'USD',
      merchantCategory: 'AI_INFERENCE',
      purpose: 'Has an extra field',
      approvalUrl: 'https://attacker.example',
    }, allowed),
    /unexpected field/,
  );
});

test('adapter rejects Markdown-wrapped JSON and oversized untrusted input', async () => {
  const adapter = new OpenAICompatibleIntentAdapter({
    apiKey: 'test-key',
    model: 'test-model',
    ...allowed,
    fetch: async () => aiResponse('```json\n{"amountMinor": 500}\n```'),
  });

  await assert.rejects(() => adapter.interpret('Buy credits'), /without Markdown fences/);
  await assert.rejects(() => adapter.interpret('x'.repeat(2_001)), /at most 2000/);
});

test('service deduplicates AI and PayPal calls for one client request ID', async () => {
  let aiCalls = 0;
  const client = new InMemoryPayPalClient({ createDelayMs: 10 });
  const controller = new AgentPayPalController({
    agentId: 'ai-test-agent',
    maxPerTransactionMinor: 1_500,
    maxWindowMinor: 4_000,
    allowedMerchantCategories: allowed.allowedMerchantCategories,
    client,
  });
  const service = new ScopeGuardService({
    controller,
    intentAdapter: {
      async interpret() {
        aiCalls += 1;
        return {
          amountMinor: 1_000,
          currency: 'USD',
          merchantCategory: 'AI_INFERENCE',
          purpose: 'Inference credits',
        };
      },
    },
  });
  const request = { clientRequestId: 'same-request', instruction: 'Buy $10 of inference credits' };

  const [first, duplicate] = await Promise.all([
    service.proposeFromInstruction(request),
    service.proposeFromInstruction(request),
  ]);
  assert.deepEqual(duplicate, first);
  assert.equal(aiCalls, 1);
  assert.equal(client.createCalls, 1);
  assert.equal(first.proposal.status, 'PENDING_BUYER_APPROVAL');
});

test('service rejects request-ID conflicts and policy still denies model output', async () => {
  const client = new InMemoryPayPalClient();
  const controller = new AgentPayPalController({
    agentId: 'ai-policy-test-agent',
    maxPerTransactionMinor: 1_500,
    maxWindowMinor: 4_000,
    allowedMerchantCategories: allowed.allowedMerchantCategories,
    client,
  });
  const service = new ScopeGuardService({
    controller,
    intentAdapter: {
      async interpret() {
        return {
          amountMinor: 2_000,
          currency: 'USD',
          merchantCategory: 'AI_INFERENCE',
          purpose: 'An amount above the deterministic policy ceiling',
        };
      },
    },
  });

  const denied = await service.proposeFromInstruction({
    clientRequestId: 'policy-denial',
    instruction: 'Buy $20 in credits',
  });
  assert.equal(denied.proposal.error, 'EXCEEDS_PER_TRANSACTION_LIMIT');
  assert.equal(client.createCalls, 0);
  assert.throws(
    () => service.proposeFromInstruction({
      clientRequestId: 'policy-denial',
      instruction: 'Buy a different amount',
    }),
    /reused with different request content/,
  );
});

test('remote AI endpoints must use HTTPS', () => {
  assert.throws(
    () => new OpenAICompatibleIntentAdapter({
      apiKey: 'test-key',
      model: 'test-model',
      baseUrl: 'http://ai.example.test/v1',
      ...allowed,
    }),
    /must use HTTPS/,
  );
});
