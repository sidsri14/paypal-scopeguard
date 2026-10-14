function requirePositiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive integer in minor currency units`);
  }
}

function requireNonNegativeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer`);
  }
}

export class AgentSpendPolicy {
  constructor(config) {
    if (typeof config.agentId !== 'string' || config.agentId.trim().length === 0) {
      throw new TypeError('agentId must be a non-empty string');
    }
    requirePositiveInteger(config.maxPerTransactionMinor, 'maxPerTransactionMinor');
    requirePositiveInteger(config.maxWindowMinor, 'maxWindowMinor');
    if (
      config.windowDurationMs !== undefined &&
      (!Number.isSafeInteger(config.windowDurationMs) || config.windowDurationMs <= 0)
    ) {
      throw new TypeError('windowDurationMs must be a positive integer');
    }

    this.agentId = config.agentId.trim();
    this.maxPerTransactionMinor = config.maxPerTransactionMinor;
    this.maxWindowMinor = config.maxWindowMinor;
    this.windowDurationMs = config.windowDurationMs || 86_400_000;
    this.allowedMerchantCategories = new Set(config.allowedMerchantCategories || []);
    this.clock = config.clock || (() => Date.now());
    this.active = true;
    this.windowStartedAt = this.clock();
    this.committedMinor = 0;
    this.reservations = new Map();
  }

  _refreshWindow() {
    const now = this.clock();
    if (now - this.windowStartedAt >= this.windowDurationMs) {
      this.windowStartedAt = now;
      this.committedMinor = 0;
      // Pending PayPal orders may outlive a budget window. Their reservations
      // remain charged until they are captured or explicitly abandoned.
    }
  }

  getReservedMinor() {
    return [...this.reservations.values()].reduce((total, amount) => total + amount, 0);
  }

  getRemainingMinor() {
    this._refreshWindow();
    if (!this.active) return 0;
    return Math.max(0, this.maxWindowMinor - this.committedMinor - this.getReservedMinor());
  }

  reserve(request, reservationId) {
    this._refreshWindow();

    if (!this.active) {
      return { approved: false, reason: 'AGENT_POLICY_REVOKED', remainingMinor: 0 };
    }

    if (!reservationId || this.reservations.has(reservationId)) {
      return {
        approved: false,
        reason: 'INVALID_OR_DUPLICATE_RESERVATION',
        remainingMinor: this.getRemainingMinor(),
      };
    }

    if (!Number.isSafeInteger(request.amountMinor) || request.amountMinor <= 0) {
      return {
        approved: false,
        reason: 'INVALID_AMOUNT',
        remainingMinor: this.getRemainingMinor(),
      };
    }

    if (request.amountMinor > this.maxPerTransactionMinor) {
      return {
        approved: false,
        reason: 'EXCEEDS_PER_TRANSACTION_LIMIT',
        remainingMinor: this.getRemainingMinor(),
      };
    }

    if (
      this.allowedMerchantCategories.size > 0 &&
      !this.allowedMerchantCategories.has(request.merchantCategory)
    ) {
      return {
        approved: false,
        reason: 'MERCHANT_CATEGORY_NOT_PERMITTED',
        remainingMinor: this.getRemainingMinor(),
      };
    }

    if (request.amountMinor > this.getRemainingMinor()) {
      return {
        approved: false,
        reason: 'EXCEEDS_WINDOW_LIMIT',
        remainingMinor: this.getRemainingMinor(),
      };
    }

    this.reservations.set(reservationId, request.amountMinor);
    return { approved: true, remainingMinor: this.getRemainingMinor() };
  }

  commit(reservationId) {
    this._refreshWindow();
    const amountMinor = this.reservations.get(reservationId);
    if (amountMinor === undefined) {
      throw new Error(`Unknown reservation: ${reservationId}`);
    }

    this.reservations.delete(reservationId);
    this.committedMinor += amountMinor;
    return amountMinor;
  }

  release(reservationId) {
    this._refreshWindow();
    return this.reservations.delete(reservationId);
  }

  revoke() {
    this.active = false;
  }

  reinstate() {
    this.active = true;
  }

  exportState() {
    return {
      active: this.active,
      windowStartedAt: this.windowStartedAt,
      committedMinor: this.committedMinor,
      reservations: [...this.reservations.entries()],
    };
  }

  restoreState(state) {
    if (!state || typeof state !== 'object') throw new TypeError('policy state must be an object');
    if (typeof state.active !== 'boolean') throw new TypeError('policy state active must be boolean');
    requireNonNegativeInteger(state.windowStartedAt, 'policy state windowStartedAt');
    requireNonNegativeInteger(state.committedMinor, 'policy state committedMinor');
    if (!Array.isArray(state.reservations)) {
      throw new TypeError('policy state reservations must be an array');
    }

    const reservations = new Map();
    for (const entry of state.reservations) {
      if (!Array.isArray(entry) || entry.length !== 2) {
        throw new TypeError('policy reservation entries must be [id, amount] pairs');
      }
      const [id, amount] = entry;
      if (typeof id !== 'string' || id.length === 0 || reservations.has(id)) {
        throw new TypeError('policy reservation IDs must be unique non-empty strings');
      }
      requirePositiveInteger(amount, 'policy reservation amount');
      reservations.set(id, amount);
    }

    this.active = state.active;
    this.windowStartedAt = state.windowStartedAt;
    this.committedMinor = state.committedMinor;
    this.reservations = reservations;
    this._refreshWindow();
  }
}
