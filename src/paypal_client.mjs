import crypto from 'node:crypto';

function asPayPalAmount(amountMinor, currency) {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    throw new TypeError('amountMinor must be a positive safe integer');
  }

  return {
    currency_code: currency,
    value: (amountMinor / 100).toFixed(2),
  };
}

function requireText(value, field, maxLength) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
    throw new TypeError(`${field} must be a non-empty string of at most ${maxLength} characters`);
  }
  return value.trim();
}

export class PayPalHttpError extends Error {
  constructor(message, { status, phase, debugId } = {}) {
    super(message);
    this.name = 'PayPalHttpError';
    this.status = status;
    this.phase = phase;
    this.debugId = debugId;
  }
}

export class PayPalApiClient {
  constructor(options = {}) {
    this.environment = options.environment || process.env.PAYPAL_ENVIRONMENT || 'sandbox';
    this.clientId = options.clientId || process.env.PAYPAL_CLIENT_ID;
    this.clientSecret = options.clientSecret || process.env.PAYPAL_CLIENT_SECRET;
    if (!['sandbox', 'live'].includes(this.environment)) {
      throw new Error('PAYPAL_ENVIRONMENT must be sandbox or live');
    }
    const expectedBaseUrl = this.environment === 'live'
      ? 'https://api-m.paypal.com'
      : 'https://api-m.sandbox.paypal.com';
    this.baseUrl = options.baseUrl || expectedBaseUrl;
    this.fetch = options.fetch || globalThis.fetch;

    if (this.baseUrl !== expectedBaseUrl) {
      throw new Error(`PayPal ${this.environment} client must use ${expectedBaseUrl}`);
    }
    if (!this.clientId || !this.clientSecret) {
      throw new Error('PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are required');
    }
  }

  async getAccessToken() {
    const auth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    const response = await this.fetch(`${this.baseUrl}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });

    if (!response.ok) {
      throw new PayPalHttpError(`PayPal OAuth failed with HTTP ${response.status}`, {
        status: response.status,
        phase: 'oauth',
      });
    }

    const body = await response.json();
    if (!body.access_token) throw new Error('PayPal OAuth response did not include an access token');
    return body.access_token;
  }

  async _post(path, requestId, body) {
    const accessToken = await this.getAccessToken();
    const response = await this.fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'PayPal-Request-Id': requestId,
        Prefer: 'return=representation',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const responseBody = await response.json().catch(() => ({}));
    if (!response.ok) {
      const debugId = response.headers?.get?.('paypal-debug-id');
      throw new PayPalHttpError(
        `PayPal request failed with HTTP ${response.status}${debugId ? ` (debug ${debugId})` : ''}`,
        { status: response.status, phase: 'api', debugId },
      );
    }
    return responseBody;
  }

  async createOrder(params) {
    const currency = requireText(params.currency || 'USD', 'currency', 3).toUpperCase();
    const description = requireText(params.description, 'description', 127);
    const referenceId = requireText(params.referenceId, 'referenceId', 256);
    const requestId = requireText(params.requestId, 'requestId', 38);

    const paymentSource = params.returnUrl && params.cancelUrl
      ? {
          paypal: {
            experience_context: {
              return_url: params.returnUrl,
              cancel_url: params.cancelUrl,
              user_action: 'PAY_NOW',
              shipping_preference: 'NO_SHIPPING',
            },
          },
        }
      : undefined;

    return this._post('/v2/checkout/orders', requestId, {
      intent: 'CAPTURE',
      purchase_units: [
        {
          reference_id: referenceId,
          description,
          amount: asPayPalAmount(params.amountMinor, currency),
        },
      ],
      payment_source: paymentSource,
    });
  }

  async getOrder(orderId) {
    const accessToken = await this.getAccessToken();
    const response = await this.fetch(`${this.baseUrl}/v2/checkout/orders/${encodeURIComponent(orderId)}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new PayPalHttpError(`PayPal order lookup failed with HTTP ${response.status}`, {
        status: response.status,
        phase: 'api',
      });
    }
    return body;
  }

  async captureOrder(orderId, requestId) {
    return this._post(
      `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`,
      requireText(requestId, 'requestId', 38),
    );
  }
}

export class InMemoryPayPalClient {
  constructor(options = {}) {
    this.orders = new Map();
    this.createDelayMs = options.createDelayMs || 0;
    this.failNextCreate = false;
    this.failAfterNextCreate = false;
    this.failAfterNextCapture = false;
    this.createCalls = 0;
    this.captureCalls = 0;
    this.orderIdByRequestId = new Map();
    this.captureByRequestId = new Map();
  }

  async createOrder(params) {
    this.createCalls += 1;
    if (this.createDelayMs) await new Promise((resolve) => setTimeout(resolve, this.createDelayMs));
    if (this.failNextCreate) {
      this.failNextCreate = false;
      throw new PayPalHttpError('Simulated definitive PayPal create failure', {
        status: 422,
        phase: 'api',
      });
    }

    const existingOrderId = this.orderIdByRequestId.get(params.requestId);
    if (existingOrderId) return structuredClone(this.orders.get(existingOrderId));

    const id = `MOCK-${crypto.randomUUID()}`;
    const approvalHref = params.returnUrl
      ? (params.returnUrl.includes('?') ? `${params.returnUrl}&token=${id}` : `${params.returnUrl}?token=${id}`)
      : `https://sandbox.example.test/approve/${id}`;
    const order = {
      id,
      status: 'CREATED',
      purchase_units: [
        {
          reference_id: params.referenceId,
          description: params.description,
          amount: asPayPalAmount(params.amountMinor, params.currency || 'USD'),
        },
      ],
      links: [
        { rel: 'approve', href: approvalHref, method: 'GET' },
      ],
    };
    this.orders.set(id, order);
    this.orderIdByRequestId.set(params.requestId, id);
    if (this.failAfterNextCreate) {
      this.failAfterNextCreate = false;
      throw new Error('Simulated connection loss after PayPal created the order');
    }
    return structuredClone(order);
  }

  async getOrder(orderId) {
    const order = this.orders.get(orderId);
    if (!order) throw new Error(`Unknown mock order: ${orderId}`);
    return structuredClone(order);
  }

  approveOrder(orderId) {
    const order = this.orders.get(orderId);
    if (!order) throw new Error(`Unknown mock order: ${orderId}`);
    order.status = 'APPROVED';
  }

  voidOrder(orderId) {
    const order = this.orders.get(orderId);
    if (!order) throw new Error(`Unknown mock order: ${orderId}`);
    order.status = 'VOIDED';
  }

  async captureOrder(orderId, requestId) {
    this.captureCalls += 1;
    const prior = this.captureByRequestId.get(requestId);
    if (prior) return structuredClone(prior);
    const order = this.orders.get(orderId);
    if (!order) throw new Error(`Unknown mock order: ${orderId}`);
    if (order.status !== 'APPROVED') throw new Error('ORDER_NOT_APPROVED');
    order.status = 'COMPLETED';
    const captureId = `CAPTURE-${crypto.randomUUID()}`;
    order.purchase_units[0].payments = {
      captures: [{ id: captureId, status: 'COMPLETED' }],
    };
    const result = {
      id: orderId,
      status: 'COMPLETED',
      purchase_units: [{ payments: { captures: [{ id: captureId, status: 'COMPLETED' }] } }],
    };
    this.captureByRequestId.set(requestId, result);
    if (this.failAfterNextCapture) {
      this.failAfterNextCapture = false;
      throw new Error('Simulated connection loss after PayPal completed the capture');
    }
    return structuredClone(result);
  }
}
