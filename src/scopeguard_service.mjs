import crypto from 'node:crypto';

function requireText(value, field, maxLength) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
    throw new TypeError(`${field} must be a non-empty string of at most ${maxLength} characters`);
  }
  return value.trim();
}

function requestFingerprint(request) {
  return crypto.createHash('sha256').update(JSON.stringify(request)).digest('hex');
}

export class ScopeGuardService {
  constructor({ controller, intentAdapter }) {
    if (!controller || typeof controller.proposePayment !== 'function') {
      throw new TypeError('controller must implement proposePayment');
    }
    if (!intentAdapter || typeof intentAdapter.interpret !== 'function') {
      throw new TypeError('intentAdapter must implement interpret');
    }

    this.controller = controller;
    this.intentAdapter = intentAdapter;
    this.resultByClientRequestId = new Map();
    this.inFlightByClientRequestId = new Map();
    this.fingerprintByClientRequestId = new Map();
  }

  proposeFromInstruction(request) {
    if (!request || typeof request !== 'object') throw new TypeError('request must be an object');

    const normalized = {
      clientRequestId: requireText(request.clientRequestId, 'clientRequestId', 128),
      instruction: requireText(request.instruction, 'instruction', 2_000),
      returnUrl: request.returnUrl,
      cancelUrl: request.cancelUrl,
    };
    const fingerprint = requestFingerprint(normalized);
    const previousFingerprint = this.fingerprintByClientRequestId.get(normalized.clientRequestId);
    if (previousFingerprint && previousFingerprint !== fingerprint) {
      throw new Error('clientRequestId was reused with different request content');
    }

    const existing = this.resultByClientRequestId.get(normalized.clientRequestId);
    if (existing) return Promise.resolve(structuredClone(existing));
    const inFlight = this.inFlightByClientRequestId.get(normalized.clientRequestId);
    if (inFlight) return inFlight;

    this.fingerprintByClientRequestId.set(normalized.clientRequestId, fingerprint);
    const operation = this._propose(normalized)
      .then((result) => {
        this.resultByClientRequestId.set(normalized.clientRequestId, result);
        return structuredClone(result);
      })
      .catch((error) => {
        this.fingerprintByClientRequestId.delete(normalized.clientRequestId);
        throw error;
      })
      .finally(() => {
        this.inFlightByClientRequestId.delete(normalized.clientRequestId);
      });
    this.inFlightByClientRequestId.set(normalized.clientRequestId, operation);
    return operation;
  }

  async _propose(request) {
    const intent = await this.intentAdapter.interpret(request.instruction);
    const proposal = await this.controller.proposePayment({
      clientRequestId: request.clientRequestId,
      ...intent,
      returnUrl: request.returnUrl,
      cancelUrl: request.cancelUrl,
    });

    return { intent, proposal };
  }
}
