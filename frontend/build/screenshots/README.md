# Product screenshots

Real screenshots used across the public marketing site.

## How the site consumes images

Each hero is a plain `<img src="/screenshots/<name>.png">` - **PNG only, no
WebP.** Whatever PNG sits in this folder is exactly what the website shows, so
**to change an image you just replace the PNG file here (keep the same name).**

> ⚠ The website serves files from **THIS** folder (`frontend/public/screenshots/`).
> The top-level `Screen shots/` folder at the repo root is **NOT** used by the
> site - it was only a one-time source. Always edit images here.

After replacing a file:

- **Dev server (`npm start`)** - hard-refresh the browser (**Ctrl+Shift+R**).
  Images are cached by filename, so a normal refresh keeps showing the old one.
- **Production** - run `npm run build` again (that copies this folder into
  `frontend/build/`, which the backend serves), then reload.

Optional: `python _optimize.py` shrinks any PNG over 800 px on its longest side
(re-saved optimised, still PNG). Only needed for oversized raw captures.

## Naming convention

| Use it for | File name pattern |
|---|---|
| **Dashboard captures** | `dashboard-<view>.png` |
| **Chat conversation captures** | `chat-<topic>.png` |
| **Inventory list captures** | `inventory-<filter>.png` |
| **Customer segment captures** | `customers-<segment>.png` |
| **Sales-analytics chart captures** | `analytics-<view>.png` |
| **Margin breakdown captures** | `margin-<category>.png` |
| **Promo / image-gen samples (legacy)** | `promo-<sku>.png` |

## What we already have

**Wired into SEO page heroes** (real product captures on "Zeke's Liquor" data):

| File | Wired into |
|---|---|
| `chat-dead-stock.png` | AI Agent hero (`/ai-agent-for-liquor-stores`) |
| `dashboard-inventory-health.png` | Sales Analytics hero (`/liquor-store-sales-analytics-insights`) - full dashboard |
| `inventory-health.png` | Inventory hero (`/ai-inventory-management-liquor-stores`) |
| `margin-by-category.png` | Margin Optimization hero (`/margin-optimization-liquor-stores`) |

**Staged in this folder, not yet wired** (no designated slot - available for a
home-page hero, a gallery, or secondary sections):

- `dashboard-overview.png` - KPI strip (subset of the full dashboard)
- `analytics-top-products.png` - top-products bar chart
- `analytics-category.png` - revenue-by-category donut
- `revenue-trend.png` - 30-day revenue area chart
- `analytics-peak-hours.png` - chat: busiest sales hours

> `analytics-top-products`, `analytics-category`, and `revenue-trend` are crops
> of the same dashboard already shown on the Sales Analytics hero, so wiring
> them there would be redundant - better for the home page or a gallery.

**Promo / image-gen samples (legacy):**

- `promo-jack-daniels.png`, `promo-kingfisher.png`, `promo-royal-challenge.png`
  - real Image-Generation outputs. (The Image-Gen feature was removed on
  2026-06-09; these remain only as sample assets and aren't referenced by any page.)

## What we still need

Real captures for the pages that still use CSS-only mockups:

1. **Customer segment view** - for Customer Insights hero (`/customer-insights-liquor-stores`)
2. **Product recommendation example** - for Product Recommendations hero (`/ai-product-recommendations-liquor-stores`)
3. **Multi-store / retailer overview** - for Retailers hero (`/ai-for-liquor-retailers`)

To wire one in: drop a `.png` matching the naming convention above into this
folder, then in the page swap the `<div className="hv hv-*">` mockup for:

```jsx
<img
  className="cp-hero-shot"
  src="/screenshots/<name>.png"
  alt="<description>"
  loading="lazy"
/>
```

## Image specs

- **Format**: PNG only (no WebP).
- **Max width on longest side**: 800 px recommended - run `python _optimize.py` to shrink oversized captures (optional).
- **Color profile**: sRGB.
- **Recommended capture**: dark UI to match the site; capture at a consistent width so the heroes look uniform.
