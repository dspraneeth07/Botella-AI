// DemoPopupContext.js
// -----------------------------------------------------------------------------
// Provides openDemoPopup() to any component on the public site. The single
// <DemoPopup /> instance lives at the root (rendered by DemoPopupProvider)
// so we never have two popups stacking on top of each other and the state
// resets cleanly between opens.
//
// Wrap the app (or at least every public route) once:
//   <DemoPopupProvider>
//     <Routes>...</Routes>
//   </DemoPopupProvider>
//
// Then anywhere inside:
//   const { openDemoPopup } = useDemoPopup();
//   <button onClick={openDemoPopup}>Book a Demo</button>
// -----------------------------------------------------------------------------

import React, { createContext, useCallback, useContext, useState } from 'react';
import DemoPopup from './DemoPopup';

const DemoPopupContext = createContext({
  openDemoPopup: () => {},
  closeDemoPopup: () => {},
  isDemoPopupOpen: false,
});

export function DemoPopupProvider({ children }) {
  const [isOpen, setIsOpen] = useState(false);

  const openDemoPopup = useCallback(() => setIsOpen(true), []);
  const closeDemoPopup = useCallback(() => setIsOpen(false), []);

  return (
    <DemoPopupContext.Provider
      value={{ openDemoPopup, closeDemoPopup, isDemoPopupOpen: isOpen }}
    >
      {children}
      <DemoPopup isOpen={isOpen} onClose={closeDemoPopup} />
    </DemoPopupContext.Provider>
  );
}

export function useDemoPopup() {
  return useContext(DemoPopupContext);
}
