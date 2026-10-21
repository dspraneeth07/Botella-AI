// Wordmark.js
// -----------------------------------------------------------------------------
// The typographic brand mark: "Botella.ai".
//
// ONE mark for the whole product. The marketing chrome (SiteHeader, SiteFooter)
// and the signed-in app (Sidebar) all render this component, so the brand never
// drifts between the two halves of the product - previously the site said
// "botella.ai" in the display face while the sidebar said "Botella" in a
// different gradient, and they read as two companies.
//
// Drawn in type rather than as a bitmap: it is built from the same tokens as
// everything else - ink for the name, the signature gradient for the .ai - so
// it stays crisp at any size, flips correctly between the light and dark
// registers, and costs no image request.
//
// The PNG is still used for the favicon, the OG image and schema.org logo, so
// nothing outside the chrome changes.
// -----------------------------------------------------------------------------

import React from 'react';
import './Wordmark.css';

function Wordmark({ size = 'nav', className = '' }) {
  return (
    <span className={`wm wm-${size} ${className}`} aria-hidden="true">
      <span className="wm-name">Botella</span>
      <span className="wm-tld">.ai</span>
    </span>
  );
}

export default Wordmark;
