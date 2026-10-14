import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AgentPayPalController } from '../src/agent_paypal_controller.mjs';
import { InMemoryPayPalClient } from '../src/paypal_client.mjs';
import { JsonFileStateStore } from '../src/state_store.mjs';

class MemoryStateStore {
  async save(state) {
    this.state = structuredClone(state);
  }
}

function request(id) {
  return {
    clientRequestId: id,
    amountMinor: 1_000,
    currency: 'USD',
    merchantCategory: 'AI_INFERENCE',
    purpose: 'Inference credit purchase',
  };
}

function controller(client, options = {}) {
  return new AgentPayPalController({
    agentId: 'durability-test-agent',
    maxPerTransactionMinor: 1_500,
    maxWindowMinor: 4_000,
    allowedMerchantCategories: ['AI_INFERENCE'],
    client,
    ...options,
  });
}

test('JSON state store atomically replaces snapshots and leaves no temp files', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'scopeguard-state-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'nested', 'state.json');
  const store = new JsonFileStateStore(filePath);
  assert.equal(await store.load(), null);
  await store.save({ version: 1, value: 'first' });
  await store.save({ version: 1, value: 'second' });
  assert.deepEqual(await store.load(), { version: 1, value: 'second' });
  assert.equal((await readFile(filePath, 'utf8')).endsWith('\n'), true);
  assert.deepEqual(await readdir(path.dirname(filePath)), ['state.json']);
});

test('pending reservations survive restart and settle exactly once', async () => {
  const client = new InMemoryPayPalClient();
  const store = new MemoryStateStore();
  const firstController = controller(client, { stateStore: store });
  const proposal = await firstController.proposePayment(request('restart-order'));
  assert.equal(store.state.policy.reservations.length, 1);

  const restarted = controller(client, { stateStore: store, initialState: store.state });
  assert.equal(restarted.policy.getReservedMinor(), 1_000);
  client.approveOrder(proposal.orderId);
  const settled = await restarted.captureApprovedOrder(proposal.orderId);
  assert.equal(settled.status, 'COMPLETED');
  assert.equal(restarted.policy.committedMinor, 1_000);
  assert.equal(restarted.policy.getReservedMinor(), 0);

  const replay = await restarted.reconcileOrder(proposal.orderId);
  assert.deepEqual(replay, settled);
  assert.equal(restarted.policy.committedMinor, 1_000);
});

test('ambiguous create keeps its reservation and resumes with the stable request ID', async () => {
  const client = new InMemoryPayPalClient();
  client.failAfterNextCreate = true;
  const store = new MemoryStateStore();
  const app = controller(client, { stateStore: store });
  const uncertain = await app.proposePayment(request('lost-create-response'));
  assert.equal(uncertain.status, 'ORDER_CREATE_UNCERTAIN');
  assert.equal(app.policy.getReservedMinor(), 1_000);
  assert.equal(client.orders.size, 1);

  const recovered = await app.proposePayment(request('lost-create-response'));
  assert.equal(recovered.status, 'PENDING_BUYER_APPROVAL');
  assert.equal(client.orders.size, 1);
  assert.equal(app.policy.getReservedMinor(), 1_000);
});

test('definitive create rejection releases its reservation', async () => {
  const client = new InMemoryPayPalClient();
  client.failNextCreate = true;
  const app = controller(client, { stateStore: new MemoryStateStore() });
  const failed = await app.proposePayment(request('definitive-create-failure'));
  assert.equal(failed.status, 'ORDER_CREATE_FAILED');
  assert.equal(app.policy.getReservedMinor(), 0);
});

test('lost capture response is reconciled from PayPal without a second capture', async () => {
  const client = new InMemoryPayPalClient();
  const app = controller(client, { stateStore: new MemoryStateStore() });
  const proposal = await app.proposePayment(request('lost-capture-response'));
  client.approveOrder(proposal.orderId);
  client.failAfterNextCapture = true;

  const uncertain = await app.captureApprovedOrder(proposal.orderId);
  assert.equal(uncertain.status, 'CAPTURE_OUTCOME_UNCERTAIN');
  assert.equal(app.policy.getReservedMinor(), 1_000);
  assert.equal(client.captureCalls, 1);

  const reconciled = await app.reconcileOrder(proposal.orderId);
  assert.equal(reconciled.status, 'COMPLETED');
  assert.equal(app.policy.committedMinor, 1_000);
  assert.equal(client.captureCalls, 1);
});

test('approved order and approval webhook never trigger capture automatically', async () => {
  const client = new InMemoryPayPalClient();
  const app = controller(client, { stateStore: new MemoryStateStore() });
  const proposal = await app.proposePayment(request('approval-only'));
  client.approveOrder(proposal.orderId);

  const reconciliation = await app.reconcileOrder(proposal.orderId);
  assert.equal(reconciliation.status, 'AWAITING_EXPLICIT_CAPTURE');
  const webhook = await app.handlePayPalWebhook({
    id: 'WH-APPROVED-1',
    event_type: 'CHECKOUT.ORDER.APPROVED',
    resource: { id: proposal.orderId },
  });
  assert.equal(webhook.status, 'AWAITING_EXPLICIT_CAPTURE');
  assert.equal(client.captureCalls, 0);

  const duplicate = await app.handlePayPalWebhook({
    id: 'WH-APPROVED-1',
    event_type: 'CHECKOUT.ORDER.APPROVED',
    resource: { id: proposal.orderId },
  });
  assert.equal(duplicate.status, 'DUPLICATE_EVENT');
  assert.equal(client.captureCalls, 0);
});

test('completed capture webhook reconciles the reserved order once', async () => {
  const client = new InMemoryPayPalClient();
  const app = controller(client, { stateStore: new MemoryStateStore() });
  const proposal = await app.proposePayment(request('webhook-capture'));
  client.approveOrder(proposal.orderId);
  await client.captureOrder(proposal.orderId, 'external-capture-idempotency-key');

  const event = {
    id: 'WH-CAPTURE-1',
    event_type: 'PAYMENT.CAPTURE.COMPLETED',
    resource: { supplementary_data: { related_ids: { order_id: proposal.orderId } } },
  };
  const result = await app.handlePayPalWebhook(event);
  assert.equal(result.status, 'COMPLETED');
  assert.equal(app.policy.committedMinor, 1_000);
  assert.equal((await app.handlePayPalWebhook(event)).status, 'DUPLICATE_EVENT');
  assert.equal(app.policy.committedMinor, 1_000);
});
