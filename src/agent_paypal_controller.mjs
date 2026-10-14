import crypto from 'node:crypto';
import { AgentSpendPolicy } from './policy.mjs';
import { PayPalApiClient, PayPalHttpError } from './paypal_client.mjs';

const STATE_VERSION = 1;
const MAX_AUDIT_EVENTS = 2_000;
const MAX_WEBHOOK_EVENT_IDS = 1_000;

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

function requestFingerprint(request) {
  return crypto.createHash('sha256').update(JSON.stringify(request)).digest('hex');
}

function findApprovalUrl(order) {
  return order.links?.find((link) => link.rel === 'approve' || link.rel === 'payer-action')?.href;
}

function findCompletedCaptureId(order) {
  const captures = order.purchase_units?.flatMap((unit) => unit.payments?.captures || []) || [];
  return captures.find((item) => item.status === 'COMPLETED')?.id;
}

function isDefinitiveCreateFailure(error) {
  if (!(error instanceof PayPalHttpError)) return false;
  if (error.phase === 'oauth') return true;
  return Number.isInteger(error.status)
    && error.status >= 400
    && error.status < 500
    && ![408, 409, 429].includes(error.status);
}

function restoreMap(value, field) {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  const map = new Map();
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || map.has(entry[0])) {
      throw new TypeError(`${field} entries must have unique string keys`);
    }
    map.set(entry[0], entry[1]);
  }
  return map;
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
    this.stateStore = config.stateStore;
    this.persistTail = Promise.resolve();
    this.auditTrail = [];
    this.pendingCreateByClientRequestId = new Map();
    this.pendingByOrderId = new Map();
    this.proposalByClientRequestId = new Map();
    this.requestFingerprintByClientRequestId = new Map();
    this.proposalInFlight = new Map();
    this.orderOperationTail = new Map();
    this.webhookInFlight = new Map();
    this.settlementByOrderId = new Map();
    this.processedWebhookEventIds = [];
    this.processedWebhookEventIdSet = new Set();

    if (config.initialState) this._restoreState(config.initialState);
  }

  proposePayment(request) {
    const req = this._validateRequest(request);
    const fingerprint = requestFingerprint(req);
    const previousFingerprint = this.requestFingerprintByClientRequestId.get(req.clientRequestId);
    if (previousFingerprint && previousFingerprint !== fingerprint) {
      throw new TypeError('clientRequestId was reused with different payment details');
    }
    this.requestFingerprintByClientRequestId.set(req.clientRequestId, fingerprint);

    const existing = this.proposalByClientRequestId.get(req.clientRequestId);
    if (existing) return Promise.resolve(structuredClone(existing));
    const inFlight = this.proposalInFlight.get(req.clientRequestId);
    if (inFlight) return inFlight;

    let pendingCreate = this.pendingCreateByClientRequestId.get(req.clientRequestId);
    if (!pendingCreate) {
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
        return this._persist().then(() => structuredClone(denial));
      }
      pendingCreate = { request: req, reservationId };
      this.pendingCreateByClientRequestId.set(req.clientRequestId, pendingCreate);
    }

    const operation = this._createReservedOrder(pendingCreate.request, pendingCreate.reservationId)
      .finally(() => this.proposalInFlight.delete(req.clientRequestId));
    this.proposalInFlight.set(req.clientRequestId, operation);
    return operation;
  }

  async _createReservedOrder(req, reservationId) {
    await this._persist();
    let order;
    try {
      order = await this.client.createOrder({
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
      this.pendingCreateByClientRequestId.delete(req.clientRequestId);
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
      await this._persist();
      return structuredClone(result);
    } catch (error) {
      if (isDefinitiveCreateFailure(error)) {
        this.policy.release(reservationId);
        this.pendingCreateByClientRequestId.delete(req.clientRequestId);
        const result = {
          success: false,
          status: 'ORDER_CREATE_FAILED',
          error: 'PAYPAL_ORDER_CREATE_FAILED',
          clientRequestId: req.clientRequestId,
          remainingMinor: this.policy.getRemainingMinor(),
        };
        this.proposalByClientRequestId.set(req.clientRequestId, result);
        this._audit('ORDER_CREATE_FAILED', req, { reason: error.message });
        await this._persist();
        return structuredClone(result);
      }

      this._audit('ORDER_CREATE_UNCERTAIN', req, { reason: error.message });
      await this._persist();
      return {
        success: false,
        status: 'ORDER_CREATE_UNCERTAIN',
        error: 'PAYPAL_ORDER_CREATE_UNCERTAIN',
        clientRequestId: req.clientRequestId,
        retryable: true,
        remainingMinor: this.policy.getRemainingMinor(),
      };
    }
  }

  captureApprovedOrder(orderId) {
    requireText(orderId, 'orderId', 128);
    const settled = this.settlementByOrderId.get(orderId);
    if (settled) return Promise.resolve(structuredClone(settled));
    return this._queueOrderOperation(orderId, () => this._captureApprovedOrder(orderId));
  }

  async _captureApprovedOrder(orderId) {
    const settled = this.settlementByOrderId.get(orderId);
    if (settled) return structuredClone(settled);
    const pending = this.pendingByOrderId.get(orderId);
    if (!pending) return { success: false, status: 'UNKNOWN_ORDER', error: 'UNKNOWN_ORDER' };

    let order;
    try {
      order = await this.client.getOrder(orderId);
    } catch (error) {
      this._audit('ORDER_LOOKUP_FAILED', pending, { orderId, reason: error.message });
      await this._persist();
      return { success: false, status: 'ORDER_LOOKUP_FAILED', error: 'PAYPAL_ORDER_LOOKUP_FAILED' };
    }

    if (order.status === 'COMPLETED') return this._completeOrder(orderId, pending, order);
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
      return await this._completeOrder(orderId, pending, capture);
    } catch (error) {
      this._audit('CAPTURE_OUTCOME_UNCERTAIN', pending, { orderId, reason: error.message });
      await this._persist();
      return {
        success: false,
        status: 'CAPTURE_OUTCOME_UNCERTAIN',
        error: 'PAYPAL_CAPTURE_OUTCOME_UNCERTAIN',
        orderId,
        reconciliationRequired: true,
      };
    }
  }

  async _completeOrder(orderId, pending, order) {
    const settled = this.settlementByOrderId.get(orderId);
    if (settled) return structuredClone(settled);
    pending = this.pendingByOrderId.get(orderId) || pending;
    const captureId = findCompletedCaptureId(order);
    if (order.status !== 'COMPLETED' || !captureId) {
      return {
        success: false,
        status: 'RECONCILIATION_PENDING',
        error: 'COMPLETED_CAPTURE_NOT_FOUND',
        orderId,
      };
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
    await this._persist();
    return structuredClone(result);
  }

  reconcileOrder(orderId) {
    requireText(orderId, 'orderId', 128);
    const settled = this.settlementByOrderId.get(orderId);
    if (settled) return Promise.resolve(structuredClone(settled));
    return this._queueOrderOperation(orderId, () => this._reconcileOrder(orderId));
  }

  async _reconcileOrder(orderId) {
    const settled = this.settlementByOrderId.get(orderId);
    if (settled) return structuredClone(settled);
    const pending = this.pendingByOrderId.get(orderId);
    if (!pending) return { success: false, status: 'UNKNOWN_ORDER', error: 'UNKNOWN_ORDER' };

    let order;
    try {
      order = await this.client.getOrder(orderId);
    } catch (error) {
      this._audit('RECONCILIATION_LOOKUP_FAILED', pending, { orderId, reason: error.message });
      await this._persist();
      return {
        success: false,
        status: 'RECONCILIATION_LOOKUP_FAILED',
        error: 'PAYPAL_ORDER_LOOKUP_FAILED',
        orderId,
      };
    }

    if (order.status === 'COMPLETED') return this._completeOrder(orderId, pending, order);
    if (order.status === 'APPROVED') {
      return { success: true, status: 'AWAITING_EXPLICIT_CAPTURE', orderId };
    }
    if (['CREATED', 'PAYER_ACTION_REQUIRED'].includes(order.status)) {
      return { success: true, status: 'PENDING_BUYER_APPROVAL', orderId };
    }
    if (order.status === 'VOIDED') {
      this.policy.release(pending.reservationId);
      this.pendingByOrderId.delete(orderId);
      this.proposalByClientRequestId.delete(pending.clientRequestId);
      this._audit('VOIDED', pending, { orderId });
      await this._persist();
      return {
        success: true,
        status: 'VOIDED',
        orderId,
        remainingMinor: this.policy.getRemainingMinor(),
      };
    }
    return { success: false, status: 'RECONCILIATION_PENDING', orderId, remoteStatus: order.status };
  }

  async cancelPendingOrder(orderId) {
    requireText(orderId, 'orderId', 128);
    return this._queueOrderOperation(orderId, () => this._cancelPendingOrder(orderId));
  }

  async _cancelPendingOrder(orderId) {
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
    await this._persist();
    return {
      success: true,
      status: 'ABANDONED',
      orderId,
      remainingMinor: this.policy.getRemainingMinor(),
    };
  }

  handlePayPalWebhook(event) {
    if (!event || typeof event !== 'object') throw new TypeError('webhook event must be an object');
    const eventId = requireText(event.id, 'webhook event id', 128);
    if (this.processedWebhookEventIdSet.has(eventId)) {
      return Promise.resolve({ success: true, status: 'DUPLICATE_EVENT', eventId });
    }
    const inFlight = this.webhookInFlight.get(eventId);
    if (inFlight) return inFlight;
    const operation = this._handlePayPalWebhook(eventId, event)
      .finally(() => this.webhookInFlight.delete(eventId));
    this.webhookInFlight.set(eventId, operation);
    return operation;
  }

  async _handlePayPalWebhook(eventId, event) {
    const eventType = requireText(event.event_type, 'webhook event type', 128);
    let result;
    if (eventType === 'PAYMENT.CAPTURE.COMPLETED') {
      const orderId = event.resource?.supplementary_data?.related_ids?.order_id;
      if (typeof orderId !== 'string' || orderId.length === 0) {
        throw new TypeError('capture webhook does not include its related order ID');
      }
      result = await this.reconcileOrder(orderId);
    } else if (eventType === 'CHECKOUT.ORDER.APPROVED') {
      const orderId = event.resource?.id;
      const pending = typeof orderId === 'string' ? this.pendingByOrderId.get(orderId) : undefined;
      if (pending) {
        this._audit('BUYER_APPROVED', pending, { orderId, eventId });
        result = { success: true, status: 'AWAITING_EXPLICIT_CAPTURE', orderId };
      } else {
        result = { success: true, status: 'IGNORED_UNKNOWN_ORDER', orderId };
      }
    } else {
      result = { success: true, status: 'IGNORED_EVENT', eventType };
    }

    this._recordProcessedWebhookEvent(eventId);
    await this._persist();
    return result;
  }

  _recordProcessedWebhookEvent(eventId) {
    this.processedWebhookEventIds.push(eventId);
    this.processedWebhookEventIdSet.add(eventId);
    while (this.processedWebhookEventIds.length > MAX_WEBHOOK_EVENT_IDS) {
      this.processedWebhookEventIdSet.delete(this.processedWebhookEventIds.shift());
    }
  }

  _queueOrderOperation(orderId, operation) {
    const previous = this.orderOperationTail.get(orderId) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.orderOperationTail.set(orderId, current);
    const cleanup = () => {
      if (this.orderOperationTail.get(orderId) === current) this.orderOperationTail.delete(orderId);
    };
    current.then(cleanup, cleanup);
    return current;
  }

  _validateRequest(request) {
    if (!request || typeof request !== 'object') throw new TypeError('request must be an object');
    if (!Number.isSafeInteger(request.amountMinor) || request.amountMinor <= 0) {
      throw new TypeError('amountMinor must be a positive safe integer');
    }

    const currency = requireText(request.currency || 'USD', 'currency', 3).toUpperCase();
    if (!this.allowedCurrencies.has(currency)) throw new TypeError(`currency is not enabled: ${currency}`);

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
    if (this.auditTrail.length > MAX_AUDIT_EVENTS) {
      this.auditTrail.splice(0, this.auditTrail.length - MAX_AUDIT_EVENTS);
    }
  }

  exportState() {
    return {
      version: STATE_VERSION,
      policy: this.policy.exportState(),
      pendingCreates: [...this.pendingCreateByClientRequestId.entries()],
      pendingOrders: [...this.pendingByOrderId.entries()],
      proposals: [...this.proposalByClientRequestId.entries()],
      requestFingerprints: [...this.requestFingerprintByClientRequestId.entries()],
      settlements: [...this.settlementByOrderId.entries()],
      auditTrail: this.auditTrail,
      processedWebhookEventIds: this.processedWebhookEventIds,
    };
  }

  _restoreState(state) {
    if (!state || state.version !== STATE_VERSION) {
      throw new TypeError(`unsupported ScopeGuard state version: ${state?.version}`);
    }
    this.policy.restoreState(state.policy);
    this.pendingCreateByClientRequestId = restoreMap(state.pendingCreates, 'pendingCreates');
    this.pendingByOrderId = restoreMap(state.pendingOrders, 'pendingOrders');
    this.proposalByClientRequestId = restoreMap(state.proposals, 'proposals');
    this.requestFingerprintByClientRequestId = restoreMap(
      state.requestFingerprints,
      'requestFingerprints',
    );
    this.settlementByOrderId = restoreMap(state.settlements, 'settlements');
    if (!Array.isArray(state.auditTrail) || !Array.isArray(state.processedWebhookEventIds)) {
      throw new TypeError('persisted audit and webhook event state must be arrays');
    }
    this.auditTrail = structuredClone(state.auditTrail).slice(-MAX_AUDIT_EVENTS);
    this.processedWebhookEventIds = state.processedWebhookEventIds.slice(-MAX_WEBHOOK_EVENT_IDS);
    if (this.processedWebhookEventIds.some((id) => typeof id !== 'string')) {
      throw new TypeError('persisted webhook event IDs must be strings');
    }
    this.processedWebhookEventIdSet = new Set(this.processedWebhookEventIds);

    const reservations = this.policy.reservations;
    for (const [clientRequestId, pending] of this.pendingCreateByClientRequestId) {
      if (
        !pending
        || pending.request?.clientRequestId !== clientRequestId
        || typeof pending.reservationId !== 'string'
        || reservations.get(pending.reservationId) !== pending.request?.amountMinor
      ) {
        throw new TypeError('persisted pending payment is missing its policy reservation');
      }
      this._validateRequest(pending.request);
    }
    for (const pending of this.pendingByOrderId.values()) {
      if (
        !pending
        || typeof pending.reservationId !== 'string'
        || reservations.get(pending.reservationId) !== pending.amountMinor
      ) {
        throw new TypeError('persisted pending payment is missing its policy reservation');
      }
    }
    for (const [clientRequestId, fingerprint] of this.requestFingerprintByClientRequestId) {
      if (!/^[a-f0-9]{64}$/.test(fingerprint) || clientRequestId.length === 0) {
        throw new TypeError('persisted request fingerprints are invalid');
      }
    }
  }

  _persist() {
    if (!this.stateStore) return Promise.resolve();
    const snapshot = structuredClone(this.exportState());
    const save = this.persistTail.then(() => this.stateStore.save(snapshot));
    this.persistTail = save.catch(() => {});
    return save;
  }

  getAuditTrail() {
    return structuredClone(this.auditTrail);
  }

  async emergencyRevoke() {
    this.policy.revoke();
    await this._persist();
  }

  async reinstatePolicy() {
    this.policy.reinstate();
    await this._persist();
  }
}
