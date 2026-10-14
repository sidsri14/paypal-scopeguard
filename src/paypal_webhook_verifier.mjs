import crypto from 'node:crypto';

const REQUIRED_HEADERS = [
  'paypal-auth-algo',
  'paypal-cert-url',
  'paypal-transmission-id',
  'paypal-transmission-sig',
  'paypal-transmission-time',
];

const CRC32_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  }
  return value >>> 0;
});

export function computeCrc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function validateCertUrl(value, environment) {
  const url = new URL(value);
  const allowedHosts = environment === 'live'
    ? new Set(['api.paypal.com', 'api-m.paypal.com'])
    : new Set(['api.sandbox.paypal.com', 'api-m.sandbox.paypal.com']);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (url.port && url.port !== '443') ||
    !allowedHosts.has(url.hostname) ||
    !url.pathname.startsWith('/v1/notifications/certs/')
  ) {
    throw new TypeError('PayPal certificate URL is not allowed');
  }
  return url.toString();
}

export class PayPalWebhookVerifier {
  constructor(options = {}) {
    if (typeof options.webhookId !== 'string' || options.webhookId.trim().length === 0) {
      throw new TypeError('PayPal webhook ID is required');
    }
    this.webhookId = options.webhookId.trim();
    this.environment = options.environment || 'sandbox';
    if (!['sandbox', 'live'].includes(this.environment)) {
      throw new TypeError('PayPal webhook environment must be sandbox or live');
    }
    this.fetch = options.fetch || globalThis.fetch;
    this.certificates = new Map();
  }

  async verify(rawBody, headers) {
    if (!Buffer.isBuffer(rawBody)) throw new TypeError('webhook body must be a Buffer');
    for (const name of REQUIRED_HEADERS) {
      if (typeof headers[name] !== 'string' || headers[name].length === 0) return false;
    }
    if (headers['paypal-auth-algo'] !== 'SHA256withRSA') return false;

    let certUrl;
    try {
      certUrl = validateCertUrl(headers['paypal-cert-url'], this.environment);
    } catch {
      return false;
    }

    const certificate = await this._getCertificate(certUrl);
    const message = [
      headers['paypal-transmission-id'],
      headers['paypal-transmission-time'],
      this.webhookId,
      computeCrc32(rawBody),
    ].join('|');

    try {
      return crypto.verify(
        'sha256',
        Buffer.from(message),
        certificate,
        Buffer.from(headers['paypal-transmission-sig'], 'base64'),
      );
    } catch {
      return false;
    }
  }

  async _getCertificate(url) {
    const cached = this.certificates.get(url);
    if (cached) return cached;

    const response = await this.fetch(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`PayPal certificate download failed with HTTP ${response.status}`);
    const certificate = await response.text();
    if (
      Buffer.byteLength(certificate) > 64 * 1024
      || (!certificate.includes('CERTIFICATE') && !certificate.includes('PUBLIC KEY'))
    ) {
      throw new Error('PayPal certificate response is invalid');
    }
    this.certificates.set(url, certificate);
    return certificate;
  }
}
