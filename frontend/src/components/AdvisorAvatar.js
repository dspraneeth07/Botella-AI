// AdvisorAvatar.js
// -----------------------------------------------------------------------------
// Shared advisor avatar used by /advisors and the homepage advisors strip.
// Shows the headshot when present, and a branded initials tile when the image
// is missing or 404s (onError swap) - so a not-yet-added photo degrades
// cleanly instead of showing a broken-image glyph. Styling lives in
// pages/AdvisorsPage.css (.adv-avatar*), which both callers already import.
// -----------------------------------------------------------------------------

import React, { useState } from 'react';

// Initials from a name, e.g. "Anirudh Reddy" -> "AR". Two letters max.
export function initialsOf(name) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('');
}

export default function AdvisorAvatar({ name, img, className = '' }) {
  const [failed, setFailed] = useState(false);
  const showImg = img && !failed;
  return (
    <div className={`adv-avatar ${showImg ? 'has-img' : ''} ${className}`.trim()}>
      {showImg ? (
        <img
          src={img}
          alt={`${name} headshot`}
          loading="lazy"
          onError={() => setFailed(true)}
        />
      ) : (
        <span className="adv-avatar-initials" aria-hidden="true">{initialsOf(name)}</span>
      )}
    </div>
  );
}
