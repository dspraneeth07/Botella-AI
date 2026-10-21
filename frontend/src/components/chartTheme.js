import React, { useState, useEffect } from 'react';

/* =============================================================================
   CHART THEME - the palette and the glass/gloss marks, shared by every chart
   -----------------------------------------------------------------------------
   Extracted from Dashboard.js when the charts moved to the Statistics page, so
   both pages draw from one definition instead of drifting apart.
   ============================================================================= */

// -- Chart palette: "glass" marks --------------------------------------------
// The frosted material lives in the CARD (backdrop-filter, see app-theme.css).
// The marks themselves stay opaque: a glass mark is a two-step gradient of ONE
// hue - a lit step falling through the base step to a shadowed one - plus a
// white rim and a hue-tinted lift. It is deliberately NOT an alpha fade.
// Translucent fills composite toward the surface, and measuring that composite
// showed it drops the palette under its contrast floor (all 10 below 3:1 at
// 62% alpha) and its normal-vision separation floor: it would look like glass
// and read like mud.
//
// Both step sets sit inside the brand arc (jade -> cyan -> indigo -> violet ->
// fuchsia -> magenta) and are validated against the data-viz checks - lightness
// band, chroma floor, adjacent CVD separation, normal-vision floor, contrast:
//   dark  on #121215 - CVD 12.0, normal 19.4, all 10 >= 3:1  (PASS; the ground
//                       went darker than the #181328 these were measured on,
//                       so every step GAINS contrast rather than losing it)
//   light on #FFFFFF - CVD 11.4, normal 17.4, all 10 >= 3:1  (PASS)
// The palette this replaced failed four of those five checks on this surface.
//
// Slice identity is never carried by colour alone: every slice is named in the
// legend list beside the pie and again in its tooltip.
export const CHART_THEME = {
  dark: {
    surface: '#121215',
    // base - the validated identity step
    series: ['#9070F3', '#D9157D', '#CE31FC', '#0A9D80', '#3393FE', '#C231AD', '#4650FB', '#209CCE', '#AC30FB', '#0275A9'],
    // lit - same hue, +0.11 L: the top of the glass
    seriesLit: ['#AF9CFF', '#FD509E', '#DF83FF', '#4EBFA2', '#7FB8FF', '#E55ECE', '#6A82FF', '#57BFF0', '#C279FF', '#4096CA'],
    // deep - same hue, -0.09 L: the shadowed underside
    seriesDeep: ['#7654D4', '#B00063', '#AD00D8', '#007F67', '#0576DF', '#A30090', '#342CDB', '#0080AC', '#8E00D6', '#005A84'],
    // Reserved neutral for the grouped "Other" slice - intentionally below the
    // chroma floor so it never reads as one of the real categories.
    other: '#8E86A8', otherLit: '#B0A8CA', otherDeep: '#736C8C',
    grid: 'rgba(255, 255, 255, 0.10)',
    axis: '#90909C',
    tick: '#C8C8D0',
    rim: 'rgba(255, 255, 255, 0.46)',
    rimSoft: 'rgba(255, 255, 255, 0.20)',
    glow: 'rgba(144, 112, 243, 0.55)',
    // The specular sweep. Painted OVER the mark, so it lightens without
    // touching the hue the palette was validated on.
    gloss: 'rgba(255, 255, 255, 0.50)',
    glossMid: 'rgba(255, 255, 255, 0.13)',
  },
  light: {
    surface: '#FFFFFF',
    series: ['#906DF7', '#9A0D57', '#AB23D3', '#019C7F', '#2F8BF2', '#920981', '#4753F8', '#0186B4', '#A011EF', '#308EC4'],
    seriesLit: ['#AE9BFF', '#BD3F76', '#CD56F4', '#4CBEA1', '#6FB0FF', '#B43FA1', '#6B83FF', '#46A8D5', '#BA62FF', '#5CB0E5'],
    seriesDeep: ['#7650D8', '#73003F', '#8A00AD', '#007E66', '#006FD3', '#6D0060', '#3431D8', '#006A90', '#7F00C0', '#0073A7'],
    other: '#7B7392', otherLit: '#9C94B3', otherDeep: '#615977',
    grid: 'rgba(46, 16, 101, 0.11)',
    axis: '#524B66',
    tick: '#3B3550',
    rim: 'rgba(255, 255, 255, 0.76)',
    rimSoft: 'rgba(255, 255, 255, 0.34)',
    glow: 'rgba(109, 40, 217, 0.24)',
    gloss: 'rgba(255, 255, 255, 0.62)',
    glossMid: 'rgba(255, 255, 255, 0.18)',
  },
};

// Reads the theme the app shell writes onto <html> (ChatPage owns the toggle)
// and re-renders the charts when it flips. Dark mode is a SELECTED set of steps
// from the same hues, not an automatic inversion of the light one.
export function useChartTheme() {
  const read = () => (document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark');
  const [mode, setMode] = useState(read);
  useEffect(() => {
    const obs = new MutationObserver(() => setMode(read()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    setMode(read());
    return () => obs.disconnect();
  }, []);
  return CHART_THEME[mode];
}

// Slot lookup. Colour follows the entity's slot, never a cycled hue: past the
// 10 documented steps everything is already folded into "Other" upstream, so
// there is no 11th generated colour.
export const sliceStep = (theme, entry, i, kind) => {
  if (entry && entry.category === 'Other') {
    return kind === 'lit' ? theme.otherLit : kind === 'deep' ? theme.otherDeep : theme.other;
  }
  const set = kind === 'lit' ? theme.seriesLit : kind === 'deep' ? theme.seriesDeep : theme.series;
  return set[i % set.length];
};

// A slice's paint: the gradient for the SVG, a flat step for HTML swatches
// (legend dots, tooltip dots) which cannot reference an SVG gradient.
export const sliceFill = (id, entry, i) => (entry && entry.category === 'Other'
  ? `url(#${id}-slice-other)`
  : `url(#${id}-slice-${i})`);

// <defs> shared by every glass mark in one chart. `id` namespaces the gradient
// ids so two charts on the same page never collide.
//
// NOT a component, and it must stay that way: Recharts renders a chart's
// children through renderByOrder(), which keeps a child only if it is a literal
// SVG tag or a Recharts type it knows. A custom component's type is a function,
// so <GlassDefs /> is dropped silently - and marks whose fill/filter then point
// at missing defs do not paint at all. Called as a function, the child the
// chart actually receives is the <defs> element.
export function glassDefs({ id, theme, count = 0, vertical = false }) {
  return (
    <defs>
      {/* Single-series marks: lit -> base -> deep along the mark. */}
      <linearGradient id={`${id}-bar`} x1="0" y1="0" x2={vertical ? '0' : '1'} y2={vertical ? '1' : '0'}>
        <stop offset="0%" stopColor={theme.seriesLit[0]} />
        <stop offset="55%" stopColor={theme.series[0]} />
        <stop offset="100%" stopColor={theme.seriesDeep[0]} />
      </linearGradient>
      {/* Area wash: this one MAY fade, because a lone series carries no
          categorical identity for the alpha to erode. */}
      <linearGradient id={`${id}-wash`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor={theme.seriesLit[0]} stopOpacity={0.42} />
        <stop offset="55%" stopColor={theme.series[0]} stopOpacity={0.16} />
        <stop offset="100%" stopColor={theme.series[0]} stopOpacity={0} />
      </linearGradient>
      {/* Per-slot slice gradients, lit from the top-left like the cards. */}
      {Array.from({ length: count }, (_, i) => (
        <linearGradient key={i} id={`${id}-slice-${i}`} x1="0.15" y1="0" x2="0.85" y2="1">
          <stop offset="0%" stopColor={theme.seriesLit[i % theme.seriesLit.length]} />
          <stop offset="52%" stopColor={theme.series[i % theme.series.length]} />
          <stop offset="100%" stopColor={theme.seriesDeep[i % theme.seriesDeep.length]} />
        </linearGradient>
      ))}
      <linearGradient id={`${id}-slice-other`} x1="0.15" y1="0" x2="0.85" y2="1">
        <stop offset="0%" stopColor={theme.otherLit} />
        <stop offset="52%" stopColor={theme.other} />
        <stop offset="100%" stopColor={theme.otherDeep} />
      </linearGradient>
      {/* The specular sweep, painted as a separate pass ON TOP of a mark.
          Every gradient here is in objectBoundingBox units, so each mark is lit
          from its own top edge and the sheen tracks the geometry at any size -
          no userSpaceOnUse coordinates to go stale inside ResponsiveContainer.
          Because it is an overlay rather than a change to the fill, the
          validated hue underneath is untouched. */}
      <linearGradient id={`${id}-gloss`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor={theme.gloss} />
        <stop offset="38%" stopColor={theme.glossMid} />
        <stop offset="54%" stopColor="rgba(255, 255, 255, 0)" />
        <stop offset="100%" stopColor="rgba(255, 255, 255, 0)" />
      </linearGradient>
      {/* The area wash is already part-transparent, so the full-strength sheen
          lands on top of very little hue and greys the whole fill out. This one
          is pitched to about a third of it. */}
      <linearGradient id={`${id}-gloss-soft`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor="rgba(255, 255, 255, 0.20)" />
        <stop offset="22%" stopColor="rgba(255, 255, 255, 0.05)" />
        <stop offset="40%" stopColor="rgba(255, 255, 255, 0)" />
        <stop offset="100%" stopColor="rgba(255, 255, 255, 0)" />
      </linearGradient>
      {/* Ring bevel. Painted OVER the body as a separate pass, so the hue the
          palette was validated on is untouched - this only shades it. The inner
          edge falls away, the outer edge catches the light, and the ring reads
          as a thick torus rather than a flat annulus. */}
      <radialGradient id={`${id}-bevel`} cx="0.5" cy="0.5" r="0.5">
        <stop offset="0.57" stopColor="#000000" stopOpacity={0.20} />
        <stop offset="0.72" stopColor="#000000" stopOpacity={0.06} />
        <stop offset="0.85" stopColor="#000000" stopOpacity={0} />
        <stop offset="0.95" stopColor="#FFFFFF" stopOpacity={0} />
        <stop offset="1" stopColor="#FFFFFF" stopOpacity={0.16} />
      </radialGradient>
      {/* Slice sheen: struck across the corner so the ring reads as faceted
          glass rather than ten flat wedges. */}
      <linearGradient id={`${id}-gloss-arc`} x1="0.1" y1="0" x2="0.75" y2="1">
        <stop offset="0%" stopColor={theme.gloss} />
        <stop offset="32%" stopColor={theme.glossMid} />
        <stop offset="54%" stopColor="rgba(255, 255, 255, 0.04)" />
        <stop offset="76%" stopColor="rgba(255, 255, 255, 0)" />
        <stop offset="100%" stopColor="rgba(255, 255, 255, 0)" />
      </linearGradient>
      {/* The lift that makes a mark sit ON the pane rather than in it. */}
      <filter id={`${id}-lift`} x="-25%" y="-25%" width="150%" height="150%">
        <feDropShadow dx="0" dy="2" stdDeviation="5" floodColor={theme.glow} floodOpacity="1" />
      </filter>
      {/* Neon bloom: light coming OFF the mark, as opposed to `-lift`, which is
          the shadow grounding it on the pane. Built as blur-then-merge rather
          than a drop shadow so the halo sits around the whole silhouette
          instead of only below it. The source graphic is merged back on top, so
          the mark's own validated colour is never softened - only haloed. */}
      <filter id={`${id}-glow`} x="-45%" y="-45%" width="190%" height="190%">
        <feGaussianBlur in="SourceGraphic" stdDeviation="7" result="halo" />
        <feColorMatrix
          in="halo"
          type="matrix"
          values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 0.75 0"
          result="haloSoft"
        />
        <feMerge>
          <feMergeNode in="haloSoft" />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
      </filter>
    </defs>
  );
}

// A bar drawn in three passes: the hue underneath, the specular sweep, then the
// lit edge that sells a surface as polished. Recharts' own `radius` prop only
// reaches its DEFAULT shape, so the rounded cap is drawn here - r clamped so a
// short bar cannot invert its own corners.
//
// `vertical` follows Recharts' sense of the word: a column growing up from the
// baseline. The cap and the sheen move to the top edge, and the sheen is kept
// shallow there because a column is tall enough that a half-height highlight
// would read as two colours rather than one polished one.
export function GlossyBar(props) {
  const { x, y, width, height, gradId, rim, rimSoft, vertical = false } = props;
  if (!(width > 0) || !(height > 0)) return null;

  let body;
  let sheen;
  let edge;

  if (vertical) {
    const r = Math.min(4, height, width / 2);
    const gh = Math.min(height, Math.max(6, height * 0.3));
    body = `M${x} ${y + r} A${r} ${r} 0 0 1 ${x + r} ${y} H${x + width - r}`
      + ` A${r} ${r} 0 0 1 ${x + width} ${y + r} V${y + height} H${x} Z`;
    sheen = `M${x} ${y + r} A${r} ${r} 0 0 1 ${x + r} ${y} H${x + width - r}`
      + ` A${r} ${r} 0 0 1 ${x + width} ${y + r} V${y + gh} H${x} Z`;
    edge = `M${x + r} ${y + 0.5} H${x + width - r}`;
  } else {
    const r = Math.min(4, width, height / 2);
    const gh = height * 0.5;
    body = `M${x} ${y} H${x + width - r} A${r} ${r} 0 0 1 ${x + width} ${y + r}`
      + ` V${y + height - r} A${r} ${r} 0 0 1 ${x + width - r} ${y + height} H${x} Z`;
    sheen = `M${x} ${y} H${x + width - r} A${r} ${r} 0 0 1 ${x + width} ${y + r}`
      + ` V${y + gh} H${x} Z`;
    edge = `M${x} ${y + 0.5} H${x + width - r}`;
  }

  return (
    <g>
      <path d={body} fill={`url(#${gradId}-bar)`} stroke={rimSoft} strokeWidth={1} />
      <path d={sheen} fill={`url(#${gradId}-gloss)`} pointerEvents="none" />
      <path d={edge} stroke={rim} strokeWidth={1} fill="none" pointerEvents="none" />
    </g>
  );
}
