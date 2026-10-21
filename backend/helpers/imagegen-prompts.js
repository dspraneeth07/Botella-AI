/**
 * Image Generation - Prompt builders for OpenAI and Gemini.
 * Ported from discount-image-generator/generator.py
 */

const { EVENT_STYLES, THEME_STYLES } = require('./imagegen-styles');

const FORMAT_SIZES = {
  post:  { width: 1080, height: 1080, label: '1080\u00d71080 square',   aspect: 'square' },
  story: { width: 1080, height: 1920, label: '1080\u00d71920 vertical', aspect: '9:16 vertical' },
};

const OPENAI_SIZE_MAP = {
  post:  '1024x1024',
  story: '1024x1536',
};

// ── Discount / Festival Prompt ────────────────────────────────────

function buildDiscountPrompt({
  productName,
  originalPrice,
  discountPct,
  event = '',
  theme = 'flash_sale_gold',
  storeName = '',
  fmt = 'post',
  customInstructions = '',
}) {
  const discountedPrice = (originalPrice * (1 - discountPct / 100)).toFixed(2);
  const origStr = `$${Number(originalPrice).toFixed(2)}`;
  const discStr = `$${discountedPrice}`;
  const fmtInfo = FORMAT_SIZES[fmt] || FORMAT_SIZES.post;
  const displayStore = storeName ? storeName.trim().toUpperCase() : '';

  const eventDesc = EVENT_STYLES[event] || '';
  const themeData = THEME_STYLES[theme] || THEME_STYLES.flash_sale_gold;
  const styleLine = eventDesc
    ? `Festival theme: ${eventDesc}`
    : `Design theme: ${themeData.desc}`;
  const storeLine = displayStore
    ? `\nStore branding: Show "${displayStore}" with Instagram icon in the footer bar.`
    : '';

  return `Design a professional liquor promotional poster for Instagram/TikTok.

Product: "${productName}"
Original price: ${origStr} (show with strikethrough text reading exactly "WAS ${origStr}")
Sale price: ${discStr} (large, bold text reading exactly "NOW ${discStr}")
Discount percentage: EXACTLY ${discountPct}% OFF - this is the ONLY discount number allowed on the poster
Format: ${fmtInfo.label} \u2014 ${fmtInfo.aspect}

${styleLine}${storeLine}

CRITICAL TEXT REQUIREMENTS - READ CAREFULLY:
- The discount badge MUST read "${discountPct}% OFF" - NOT 50%, NOT any other number, EXACTLY ${discountPct}%
- Every place where a discount percentage appears on the poster MUST show ${discountPct}%
- The original price text MUST read "WAS ${origStr}" with a strikethrough line
- The sale price text MUST read "NOW ${discStr}" in large bold text
- The product name "${productName}" MUST be spelled exactly as provided, in large bold text
- DO NOT use 50% anywhere - the discount is ${discountPct}%
- DO NOT invent prices - the ONLY prices are ${origStr} (original) and ${discStr} (sale)

DESIGN REQUIREMENTS:
- The bottle must be photorealistic, centered, with dramatic professional lighting
- All text must be sharp, correctly spelled, and high contrast against the background
- Footer must include "SHOP NOW! LINK IN BIO." with a shopping bag icon
- Style: Premium spirits advertisement with professional photography lighting
${customInstructions ? `\nADDITIONAL CREATIVE DIRECTION FROM THE USER:\n${customInstructions}\nFollow the above user direction while keeping the overall professional look.` : ''}`;
}

// ── Generic / Brand Prompt ────────────────────────────────────────

function buildGenericPrompt({
  productName,
  productSize = '',
  event = '',
  theme = 'flash_sale_gold',
  storeName = '',
  fmt = 'post',
  customInstructions = '',
}) {
  const fmtInfo = FORMAT_SIZES[fmt] || FORMAT_SIZES.post;
  const displayStore = storeName ? storeName.trim().toUpperCase() : '';
  const sizeLine = productSize ? `\nSize/volume: ${productSize}` : '';

  const eventDesc = EVENT_STYLES[event] || '';
  const themeData = THEME_STYLES[theme] || THEME_STYLES.flash_sale_gold;
  const styleLine = eventDesc
    ? `Festival theme: ${eventDesc}`
    : `Design theme: ${themeData.desc}`;
  const storeLine = displayStore
    ? `\nStore branding: Show "${displayStore}" with Instagram icon in the footer bar.`
    : '';

  return `Design a professional liquor brand showcase poster for Instagram/TikTok.

Product: "${productName}"${sizeLine}
Format: ${fmtInfo.label} \u2014 ${fmtInfo.aspect}

${styleLine}${storeLine}

CRITICAL REQUIREMENTS:
- Product name "${productName}" in large bold text at top
- Bottle centered, photorealistic, with dramatic lighting and props (crystal glass, etc.)
- Dark footer with store branding and "SHOP NOW! LINK IN BIO."
- NO prices, NO discounts \u2014 brand awareness only
- All text must be sharp, correctly spelled, and high contrast
- Style: Premium spirits advertisement with professional photography lighting
${customInstructions ? `\nADDITIONAL CREATIVE DIRECTION FROM THE USER:\n${customInstructions}\nFollow the above user direction while keeping the overall professional look.` : ''}`;
}

// ── Video Prompt (Gemini Veo) ─────────────────────────────────────

function buildVideoPrompt({
  productName,
  originalPrice = 0,
  discountPct = 0,
  productDescription = '',
  event = '',
  theme = 'flash_sale_gold',
  storeName = '',
  isDiscount = true,
}) {
  const displayStore = storeName ? storeName.trim().toUpperCase() : '';
  const descLine = productDescription ? ` (${productDescription})` : '';

  const eventDesc = EVENT_STYLES[event] || '';
  const themeData = THEME_STYLES[theme] || THEME_STYLES.flash_sale_gold;
  const styleSection = eventDesc
    ? `Visual theme: ${eventDesc}`
    : `Visual style: ${themeData.desc}`;

  let priceSection = '';
  if (isDiscount && originalPrice > 0 && discountPct > 0) {
    priceSection = `\n4. DISCOUNT REVEAL (6-8s): Bold text "${discountPct}% OFF" appears at the bottom center of the frame in large white bold font, with "LIMITED TIME SALE" subtitle underneath. The text fades/slides in smoothly over the hero shot.\n`;
  }

  const storeSection = displayStore
    ? `\nShow store name "${displayStore}" text at the bottom in the final seconds.`
    : '';

  return `Create a premium cinematic product advertisement video for a liquor/spirits bottle called "${productName}".${descLine}

CINEMATIC STYLE:
- Dark moody background with dynamic glowing light trails/streaks swirling and orbiting around the bottle
- Warm amber and cool blue lighting contrast
- Reflective dark surface beneath the bottle
- Ultra-smooth slow-motion camera movement
- Professional product photography lighting with rim lights and dramatic shadows

SHOT SEQUENCE:
1. OPENING (0-2s): The bottle appears floating at a dramatic tilted angle, rotating slowly in mid-air. Bright glowing light trails and energy streaks swirl dynamically around it against a dark background. Cinematic lens flares.

2. LANDING (2-4s): The bottle smoothly transitions to standing upright on a dark reflective surface. Ice cubes are scattered around the base. The swirling light trails continue in the background.

3. HERO SHOT (4-6s): Full product showcase \u2014 the bottle is centered and upright on the reflective surface, surrounded by ice cubes and fresh citrus fruits as props. The glowing light trails continue swirling in the background.
${priceSection}
${styleSection}${storeSection}

CRITICAL:
- The bottle must be photorealistic and prominently labeled "${productName}"
- Light trails must be dynamic, glowing, and continuously swirling throughout the video
- The overall feel should be like a high-end Super Bowl spirits commercial
- 9:16 vertical format for Instagram/TikTok
`;
}

module.exports = {
  buildDiscountPrompt,
  buildGenericPrompt,
  buildVideoPrompt,
  FORMAT_SIZES,
  OPENAI_SIZE_MAP,
};
