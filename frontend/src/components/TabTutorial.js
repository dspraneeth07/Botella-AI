// TabTutorial.js
// -----------------------------------------------------------------------------
// The worked example that sits under a "your store does not have this data"
// notice, so the owner can see what the tab DOES before deciding whether the
// integration is worth chasing.
//
// THE WHOLE RISK IN THIS COMPONENT IS THAT IT LOOKS REAL. An owner who reads
// "$4,200 of cash committed" as their own number will act on it, and the
// screen that was meant to explain the product becomes the product lying to
// them. So the framing is not decoration and may not be trimmed:
//
//   - an EXAMPLE badge in the header, before any figure is on screen;
//   - the demonstration store named in the caption, twice removed from theirs;
//   - `aria-label` on the table saying the same thing, because a screen reader
//     user otherwise meets the numbers with no warning at all;
//   - every figure dimmed relative to real content, and the whole block inset
//     behind a rule so it reads as an aside rather than as the page.
//
// It renders nothing when there is no sample for the tab. A generic example is
// worse than none: it would teach the owner about a screen they are not on.
// -----------------------------------------------------------------------------

import React from 'react';
import { BookOpen } from 'lucide-react';
import { sampleFor, SAMPLE_STORE } from '../storeagent/tabSamples';
import './TabTutorial.css';

export default function TabTutorial({ sample }) {
  const data = typeof sample === 'string' ? sampleFor(sample) : sample;
  if (!data) return null;

  const { heading, blurb, metrics, columns, rows, reading } = data;
  const caption = `Example figures from ${SAMPLE_STORE}. Not your store's data.`;

  return (
    <section className="tt-wrap" aria-label={caption}>
      <header className="tt-head">
        <BookOpen size={16} aria-hidden="true" />
        <h3 className="tt-heading">{heading}</h3>
        <span className="tt-badge">Example</span>
      </header>

      <p className="tt-caption">{caption}</p>
      {blurb ? <p className="tt-blurb">{blurb}</p> : null}

      {metrics && metrics.length ? (
        <ul className="tt-metrics">
          {metrics.map((m) => (
            <li className="tt-metric" key={m.label}>
              <span className="tt-metric-value">{m.value}</span>
              <span className="tt-metric-label">{m.label}</span>
              {m.hint ? <span className="tt-metric-hint">{m.hint}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}

      {columns && rows && rows.length ? (
        <div className="tt-scroll">
          <table className="tt-table">
            <caption className="tt-sr">{caption}</caption>
            <thead>
              <tr>
                {columns.map((c) => <th key={c} scope="col">{c}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.join('|')}>
                  {r.map((cell, i) => (
                    // eslint-disable-next-line react/no-array-index-key
                    <td key={i}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {reading && reading.length ? (
        <>
          <h4 className="tt-reading-head">How to read it</h4>
          <ul className="tt-reading">
            {reading.map((line) => <li key={line}>{line}</li>)}
          </ul>
        </>
      ) : null}
    </section>
  );
}
