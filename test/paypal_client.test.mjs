import assert from 'node:assert/strict';
import test from 'node:test';
import { PayPalApiClient } from '../src/paypal_client.mjs';

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
