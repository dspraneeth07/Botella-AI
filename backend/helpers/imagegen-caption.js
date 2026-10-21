/**
 * AI Caption Generator - Uses Claude to generate social media captions.
 * Reuses the existing Anthropic SDK already in the project.
 */

const Anthropic = require('@anthropic-ai/sdk');

let _client = null;

function getClient() {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  _client = new Anthropic({ apiKey });
  return _client;
}

/**
 * Generate a social media caption for a product promo image.
 */
async function generateCaption({ productName, originalPrice, discountPct, event, genType, platform = 'instagram' }) {
  const client = getClient();

  // Fallback if no Anthropic key
  if (!client) {
    return buildFallbackCaption({ productName, originalPrice, discountPct, event, genType });
  }

  const discountedPrice = originalPrice && discountPct
    ? (originalPrice * (1 - discountPct / 100)).toFixed(2)
    : null;

  let context = `Product: ${productName}`;
  if (genType === 'discount' || genType === 'festival') {
    context += `\nOriginal Price: $${originalPrice}`;
    context += `\nDiscount: ${discountPct}% OFF`;
    context += `\nSale Price: $${discountedPrice}`;
  }
  if (event) context += `\nEvent/Festival: ${event}`;
  context += `\nType: ${genType === 'generic' ? 'Brand awareness' : 'Promotional sale'}`;
  context += `\nPlatform: ${platform}`;

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 300,
      temperature: 0.8,
      messages: [{
        role: 'user',
        content: `Write a short, engaging social media caption for a liquor store promotional post on ${platform}.

${context}

Requirements:
- Keep it under 150 words
- Include 3-5 relevant hashtags at the end
- Use emojis sparingly (2-3 max)
- Include a call to action (e.g., "Link in bio", "Visit us today")
- Match the tone to the platform (Instagram = visual/trendy, Facebook = community/informative)
- If it's a discount/sale, emphasize urgency and savings
- If it's brand awareness, focus on quality and experience

Return ONLY the caption text, nothing else.`,
      }],
    });

    return response.content[0]?.text?.trim() || buildFallbackCaption({ productName, originalPrice, discountPct, event, genType });
  } catch (err) {
    console.error('[ImageGen] Caption generation error:', err.message);
    return buildFallbackCaption({ productName, originalPrice, discountPct, event, genType });
  }
}

/**
 * Fallback caption when AI is unavailable.
 */
function buildFallbackCaption({ productName, originalPrice, discountPct, event, genType }) {
  if (genType === 'generic') {
    return `Discover ${productName} \u2014 premium quality, unforgettable taste. Available now!\n\nShop now \u2014 link in bio.\n\n#liquorstore #spirits #${productName.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()} #cheers #premiumspirits`;
  }

  const discountedPrice = originalPrice && discountPct
    ? (originalPrice * (1 - discountPct / 100)).toFixed(2)
    : null;

  let caption = `\uD83D\uDD25 ${discountPct}% OFF ${productName}!`;
  if (originalPrice && discountedPrice) {
    caption += `\n\nWas $${originalPrice} \u2192 Now $${discountedPrice}`;
  }
  if (event) {
    caption += `\n\n${event.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())} Special!`;
  }
  caption += `\n\nLimited time offer \u2014 don't miss out! Link in bio.`;
  caption += `\n\n#sale #discount #liquorstore #${productName.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()} #deals`;

  return caption;
}

module.exports = { generateCaption };
