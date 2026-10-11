import assert from 'node:assert/strict';
import { AgentPayPalController } from '../src/agent_paypal_controller.mjs';
import { InMemoryPayPalClient } from '../src/paypal_client.mjs';
import { AgentSpendPolicy } from '../src/policy.mjs';

function makeController(overrides = {}) {
  const client = overrides.client || new InMemoryPayPalClient();
  return {
    client,
    controller: new AgentPayPalController({
      agentId: 'test-agent',
      maxPerTransactionMinor: 1_500,
      maxWindowMinor: 4_000,
      allowedMerchantCategories: ['AI_INFERENCE', 'CLOUD_COMPUTE'],
      client,
      ...overrides,
    }),
  };
}

function request(id, overrides = {}) {
  return {
    clientRequestId: id,
    amountMinor: 1_000,
    currency: 'USD',
    merchantCategory: 'AI_INFERENCE',
    purpose: 'Inference credit purchase',
    ...overrides,
  };
}

async function runTests() {
  console.log('Starting PayPal ScopeGuard tests');

  {
    const { controller, client } = makeController();
    const proposal = await controller.proposePayment(request('valid-proposal'));
    assert.equal(proposal.status, 'PENDING_BUYER_APPROVAL');
    assert.match(proposal.approvalUrl, /^https:\/\/sandbox\.example\.test\/approve\//);
    assert.equal(controller.policy.committedMinor, 0);
    assert.equal(controller.policy.getReservedMinor(), 1_000);
    assert.equal(client.captureCalls, 0);

    const premature = await controller.captureApprovedOrder(proposal.orderId);
    assert.equal(premature.error, 'BUYER_APPROVAL_REQUIRED');
    assert.equal(client.captureCalls, 0);
    assert.equal(controller.policy.committedMinor, 0);

    client.approveOrder(proposal.orderId);
    const [firstCapture, duplicateCapture] = await Promise.all([
      controller.captureApprovedOrder(proposal.orderId),
      controller.captureApprovedOrder(proposal.orderId),
    ]);
    assert.equal(firstCapture.status, 'COMPLETED');
    assert.deepEqual(duplicateCapture, firstCapture);
    assert.equal(client.captureCalls, 1);
    assert.equal(controller.policy.committedMinor, 1_000);
    assert.equal(controller.policy.getReservedMinor(), 0);
    console.log('ok - buyer approval is required before one idempotent capture');
  }

  {
    const { controller } = makeController();
    const tooLarge = await controller.proposePayment(
      request('too-large', { amountMinor: 1_501 }),
    );
    assert.equal(tooLarge.error, 'EXCEEDS_PER_TRANSACTION_LIMIT');

    const category = await controller.proposePayment(
      request('bad-category', { merchantCategory: 'GAMBLING' }),
    );
    assert.equal(category.error, 'MERCHANT_CATEGORY_NOT_PERMITTED');
    assert.equal(controller.policy.getReservedMinor(), 0);
    console.log('ok - transaction and merchant policy denials are fail-closed');
  }

  {
    const client = new InMemoryPayPalClient({ createDelayMs: 25 });
    const { controller } = makeController({ client, maxWindowMinor: 1_500 });
    const [first, second] = await Promise.all([
      controller.proposePayment(request('race-one', { amountMinor: 1_000 })),
      controller.proposePayment(request('race-two', { amountMinor: 1_000 })),
    ]);
    assert.equal(first.success, true);
    assert.equal(second.error, 'EXCEEDS_WINDOW_LIMIT');
    assert.equal(client.createCalls, 1);
    assert.equal(controller.policy.getReservedMinor(), 1_000);
    console.log('ok - synchronous reservations prevent concurrent overspend');
  }

  {
    const client = new InMemoryPayPalClient();
    client.failNextCreate = true;
    const { controller } = makeController({ client });
    const failed = await controller.proposePayment(request('create-failure'));
    assert.equal(failed.error, 'PAYPAL_ORDER_CREATE_FAILED');
    assert.equal(controller.policy.getReservedMinor(), 0);
    assert.equal(controller.policy.getRemainingMinor(), 4_000);
    console.log('ok - failed order creation releases its reservation');
  }

  {
    const { controller, client } = makeController();
    const first = await controller.proposePayment(request('deduplicated'));
    const replay = await controller.proposePayment(request('deduplicated'));
    assert.deepEqual(replay, first);
    assert.equal(client.createCalls, 1);
    assert.equal(controller.policy.getReservedMinor(), 1_000);
    console.log('ok - client request IDs deduplicate order creation');
  }

  {
    const { controller } = makeController();
    assert.throws(
      () => controller.proposePayment(request('float-money', { amountMinor: 10.5 })),
      /positive safe integer/,
    );
    assert.throws(
      () => controller.proposePayment(request('bad-currency', { currency: 'JPY' })),
      /currency is not enabled/,
    );
    assert.throws(
      () => controller.proposePayment(request('bad-return-url', {
        returnUrl: 'http://example.com/approved',
        cancelUrl: 'http://example.com/cancelled',
      })),
      /must use HTTPS/,
    );
    console.log('ok - money and currency inputs are explicit');
  }

  {
    const { controller } = makeController();
    controller.emergencyRevoke();
    const denied = await controller.proposePayment(request('revoked'));
    assert.equal(denied.error, 'AGENT_POLICY_REVOKED');
    controller.reinstatePolicy();
    const accepted = await controller.proposePayment(request('reinstated'));
    assert.equal(accepted.success, true);
    console.log('ok - emergency revocation and reinstatement work');
  }

  {
    const { controller } = makeController();
    const proposal = await controller.proposePayment(request('abandon'));
    const abandoned = await controller.cancelPendingOrder(proposal.orderId);
    assert.equal(abandoned.status, 'ABANDONED');
    assert.equal(controller.policy.getReservedMinor(), 0);
    assert.equal(controller.policy.getRemainingMinor(), 4_000);
    console.log('ok - abandoning an unapproved order releases its reservation');
  }

  {
    let now = 0;
    const policy = new AgentSpendPolicy({
      agentId: 'rollover-test',
      maxPerTransactionMinor: 1_000,
      maxWindowMinor: 2_000,
      windowDurationMs: 100,
      clock: () => now,
    });
    assert.equal(policy.reserve({ amountMinor: 1_000 }, 'pending').approved, true);
    now = 101;
    assert.equal(policy.getReservedMinor(), 1_000);
    assert.equal(policy.getRemainingMinor(), 1_000);
    console.log('ok - pending orders retain reservations across window rollover');
  }

  console.log('All PayPal ScopeGuard tests passed');
}

runTests().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
