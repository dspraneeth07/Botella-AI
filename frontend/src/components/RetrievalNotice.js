// RetrievalNotice.js
// -----------------------------------------------------------------------------
// What a screen shows when its fetch came back with nothing.
//
// Every screen used to render the same thing for every reason:
//
//     Unable to load customer insights.    [Retry]
//
// That sentence is true of an outage and true of a store whose analytics
// database has no customer tables, and only one of them can be fixed by the
// button next to it. An owner in the second case presses Retry, waits, presses
// it again, and is never told the one thing that is actionable - the data has
// to be connected upstream, and the people who do that are us.
//
// So this renders the READING, not the failure:
//   MISSING -> about the STORE. No Retry: nothing is coming. Contact us.
//   FAILED  -> about US. Keep Retry, keep the message, and say nothing at all
//              about the store's data, because we do not know it is absent.
//
// `storeagent/retrieval.js` decides which, and defaults to FAILED - we do not
// get to tell a store its data is missing on a guess.
//
// The MISSING notice carries its own styles (RetrievalNotice.css, on the global
// theme tokens) so it looks identical on every screen. The FAILED box borrows
// the host screen's own error class, because it sits inside that screen's
// layout and already looked right there - `errorClassName` is how a screen
// passes its own (rh-error, cc-error, ins-error, poe-error, ref-error).
// -----------------------------------------------------------------------------

import React from 'react';
import { AlertTriangle, DatabaseZap } from 'lucide-react';
import { isMissing } from '../storeagent/retrieval';
import { errorText } from '../utils/errorText';
import { sentence } from '../utils/sentence';
import TabTutorial from './TabTutorial';
import './RetrievalNotice.css';

export default function RetrievalNotice({
  error, label, onRetry, fallback, errorClassName = 'ref-error',
  sample, missing: forceMissing = false, reason,
}) {
  const name = label || 'This data';

  // `forceMissing` is for the absence that arrives as a SUCCESSFUL response.
  //
  // A store with no purchase feed is not a failed fetch: the report comes back
  // 200 with every card ungradeable, and the screen used to render that as a
  // confident "$-71,125 / 0 confirmed". The figure was arithmetic on an absence
  // - no order evidence anywhere, so nothing to measure against - and it read
  // as a verdict on the owner's buying. So a screen that can see the absence in
  // its own payload says so here, and `reason` carries the backend's sentence
  // rather than a second guess at it.
  if (forceMissing || isMissing(error)) {
    // The tutorial is a SIBLING, not a child: `.rn-unavail` is a centred
    // 560px column, and nesting a worked example inside it would squeeze the
    // table into a gutter and centre its prose.
    return (
      <>
        <div className="rn-unavail" role="status">
          <DatabaseZap size={22} aria-hidden="true" />
          <div className="rn-unavail-title">{name} is not available for your store</div>
          <p>
            {sentence(reason) || sentence(error?.reason)
              || 'Your point-of-sale has not sent the data this screen is built '
                 + 'from, so there is nothing to show yet.'}
          </p>
          <p>
            If you expect to see this, contact <strong>Botella AI Labs</strong> and
            we will check the connection for your store.
          </p>
          {error?.detail ? (
            <span className="rn-unavail-detail">{error.detail}</span>
          ) : null}
        </div>
        <TabTutorial sample={sample} />
      </>
    );
  }

  return (
    <div className={errorClassName} role="alert">
      <AlertTriangle size={18} aria-hidden="true" />
      <span>{errorText(error, fallback || `${name} could not be loaded.`)}</span>
      {onRetry ? <button type="button" onClick={onRetry}>Retry</button> : null}
    </div>
  );
}
