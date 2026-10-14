export class SimulatedIntentAdapter {
  constructor(options = {}) {
    this.allowedCurrencies = options.allowedCurrencies || ['USD'];
    this.allowedMerchantCategories = options.allowedMerchantCategories || [
      'AI_INFERENCE',
      'CLOUD_COMPUTE',
      'DEVELOPER_TOOLS',
      'DATA_FEEDS',
    ];
  }

  async interpret(instruction) {
    const text = String(instruction || '').toLowerCase();

    // Extract dollar amount if specified: "$12.00", "12.00", "$12", "12 dollars"
    const match = text.match(/(?:\$|\b)(\d+(?:\.\d{1,2})?)/);
    let amountFloat = match ? parseFloat(match[1]) : 12.0;
    if (Number.isNaN(amountFloat) || amountFloat <= 0) {
      amountFloat = 12.0;
    }
    const amountMinor = Math.round(amountFloat * 100);

    // Determine category based on intent keywords
    let merchantCategory = 'AI_INFERENCE';
    if (text.includes('compute') || text.includes('server') || text.includes('instance') || text.includes('gpu')) {
      merchantCategory = 'CLOUD_COMPUTE';
    } else if (text.includes('tool') || text.includes('ide') || text.includes('license') || text.includes('github')) {
      merchantCategory = 'DEVELOPER_TOOLS';
    } else if (text.includes('data') || text.includes('feed') || text.includes('market')) {
      merchantCategory = 'DATA_FEEDS';
    } else if (
      text.includes('crypto') ||
      text.includes('casino') ||
      text.includes('gambling') ||
      text.includes('bet') ||
      text.includes('unauthorized')
    ) {
      merchantCategory = 'HIGH_RISK_PROHIBITED';
    }

    return {
      amountMinor,
      currency: 'USD',
      merchantCategory,
      purpose: instruction.slice(0, 100) || 'Autonomous purchase intent',
    };
  }
}
