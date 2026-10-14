const form = document.querySelector('#proposal-form');
const result = document.querySelector('#result');
const capturePanel = document.querySelector('#capture-panel');
const returnedOrder = document.querySelector('#returned-order');
const captureButton = document.querySelector('#capture-button');
const instructionInput = document.querySelector('#instruction');
const presetButtons = document.querySelectorAll('.preset-btn');
const refreshAuditBtn = document.querySelector('#refresh-audit-btn');
const auditTbody = document.querySelector('#audit-tbody');

const agentIdBadge = document.querySelector('#agent-id-badge');
const statMaxSingle = document.querySelector('#stat-max-single');
const statMaxWindow = document.querySelector('#stat-max-window');
const statCommitted = document.querySelector('#stat-committed');
const statReserved = document.querySelector('#stat-reserved');
const statRemaining = document.querySelector('#stat-remaining');

function formatUsd(cents) {
  if (typeof cents !== 'number' || Number.isNaN(cents)) return '$0.00';
  return '$' + (cents / 100).toFixed(2);
}

function formatTime(timestamp) {
  if (!timestamp) return 'Just now';
  try {
    const d = new Date(timestamp);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return String(timestamp);
  }
}

function showResult(title, value, kind = 'normal') {
  result.hidden = false;
  result.dataset.kind = kind;
  result.replaceChildren();

  const heading = document.createElement('h2');
  heading.textContent = title;
  const output = document.createElement('pre');
  output.textContent = JSON.stringify(value, null, 2);
  result.append(heading, output);
}

async function postJson(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.message || payload.error || 'Request failed');
  return payload;
}

async function fetchAudit() {
  try {
    const response = await fetch('/api/audit');
    if (!response.ok) return;
    const data = await response.json();

    if (data.agentId && agentIdBadge) {
      agentIdBadge.textContent = `Agent: ${data.agentId}`;
    }
    if (statMaxSingle && typeof data.maxPerTransactionMinor === 'number') {
      statMaxSingle.textContent = formatUsd(data.maxPerTransactionMinor);
    }
    if (statMaxWindow && typeof data.maxWindowMinor === 'number') {
      statMaxWindow.textContent = formatUsd(data.maxWindowMinor);
    }
    if (statCommitted && typeof data.committedMinor === 'number') {
      statCommitted.textContent = formatUsd(data.committedMinor);
    }
    if (statReserved && typeof data.reservedMinor === 'number') {
      statReserved.textContent = formatUsd(data.reservedMinor);
    }
    if (statRemaining && typeof data.remainingMinor === 'number') {
      statRemaining.textContent = formatUsd(data.remainingMinor);
    }

    if (auditTbody) {
      const events = Array.isArray(data.events) ? data.events : [];
      if (events.length === 0) {
        auditTbody.innerHTML = '<tr><td colspan="6" class="empty-state">No audit events recorded yet. Propose a purchase above to trigger evaluation.</td></tr>';
        return;
      }

      auditTbody.replaceChildren();
      // Show newest events first
      const reversed = [...events].reverse();
      for (const ev of reversed) {
        const row = document.createElement('tr');

        const tdTime = document.createElement('td');
        tdTime.textContent = formatTime(ev.timestamp);

        const tdStatus = document.createElement('td');
        const pill = document.createElement('span');
        pill.className = `status-pill pill-${(ev.status || 'unknown').toLowerCase()}`;
        pill.textContent = ev.status || 'UNKNOWN';
        tdStatus.appendChild(pill);

        const tdAmount = document.createElement('td');
        tdAmount.textContent = ev.amountMinor != null ? formatUsd(ev.amountMinor) : '—';
        tdAmount.className = 'cell-amount';

        const tdCat = document.createElement('td');
        const catBadge = document.createElement('code');
        catBadge.textContent = ev.merchantCategory || '—';
        tdCat.appendChild(catBadge);

        const tdDetails = document.createElement('td');
        if (ev.reason) {
          tdDetails.textContent = `Denied: ${ev.reason}`;
          tdDetails.className = 'cell-reason';
        } else if (ev.captureId) {
          tdDetails.textContent = `Capture: ${ev.captureId}`;
          tdDetails.className = 'cell-success';
        } else if (ev.orderId) {
          tdDetails.textContent = `Order: ${ev.orderId}`;
        } else {
          tdDetails.textContent = '—';
        }

        const tdReqId = document.createElement('td');
        const reqCode = document.createElement('code');
        reqCode.title = ev.clientRequestId || '';
        reqCode.textContent = ev.clientRequestId ? ev.clientRequestId.slice(0, 8) + '...' : '—';
        tdReqId.appendChild(reqCode);

        row.append(tdTime, tdStatus, tdAmount, tdCat, tdDetails, tdReqId);
        auditTbody.appendChild(row);
      }
    }
  } catch (err) {
    console.error('Failed to fetch audit ledger:', err);
  }
}

// Preset button click handling
presetButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    const text = btn.dataset.instruction;
    if (text && instructionInput) {
      instructionInput.value = text;
      instructionInput.focus();
      instructionInput.classList.add('flash-highlight');
      setTimeout(() => instructionInput.classList.remove('flash-highlight'), 600);
    }
  });
});

if (refreshAuditBtn) {
  refreshAuditBtn.addEventListener('click', () => {
    fetchAudit();
  });
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  showResult('Checking request', { status: 'AI extraction and deterministic policy evaluation in progress' });

  try {
    const payload = await postJson('/api/proposals', {
      clientRequestId: crypto.randomUUID(),
      instruction: new FormData(form).get('instruction'),
    });
    showResult('Proposal result', payload, payload.proposal.success ? 'success' : 'denied');

    if (payload.proposal.approvalUrl) {
      const link = document.createElement('a');
      link.className = 'approval-link';
      link.href = payload.proposal.approvalUrl;
      link.textContent = 'Continue to PayPal sandbox approval →';
      result.append(link);
    }
  } catch (error) {
    showResult('Request failed', { error: error.message }, 'error');
  } finally {
    button.disabled = false;
    await fetchAudit();
  }
});

const params = new URLSearchParams(window.location.search);
const returnedToken = params.get('token');
if (params.get('paypal') === 'approved' && returnedToken) {
  capturePanel.hidden = false;
  returnedOrder.textContent = returnedToken;
}

captureButton.addEventListener('click', async () => {
  captureButton.disabled = true;
  try {
    const payload = await postJson('/api/capture', { orderId: returnedToken });
    showResult('Capture result', payload, 'success');
    capturePanel.hidden = true;
  } catch (error) {
    showResult('Capture failed', { error: error.message }, 'error');
    captureButton.disabled = false;
  } finally {
    await fetchAudit();
  }
});

// Initial load
fetchAudit();
