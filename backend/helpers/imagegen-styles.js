/**
 * Image Generation - Event styles, theme styles, and festival definitions.
 * Ported from discount-image-generator/generator.py
 */

const EVENT_STYLES = {
  christmas:        'Christmas holiday theme \u2014 red & green color palette, snowflakes, Christmas ornaments, pine branches, snow effects, warm cozy lighting, festive ribbons',
  new_year:         'New Year celebration theme \u2014 midnight blue & gold palette, fireworks, confetti, champagne sparkle effects, countdown clock elements, glittery textures',
  valentines:       "Valentine's Day theme \u2014 red & pink palette, hearts, roses, soft romantic bokeh, satin/velvet textures, love-themed decorative elements",
  easter:           'Easter theme \u2014 pastel palette (lavender, mint, baby pink, soft yellow), Easter eggs, spring flowers, butterflies, soft natural light',
  memorial_day:     'Memorial Day theme \u2014 red, white & blue palette, patriotic stars, American flag elements, summer BBQ vibes, respectful and festive',
  independence_day: '4th of July theme \u2014 red, white & blue palette, stars, fireworks, patriotic ribbons, bold American flag-inspired design elements',
  labor_day:        'Labor Day theme \u2014 end of summer vibes, warm golden tones, relaxed outdoor atmosphere, patriotic accents, casual celebration mood',
  halloween:        'Halloween theme \u2014 dark orange & black palette, spooky fog, bats, cobwebs, jack-o-lantern glow, eerie moonlight, subtle creepy elegance',
  thanksgiving:     'Thanksgiving theme \u2014 warm autumn palette (burnt orange, deep red, gold), fall leaves, harvest elements, warm candlelight, rustic wood textures',
  black_friday:     'Black Friday theme \u2014 pure black & neon gold/red palette, bold dramatic lighting, cracked/shattered glass effects, intense urgency, maximum contrast',
  cyber_monday:     'Cyber Monday theme \u2014 dark tech-inspired palette with neon blue and electric green, digital grid effects, futuristic glowing elements',
  summer_sale:      'Summer sale theme \u2014 bright tropical palette (turquoise, coral, yellow), palm leaves, sun rays, beach vibes, gradient sunset sky, fresh and vibrant energy',
  super_bowl:       'Super Bowl theme \u2014 football field green, team spirit colors, stadium lights, bold sports typography, championship energy',
  st_patricks:      "St. Patrick's Day theme \u2014 green and gold palette, shamrocks, Celtic patterns, Irish pub warmth, lucky charm elements",
  cinco_de_mayo:    'Cinco de Mayo theme \u2014 vibrant Mexican fiesta colors (red, green, white), papel picado, sombreros, festive energy, colorful patterns',
};

const THEME_STYLES = {
  flash_sale_gold: {
    name: 'Flash Sale Gold',
    desc: "Dark moody slate/stone background. Gold metallic wax-seal 'SPECIAL OFFER' badge top-left. 'FLASH SALE!' headline in bold white and gold metallic text with light rays. Product bottle centered with crystal glass and dramatic lighting. Gold discount badge on the left showing the exact discount percentage. Strikethrough original price in white, bold yellow sale price. Dark footer bar with store name and 'SHOP NOW! LINK IN BIO.' White and gold color scheme on dark background.",
  },
  flash_sale_yellow: {
    name: 'Flash Sale Yellow',
    desc: "Warm wood/library background with table lamp and books. Yellow banner 'SPECIAL OFFER' badge top-left. 'FLASH SALE!' headline in bold white text on dark diagonal banner with yellow accents. Product bottle centered with crystal glass on wooden surface. Yellow discount badge showing the exact discount percentage. Strikethrough original price in white, bold yellow sale price. Dark footer bar with store name and 'SHOP NOW! LINK IN BIO.' Yellow and black color scheme on warm background.",
  },
};

const FESTIVAL_LIST = {
  christmas:        { name: 'Christmas',       emoji: '\uD83C\uDF84', colors: ['#c62828', '#2e7d32'] },
  new_year:         { name: 'New Year',         emoji: '\uD83C\uDF86', colors: ['#1a237e', '#ffd600'] },
  valentines:       { name: "Valentine's",      emoji: '\u2764\uFE0F', colors: ['#c62828', '#f48fb1'] },
  easter:           { name: 'Easter',           emoji: '\uD83D\uDC30', colors: ['#7b1fa2', '#81c784'] },
  memorial_day:     { name: 'Memorial Day',     emoji: '\uD83C\uDDFA\uD83C\uDDF8', colors: ['#b71c1c', '#1565c0'] },
  independence_day: { name: '4th of July',      emoji: '\uD83C\uDF87', colors: ['#b71c1c', '#1565c0'] },
  labor_day:        { name: 'Labor Day',        emoji: '\u2692\uFE0F', colors: ['#1565c0', '#c62828'] },
  halloween:        { name: 'Halloween',        emoji: '\uD83C\uDF83', colors: ['#e65100', '#212121'] },
  thanksgiving:     { name: 'Thanksgiving',     emoji: '\uD83E\uDD83', colors: ['#bf360c', '#ff8f00'] },
  black_friday:     { name: 'Black Friday',     emoji: '\uD83D\uDCB0', colors: ['#212121', '#ffd600'] },
  cyber_monday:     { name: 'Cyber Monday',     emoji: '\uD83D\uDCBB', colors: ['#0d47a1', '#00e676'] },
  summer_sale:      { name: 'Summer Sale',      emoji: '\u2600\uFE0F', colors: ['#00838f', '#ff6f00'] },
  super_bowl:       { name: 'Super Bowl',       emoji: '\uD83C\uDFC8', colors: ['#1b5e20', '#ff6f00'] },
  st_patricks:      { name: "St. Patrick's",    emoji: '\u2618\uFE0F', colors: ['#1b5e20', '#ffd600'] },
  cinco_de_mayo:    { name: 'Cinco de Mayo',    emoji: '\uD83C\uDF89', colors: ['#c62828', '#1b5e20'] },
};

module.exports = { EVENT_STYLES, THEME_STYLES, FESTIVAL_LIST };
