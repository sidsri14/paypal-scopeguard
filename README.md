# PayPal ScopeGuard

PayPal ScopeGuard is a bounded AI purchase-intent prototype for PayPal Orders.
The model can translate a natural-language request into four constrained fields,
but it cannot call PayPal, approve an order, bypass policy, or capture funds.

This repository contains the PayPal AI Hackathon submission prototype. It is
not a production payment service. The local controller, restart recovery,
webhook boundary, and browser flow are tested, but the end-to-end flow has not
yet been verified with real AI-provider and PayPal sandbox credentials.

![ScopeGuard browser interface](scopeguard-ui.png)

## Safety boundary

```text
untrusted purchase instruction
  -> AI extraction with strict JSON Schema output
  -> local validation of amount, currency, category, purpose, and extra fields
  -> deterministic per-transaction/category/window policy
  -> synchronous budget reservation
  -> PayPal sandbox order with a stable PayPal-Request-Id
  -> explicit buyer approval on PayPal
  -> explicit capture action
  -> commit budget only after a COMPLETED capture
  -> persist controller state with atomic file replacement
  -> reconcile uncertain outcomes against PayPal Orders
```

The AI adapter has no PayPal tools or payment credentials. Its output is treated
as untrusted input and revalidated locally. A valid model response can still be
denied by the deterministic spend policy before network I/O.

## Implemented

- OpenAI-compatible chat-completions adapter with strict structured output.
- Exact allowlists for currency and merchant category.
- Rejection of unknown fields, fractional minor units, Markdown-wrapped output,
  oversized prompts, insecure remote AI endpoints, and request-ID conflicts.
- Integer minor-unit accounting (`1200` means USD 12.00).
- Per-transaction, time-window, and merchant-category policy checks.
- Synchronous reservations before network I/O to prevent concurrent overspend.
- PayPal Orders v2 create, retrieve, and capture client methods.
- Stable request IDs for create and capture retries.
- Atomic, restart-safe JSON snapshots for reservations, pending orders,
  settlements, audit events, and webhook replay IDs.
- Ambiguous create failures retain their reservation and can resume with the
  original stable PayPal request ID; definitive validation failures release it.
- Mandatory buyer approval before capture.
- Explicit order reconciliation for lost create/capture responses and remote
  `COMPLETED`, `APPROVED`, pending, and `VOIDED` states.
- Raw-body RSA verification for PayPal webhooks, with PayPal-only certificate
  URLs, redirect refusal, certificate caching, and event replay deduplication.
- `CHECKOUT.ORDER.APPROVED` webhooks never capture funds; only the explicit
  capture action can do that.
- Durable audit events, emergency revocation, and order abandonment.
- Loopback-only browser server with CSP and explicit proposal/capture actions.
- Explicit in-memory PayPal fake for deterministic tests and simulation only.

## Run tests and local simulation

Requires a current Node.js release with ESM and built-in `fetch`.

```bash
npm test
npm run demo
npm run demo:build
```

`npm run demo` is visibly labeled as a simulation and never contacts PayPal or
an AI provider. `npm run preview` serves only the static UI for visual review;
its proposal and capture endpoints intentionally return unavailable errors.
`npm run demo:build` records that same deterministic simulation at 1440x900 and
builds `demo/scopeguard-demo.mp4` with narration and burned-in captions. The
recording demonstrates lost-response recovery without claiming a real PayPal
sandbox payment.

## Run the real sandbox flow locally

Create separate PayPal sandbox and AI-provider credentials, then set these
environment variables without committing them:

```powershell
$env:PAYPAL_CLIENT_ID = "..."
$env:PAYPAL_CLIENT_SECRET = "..."
$env:PAYPAL_WEBHOOK_ID = "..." # after registering a sandbox webhook
$env:AI_API_KEY = "..."
$env:AI_MODEL = "..."
# Optional for another compatible provider:
$env:AI_BASE_URL = "https://api.openai.com/v1"
npm start
```

Open `http://127.0.0.1:8787`. State is atomically written to
`data/scopeguard-state.json` by default; set `SCOPEGUARD_STATE_FILE` to use a
different protected path. No credentials are written into this state file.

The server refuses non-loopback binding. A real webhook deployment still needs
a separate authenticated HTTPS ingress on port 443 forwarding only
`POST /api/paypal/webhook` to this process. Configure that public URL in the
PayPal sandbox application and set its webhook ID in `PAYPAL_WEBHOOK_ID`.
Without that variable, the webhook route remains disabled. The local API also
exposes `POST /api/reconcile` with an `orderId` for explicit recovery checks.

Public deployment additionally requires managed secret storage, access control
for the browser/API routes, backups, and operational monitoring. Those controls
are not implied by this hackathon prototype.

Only USD is enabled because the current conversion is explicitly two-decimal.
Supporting other currencies requires a currency exponent table.

## Protocol references

- [PayPal Orders v2 integration](https://developer.paypal.com/api/rest/integration/orders-api)
- [PayPal webhook verification](https://developer.paypal.com/api/rest/webhooks/rest/)
- [PayPal webhook event names](https://developer.paypal.com/api/rest/webhooks/event-names/)

## Verification

Local verification on October 14, 2026:

- `npm test`: 25/25 controller, durability, webhook, AI-boundary,
  orchestration, and HTTP tests pass.
- `node --check`: all application modules pass syntax validation.
- `npm audit --omit=dev --audit-level=high`: zero vulnerabilities.
- Secret-pattern scan: no populated credentials or private keys found.
- Recovery coverage includes restart with a reserved order, response loss after
  remote create/capture, stable retry IDs, webhook tampering/replay, and the
  no-auto-capture approval invariant.
- The 94-second demonstration is H.264/AAC at 1440x900 and identifies its
  in-memory PayPal simulator in both the interface and narration.

No real AI-provider call or PayPal sandbox transaction is claimed yet.

## Remaining production-validation gates

1. Create or access PayPal developer sandbox credentials.
2. Put the verified webhook endpoint behind HTTPS, register it in the sandbox
   app, and exercise it with a real sandbox event.
3. Run and record the complete AI extraction, PayPal approval, capture, and
   reconciliation flow.
4. Replace the local JSON state store with managed durable storage and add
   authenticated remote ingress before any non-demo deployment.

## License

MIT
