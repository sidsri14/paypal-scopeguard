import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {
  computeCrc32,
  PayPalWebhookVerifier,
} from '../src/paypal_webhook_verifier.mjs';

test('webhook verifier authenticates the exact raw payload and caches the PayPal key', async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
  const rawBody = Buffer.from('{"id":"WH-1","event_type":"PAYMENT.CAPTURE.COMPLETED"}');
  const headers = {
    'paypal-auth-algo': 'SHA256withRSA',
    'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-TEST',
    'paypal-transmission-id': 'transmission-1',
    'paypal-transmission-time': '2026-10-14T10:00:00Z',
  };
  const message = `${headers['paypal-transmission-id']}|${headers['paypal-transmission-time']}|WEBHOOK-1|${computeCrc32(rawBody)}`;
  headers['paypal-transmission-sig'] = crypto.sign('sha256', Buffer.from(message), privateKey).toString('base64');
  let fetchCalls = 0;
  const verifier = new PayPalWebhookVerifier({
    webhookId: 'WEBHOOK-1',
    fetch: async () => {
      fetchCalls += 1;
      return new Response(publicPem, { status: 200 });
    },
  });

  assert.equal(await verifier.verify(rawBody, headers), true);
  assert.equal(await verifier.verify(rawBody, headers), true);
  assert.equal(fetchCalls, 1);
  assert.equal(await verifier.verify(Buffer.from(`${rawBody} `), headers), false);
});

test('webhook verifier rejects missing headers and non-PayPal certificate URLs', async () => {
  let fetchCalls = 0;
  const verifier = new PayPalWebhookVerifier({
    webhookId: 'WEBHOOK-1',
    fetch: async () => {
      fetchCalls += 1;
      return new Response('unexpected');
    },
  });
  assert.equal(await verifier.verify(Buffer.from('{}'), {}), false);
  assert.equal(await verifier.verify(Buffer.from('{}'), {
    'paypal-auth-algo': 'SHA256withRSA',
    'paypal-cert-url': 'https://attacker.example/v1/notifications/certs/CERT-TEST',
    'paypal-transmission-id': 'id',
    'paypal-transmission-sig': 'sig',
    'paypal-transmission-time': 'time',
  }), false);
  assert.equal(fetchCalls, 0);
});
