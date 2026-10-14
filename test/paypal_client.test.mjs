import assert from 'node:assert/strict';
import test from 'node:test';
import { PayPalApiClient, PayPalHttpError } from '../src/paypal_client.mjs';

test('PayPal HTTP client defaults to the sandbox origin', () => {
  const client = new PayPalApiClient({
    clientId: 'sandbox-client',
    clientSecret: 'sandbox-secret',
    fetch: async () => {},
  });
  assert.equal(client.environment, 'sandbox');
  assert.equal(client.baseUrl, 'https://api-m.sandbox.paypal.com');
});

test('PayPal environment and API origin cannot be mixed', () => {
  assert.throws(
    () => new PayPalApiClient({
      environment: 'sandbox',
      baseUrl: 'https://api-m.paypal.com',
      clientId: 'sandbox-client',
      clientSecret: 'sandbox-secret',
    }),
    /sandbox client must use/,
  );
  assert.throws(
    () => new PayPalApiClient({
      environment: 'unknown',
      clientId: 'client',
      clientSecret: 'secret',
    }),
    /must be sandbox or live/,
  );
});

test('OAuth rejection is classified as a pre-order PayPal failure', async () => {
  const client = new PayPalApiClient({
    clientId: 'sandbox-client',
    clientSecret: 'sandbox-secret',
    fetch: async () => new Response('{}', { status: 401 }),
  });
  await assert.rejects(
    () => client.getAccessToken(),
    (error) => error instanceof PayPalHttpError
      && error.phase === 'oauth'
      && error.status === 401,
  );
});

test('Orders API rejection retains status and phase for safe retry classification', async () => {
  let calls = 0;
  const client = new PayPalApiClient({
    clientId: 'sandbox-client',
    clientSecret: 'sandbox-secret',
    fetch: async () => {
      calls += 1;
      if (calls === 1) return new Response('{"access_token":"token"}', { status: 200 });
      return new Response('{}', { status: 422, headers: { 'paypal-debug-id': 'debug-1' } });
    },
  });
  await assert.rejects(
    () => client.createOrder({
      amountMinor: 1_000,
      currency: 'USD',
      description: 'Inference credits',
      referenceId: 'reservation-1',
      requestId: 'request-1',
    }),
    (error) => error instanceof PayPalHttpError
      && error.phase === 'api'
      && error.status === 422
      && error.debugId === 'debug-1',
  );
});
