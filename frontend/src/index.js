import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { applyTheme, readPreference } from './utils/useTheme';
// The brand system (--bx-* tokens: palette, the two type faces, gradients).
// Loaded at the root rather than per-page: the signed-in app now draws on the
// same tokens as the marketing site (the shared <Wordmark>, the signal chips,
// the screen palettes), so they must be present on every route, not only the
// ones that import brand.css for their own layout classes.
import './styles/brand.css';
import './styles/global.css';
// Re-points the app's palette at the brand system and adds the shared glass
// surface. Must load AFTER global.css - it overrides those tokens.
import './styles/app-theme.css';

// Stamp <html data-theme> before the first paint. React mounting is a frame or
// two away, and without this the page paints the default register and then
// flips - the "flash of wrong theme" - which is most obvious for someone whose
// preference is Light or whose OS is set to light.
applyTheme(readPreference());

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <BrowserRouter>
    <App />
  </BrowserRouter>
);
