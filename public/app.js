const form = document.querySelector('#proposal-form');
const result = document.querySelector('#result');
const capturePanel = document.querySelector('#capture-panel');
const returnedOrder = document.querySelector('#returned-order');
const captureButton = document.querySelector('#capture-button');

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

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = form.querySelector('button');
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
      link.textContent = 'Continue to PayPal sandbox approval';
      result.append(link);
    }
  } catch (error) {
    showResult('Request failed', { error: error.message }, 'error');
  } finally {
    button.disabled = false;
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
  }
});
