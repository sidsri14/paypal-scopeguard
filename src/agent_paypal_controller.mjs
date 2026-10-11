import crypto from 'node:crypto';
import { AgentSpendPolicy } from './policy.mjs';
import { PayPalApiClient } from './paypal_client.mjs';

function requireText(value, field, maxLength = 128) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
    throw new TypeError(`${field} must be a non-empty string of at most ${maxLength} characters`);
  }
  return value.trim();
}

function requireRedirectUrl(value, field) {
  const text = requireText(value, field, 2_048);
  const url = new URL(text);
  const localHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !localHttp) {
    throw new TypeError(`${field} must use HTTPS, except for localhost development`);
  }
  if (url.username || url.password) throw new TypeError(`${field} must not contain credentials`);
  return url.toString();
}

function stableRequestId(namespace, value) {
  const digest = crypto.createHash('sha256').update(`${namespace}:${value}`).digest('hex');
  return `${namespace[0]}${digest.slice(0, 32)}`;
}

function findApprovalUrl(order) {
  return order.links?.find((link) => link.rel === 'approve' || link.rel === 'payer-action')?.href;
}

function findCompletedCaptureId(capture) {
  const captures = capture.purchase_units?.flatMap((unit) => unit.payments?.captures || []) || [];
  return captures.find((item) => item.status === 'COMPLETED')?.id;
}

export class AgentPayPalController {
  constructor(config = {}) {
    this.policy = config.policy || new AgentSpendPolicy({
      agentId: config.agentId || 'agent_paypal_buyer',
      maxPerTransactionMinor: config.maxPerTransactionMinor ?? 2_500,
      maxWindowMinor: config.maxWindowMinor ?? 10_000,
      windowDurationMs: config.windowDurationMs || 86_400_000,
      allowedMerchantCategories: config.allowedMerchantCategories || [
        'AI_INFERENCE',
        'CLOUD_COMPUTE',
        'DEVELOPER_TOOLS',
        'DATA_FEEDS',
      ],
      clock: config.clock,
    });
    this.client = config.client || new PayPalApiClient(config.paypal || {});
    this.allowedCurrencies = new Set(config.allowedCurrencies || ['USD']);
    this.now = config.now || (() => new Date().toISOString());
    this.auditTrail = [];
    this.pendingByOrderId = new Map();
    this.proposalByClientRequestId = new Map();
    this.proposalInFlight = new Map();
    this.captureInFlight = new Map();
    this.settlementByOrderId = new Map();
  }

  proposePayment(request) {
    const req = this._validateRequest(request);
    const existing = this.proposalByClientRequestId.get(req.clientRequestId);
    if (existing) return Promise.resolve(structuredClone(existing));

    const inFlight = this.proposalInFlight.get(req.clientRequestId);
    if (inFlight) return inFlight;

    const reservationId = stableRequestId('reservation', req.clientRequestId);
    const evaluation = this.policy.reserve(req, reservationId);
    if (!evaluation.approved) {
      const denial = {
        success: false,
        status: 'DENIED',
        error: evaluation.reason,
        clientRequestId: req.clientRequestId,
        remainingMinor: evaluation.remainingMinor,
      };
      this._audit('DENIED', req, { reason: evaluation.reason });
      this.proposalByClientRequestId.set(req.clientRequestId, denial);
      return Promise.resolve(structuredClone(denial));
    }

    const operation = this._createReservedOrder(req, reservationId).finally(() => {
      this.proposalInFlight.delete(req.clientRequestId);
    });
    this.proposalInFlight.set(req.clientRequestId, operation);
    return operation;
  }

  async _createReservedOrder(req, reservationId) {
    try {
      const order = await this.client.createOrder({
        amountMinor: req.amountMinor,
        currency: req.currency,
        description: req.purpose,
        referenceId: reservationId,
        requestId: stableRequestId('create', req.clientRequestId),
        returnUrl: req.returnUrl,
        cancelUrl: req.cancelUrl,
      });
      const approvalUrl = findApprovalUrl(order);
      if (!order.id || !approvalUrl) {
        throw new Error('PayPal order did not include an id and buyer approval URL');
      }

      const pending = {
        reservationId,
        clientRequestId: req.clientRequestId,
        amountMinor: req.amountMinor,
        currency: req.currency,
        merchantCategory: req.merchantCategory,
        purpose: req.purpose,
      };
      this.pendingByOrderId.set(order.id, pending);

      const result = {
        success: true,
        status: 'PENDING_BUYER_APPROVAL',
        clientRequestId: req.clientRequestId,
        orderId: order.id,
        approvalUrl,
        remainingMinor: this.policy.getRemainingMinor(),
      };
      this.proposalByClientRequestId.set(req.clientRequestId, result);
      this._audit('PENDING_BUYER_APPROVAL', req, { orderId: order.id });
      return structuredClone(result);
    } catch (error) {
      this.policy.release(reservationId);
      this._audit('ORDER_CREATE_FAILED', req, { reason: error.message });
      return {
        success: false,
        status: 'ORDER_CREATE_FAILED',
        error: 'PAYPAL_ORDER_CREATE_FAILED',
        clientRequestId: req.clientRequestId,
        remainingMinor: this.policy.getRemainingMinor(),
      };
    }
  }

  captureApprovedOrder(orderId) {
    requireText(orderId, 'orderId', 128);
    const settled = this.settlementByOrderId.get(orderId);
    if (settled) return Promise.resolve(structuredClone(settled));

    const inFlight = this.captureInFlight.get(orderId);
    if (inFlight) return inFlight;

    const operation = this._captureApprovedOrder(orderId).finally(() => {
      this.captureInFlight.delete(orderId);
    });
    this.captureInFlight.set(orderId, operation);
    return operation;
  }

  async _captureApprovedOrder(orderId) {
    const pending = this.pendingByOrderId.get(orderId);
    if (!pending) {
      return { success: false, status: 'UNKNOWN_ORDER', error: 'UNKNOWN_ORDER' };
    }

    let order;
    try {
      order = await this.client.getOrder(orderId);
    } catch (error) {
      this._audit('ORDER_LOOKUP_FAILED', pending, { orderId, reason: error.message });
      return { success: false, status: 'ORDER_LOOKUP_FAILED', error: 'PAYPAL_ORDER_LOOKUP_FAILED' };
    }

    if (order.status !== 'APPROVED') {
      return {
        success: false,
        status: 'BUYER_APPROVAL_REQUIRED',
        error: 'BUYER_APPROVAL_REQUIRED',
        orderId,
      };
    }

    try {
      const capture = await this.client.captureOrder(
        orderId,
        stableRequestId('capture', pending.clientRequestId),
      );
      const captureId = findCompletedCaptureId(capture);
      if (capture.status !== 'COMPLETED' || !captureId) {
        throw new Error('PayPal did not return a completed capture');
      }

      this.policy.commit(pending.reservationId);
      this.pendingByOrderId.delete(orderId);
      const result = {
        success: true,
        status: 'COMPLETED',
        orderId,
        captureId,
        amountMinor: pending.amountMinor,
        currency: pending.currency,
        remainingMinor: this.policy.getRemainingMinor(),
      };
      this.settlementByOrderId.set(orderId, result);
      this._audit('COMPLETED', pending, { orderId, captureId });
      return structuredClone(result);
    } catch (error) {
      // A failed capture can have an uncertain remote outcome, so the budget
      // remains reserved until the order is reconciled.
      this._audit('CAPTURE_FAILED', pending, { orderId, reason: error.message });
      return { success: false, status: 'CAPTURE_FAILED', error: 'PAYPAL_CAPTURE_FAILED', orderId };
    }
  }

  async cancelPendingOrder(orderId) {
    requireText(orderId, 'orderId', 128);
    const pending = this.pendingByOrderId.get(orderId);
    if (!pending) return { success: false, status: 'UNKNOWN_ORDER', error: 'UNKNOWN_ORDER' };

    const order = await this.client.getOrder(orderId);
    if (!['CREATED', 'PAYER_ACTION_REQUIRED'].includes(order.status)) {
      return { success: false, status: 'ORDER_NOT_ABANDONABLE', error: 'ORDER_NOT_ABANDONABLE' };
    }

    this.policy.release(pending.reservationId);
    this.pendingByOrderId.delete(orderId);
    this.proposalByClientRequestId.delete(pending.clientRequestId);
    this._audit('ABANDONED', pending, { orderId });
    return {
      success: true,
      status: 'ABANDONED',
      orderId,
      remainingMinor: this.policy.getRemainingMinor(),
    };
  }

  _validateRequest(request) {
    if (!request || typeof request !== 'object') throw new TypeError('request must be an object');
    if (!Number.isSafeInteger(request.amountMinor) || request.amountMinor <= 0) {
      throw new TypeError('amountMinor must be a positive safe integer');
    }

    const currency = requireText(request.currency || 'USD', 'currency', 3).toUpperCase();
    if (!this.allowedCurrencies.has(currency)) {
      throw new TypeError(`currency is not enabled: ${currency}`);
    }

    const returnUrl = request.returnUrl;
    const cancelUrl = request.cancelUrl;
    if ((returnUrl && !cancelUrl) || (!returnUrl && cancelUrl)) {
      throw new TypeError('returnUrl and cancelUrl must be provided together');
    }

    return {
      clientRequestId: requireText(request.clientRequestId, 'clientRequestId'),
      amountMinor: request.amountMinor,
      currency,
      merchantCategory: requireText(request.merchantCategory, 'merchantCategory', 64),
      purpose: requireText(request.purpose, 'purpose', 127),
      returnUrl: returnUrl ? requireRedirectUrl(returnUrl, 'returnUrl') : undefined,
      cancelUrl: cancelUrl ? requireRedirectUrl(cancelUrl, 'cancelUrl') : undefined,
    };
  }

  _audit(status, request, extra = {}) {
    this.auditTrail.push({
      timestamp: this.now(),
      agentId: this.policy.agentId,
      status,
      clientRequestId: request.clientRequestId,
      amountMinor: request.amountMinor,
      currency: request.currency,
      merchantCategory: request.merchantCategory,
      ...extra,
    });
  }

  getAuditTrail() {
    return structuredClone(this.auditTrail);
  }

  emergencyRevoke() {
    this.policy.revoke();
  }

  reinstatePolicy() {
    this.policy.reinstate();
  }
}
