import { AgentPayPalController } from './src/agent_paypal_controller.mjs';
import { InMemoryPayPalClient } from './src/paypal_client.mjs';

async function main() {
  console.log('PayPal ScopeGuard - local simulation only');
  console.log('No PayPal sandbox or real payment is used by this demo.\n');

  const client = new InMemoryPayPalClient();
  const controller = new AgentPayPalController({
    agentId: 'procurement-agent',
    maxPerTransactionMinor: 2_500,
    maxWindowMinor: 7_500,
    allowedMerchantCategories: ['AI_INFERENCE', 'CLOUD_COMPUTE', 'DEVELOPER_TOOLS'],
    client,
  });

  const proposal = await controller.proposePayment({
    clientRequestId: 'demo-inference-001',
    amountMinor: 1_200,
    currency: 'USD',
    merchantCategory: 'AI_INFERENCE',
    purpose: 'Purchase an inference credit batch',
  });
  console.log('1. Order proposal:', proposal);

  const premature = await controller.captureApprovedOrder(proposal.orderId);
  console.log('2. Capture before buyer approval:', premature.status);

  client.approveOrder(proposal.orderId);
  const settlement = await controller.captureApprovedOrder(proposal.orderId);
  console.log('3. Capture after simulated buyer approval:', settlement);

  const denied = await controller.proposePayment({
    clientRequestId: 'demo-disallowed-001',
    amountMinor: 500,
    currency: 'USD',
    merchantCategory: 'UNAPPROVED_CATEGORY',
    purpose: 'A request outside the operator policy',
  });
  console.log('4. Disallowed category:', denied.status, denied.error);

  console.log('\nIn-memory audit events:');
  console.table(controller.getAuditTrail());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
