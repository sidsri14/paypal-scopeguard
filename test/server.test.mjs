import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { createScopeGuardServer } from '../src/server.mjs';

test('loopback server exposes UI, health, proposal, and capture routes', async (context) => {
  const service = {
    async proposeFromInstruction(request) {
      return {
        intent: {
          amountMinor: 1_200,
          currency: 'USD',
          merchantCategory: 'AI_INFERENCE',
          purpose: 'Inference credits',
        },
        proposal: {
          success: true,
          status: 'PENDING_BUYER_APPROVAL',
          orderId: 'ORDER-1',
          approvalUrl: 'https://sandbox.paypal.test/approve/ORDER-1',
          request,
        },
      };
    },
  };
  const controller = {
    async captureApprovedOrder(orderId) {
      return { success: true, status: 'COMPLETED', orderId };
    },
  };
  const server = createScopeGuardServer({
    service,
    controller,
    appBaseUrl: 'http://127.0.0.1:8787',
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const page = await fetch(baseUrl);
  assert.equal(page.status, 200);
  const pageBody = await page.text();
  assert.match(pageBody, /AI can propose\. Policy and the buyer decide\./);
  assert.match(pageBody, /Check PayPal order status/);
  assert.doesNotMatch(pageBody, /immutable ledger/i);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);

  const health = await fetch(`${baseUrl}/health`).then((response) => response.json());
  assert.deepEqual(health, { status: 'ok', paypalEnvironment: 'sandbox' });

  const proposal = await fetch(`${baseUrl}/api/proposals`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientRequestId: 'web-1', instruction: 'Buy $12 of credits' }),
  }).then((response) => response.json());
  assert.equal(proposal.proposal.status, 'PENDING_BUYER_APPROVAL');
  assert.equal(proposal.proposal.request.returnUrl, 'http://127.0.0.1:8787/?paypal=approved');

  const capture = await fetch(`${baseUrl}/api/capture`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderId: 'ORDER-1' }),
  }).then((response) => response.json());
  assert.equal(capture.status, 'COMPLETED');
});

test('loopback server rejects non-JSON API requests', async (context) => {
  const server = createScopeGuardServer({
    service: { proposeFromInstruction() {} },
    controller: { captureApprovedOrder() {} },
    appBaseUrl: 'http://127.0.0.1:8787',
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(() => server.close());

  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/proposals`, {
    method: 'POST',
    body: 'not json',
  });
  assert.equal(response.status, 415);
  assert.equal((await response.json()).error, 'INVALID_REQUEST');
});

test('loopback server rejects cross-origin mutation requests', async (context) => {
  const server = createScopeGuardServer({
    service: { proposeFromInstruction() {} },
    controller: { captureApprovedOrder() {} },
    appBaseUrl: 'http://127.0.0.1:8787',
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(() => server.close());

  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/proposals`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://attacker.example',
    },
    body: JSON.stringify({ clientRequestId: 'cross-site', instruction: 'Buy credits' }),
  });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).message, 'Request origin is not allowed');
});

test('webhook route rejects invalid signatures before dispatch', async (context) => {
  let handled = false;
  const server = createScopeGuardServer({
    service: { proposeFromInstruction() {} },
    controller: {
      captureApprovedOrder() {},
      handlePayPalWebhook() {
        handled = true;
      },
    },
    webhookVerifier: { async verify() { return false; } },
    appBaseUrl: 'http://127.0.0.1:8787',
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(() => server.close());

  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/paypal/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'WH-INVALID' }),
  });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, 'INVALID_WEBHOOK_SIGNATURE');
  assert.equal(handled, false);
});

test('verified webhook and reconciliation routes dispatch to the controller', async (context) => {
  let verifiedRawBody;
  const server = createScopeGuardServer({
    service: { proposeFromInstruction() {} },
    controller: {
      captureApprovedOrder() {},
      async reconcileOrder(orderId) {
        return { success: true, status: 'AWAITING_EXPLICIT_CAPTURE', orderId };
      },
      async handlePayPalWebhook(event) {
        return { success: true, status: 'IGNORED_EVENT', eventId: event.id };
      },
    },
    webhookVerifier: {
      async verify(rawBody) {
        verifiedRawBody = rawBody;
        return true;
      },
    },
    appBaseUrl: 'http://127.0.0.1:8787',
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const rawEvent = '{"id":"WH-VALID","event_type":"UNUSED"}';
  const webhook = await fetch(`${baseUrl}/api/paypal/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: rawEvent,
  });
  assert.equal(webhook.status, 200);
  assert.equal((await webhook.json()).eventId, 'WH-VALID');
  assert.equal(verifiedRawBody.toString('utf8'), rawEvent);

  const reconciliation = await fetch(`${baseUrl}/api/reconcile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderId: 'ORDER-1' }),
  });
  assert.equal(reconciliation.status, 200);
  assert.equal((await reconciliation.json()).status, 'AWAITING_EXPLICIT_CAPTURE');
});
