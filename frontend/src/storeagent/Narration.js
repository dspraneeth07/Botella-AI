// Renders the AI narration over the deterministic numbers. The model only
// phrases the figures the functions computed, never invents them.
import { Card } from './ui';
import { noDash } from './format';

export function NarrationPanel({ narration }) {
  if (!narration) return null;

  if (!narration.available) {
    return (
      <Card className="sa-narration-off">
        <span className="sa-fw-500 sa-c-600">AI narration is off.</span>
      </Card>
    );
  }

  return (
    <Card className="sa-narration">
      <div className="sa-narration-bar" />
      <div className="sa-narration-head">
        <span className="sa-narration-spark">✦</span>
        <span className="sa-narration-tag">Store Agent AI</span>
      </div>
      <div className="sa-narration-body">
        {noDash(String(narration.text))
          .split(/\n{2,}/)
          .map((para, i) => (
            <p key={i}>{para}</p>
          ))}
      </div>
    </Card>
  );
}
