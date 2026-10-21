// Customers (customer radar) - ported from views/Customers.tsx.
import { money, num, titleFor } from '../format';
import { Badge, Bar, Card, Pagination, Section, Stat, Table, Td, Th, usePaged, useSort } from '../ui';

// Which warehouse repo(s) fetched each component's data (for the per-component
// SQL icon). The customer radar dataset comes entirely from customer_repo.
const SRC = 'customers';

// Proof-of-trust texts - mirror storeagent/functions/customers.py.
const INFO = {
  base:
    'How many real, contactable customers you have: people with a phone number or email on file. Card and cash placeholders are left out, so this is the audience you can actually reach. The lists below also include known customers without contact details - you may still recognize them at the counter.',
  atRisk:
    'Regulars who have gone quiet, judged against their own visit habits. They used to come in on a rhythm and have broken it, but recently enough to win back.',
  revenueAtRisk:
    'Roughly how much yearly sales you could lose if these fading regulars never come back. It is a worst-case figure, meant to show what is worth protecting.',
  winBack:
    'Your most valuable regulars who have started slipping away, ranked so you reach the highest-value ones first. Each shows what they usually buy for a personal opener.',
  vips:
    'Your best customers by lifetime spend, each with a suggested next step: reconnect with the ones slipping away, and reward your most loyal.',
};

// Decision per VIP, derived from their own behavior - not just a leaderboard.
function vipAction(c) {
  if (c.at_risk) return { label: 'call now - breaking pattern', tone: 'urgent' };
  if (c.segment === 'champion') return { label: 'reward - top spender', tone: 'good' };
  if (c.segment === 'loyal') return { label: 'keep engaged', tone: 'accent' };
  if (c.segment === 'lost' || c.segment === 'lapsed') return { label: 'win-back offer', tone: 'warn' };
  return { label: 'grow - occasional', tone: 'default' };
}

// Friendly label, accent tone, display order, and a one-line descriptor for each
// customer segment. Unknown segments fall back to a humanized key + neutral tone.
const SEGMENT_META = {
  champion:   { label: 'Champions',  tone: 'good',    rank: 0, desc: 'Your highest-value regulars' },
  loyal:      { label: 'Loyal',      tone: 'accent',  rank: 1, desc: 'Frequent, dependable shoppers' },
  regular:    { label: 'Regulars',   tone: 'accent',  rank: 2, desc: 'Steady, repeat visitors' },
  promising:  { label: 'Promising',  tone: 'accent',  rank: 3, desc: 'Early, growing relationships' },
  new:        { label: 'New',        tone: 'default', rank: 4, desc: 'Recently acquired' },
  occasional: { label: 'Occasional', tone: 'default', rank: 5, desc: 'Infrequent visitors' },
  at_risk:    { label: 'At risk',    tone: 'warn',    rank: 6, desc: 'Slipping from their pattern' },
  lapsed:     { label: 'Lapsed',     tone: 'warn',    rank: 7, desc: 'Overdue for a visit' },
  lost:       { label: 'Lost',       tone: 'bad',     rank: 8, desc: 'No visit in a long time' },
};
const humanizeSeg = (s) => String(s || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const segMeta = (k) => SEGMENT_META[k] || { label: humanizeSeg(k), tone: 'default', rank: 50, desc: '' };

export function CustomersView({ data }) {
  const r = data.customer_radar;
  // Hooks must run on every render - before the availability early-return.
  const winBackSort = useSort(r.win_back ?? []);
  const winBackPage = usePaged(winBackSort.sorted, 10);
  const topSort = useSort(r.top_customers ?? []);
  const topPage = usePaged(topSort.sorted, 10);

  if (!r.available) {
    const eng = r.engagement;
    if (!eng) {
      // Old cached payload without the fallback data: keep the simple notice.
      return (
        <Card className="sa-card--warn sa-p-8 sa-text-center">
          <div className="sa-text-lg sa-fw-600 sa-warn">Customer insights unavailable for this store</div>
          <p className="sa-mt-2 sa-text-sm sa-c-600" style={{ margin: '8px auto 0', maxWidth: '28rem' }}>
            {r.reason || 'This store lacks real per-person CRM data.'}
          </p>
        </Card>
      );
    }
    const book = eng.contact_book || {};
    const days = eng.by_day || [];
    const maxRev = Math.max(1, ...days.map((d) => d.revenue || 0));
    const bestDay = days.reduce((a, b) => ((b.revenue || 0) > (a?.revenue || 0) ? b : a), null);
    const DAY = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const fmtHour = (h) => `${h % 12 === 0 ? 12 : h % 12}${h >= 12 ? 'pm' : 'am'}`;
    const peakHours = (eng.top_hours || []).map((x) => fmtHour(x.hour)).join(', ');
    return (
      <div className="sa-stack">
        <Card className="sa-card--accent sa-p-4">
          <p className="sa-text-sm sa-fw-600 sa-c-900" style={{ margin: 0, lineHeight: 1.6 }}>
            Link customers to sales during checkout to unlock Customer Win-Back insights.
          </p>
        </Card>

        {book.contacts >= 100 && (
          <Card className="sa-card--good sa-p-4">
            <p className="sa-text-sm sa-c-700" style={{ margin: 0, lineHeight: 1.6 }}>
              Your POS already has <span className="sa-fw-600">{num(book.contacts)}</span> saved
              customer profiles ready to link.
            </p>
          </Card>
        )}

        <div className="sa-grid-3">
          <Stat
            label="Busiest Day"
            value={bestDay ? DAY[(bestDay.dow || 1) - 1] : '-'}
            sub="by revenue, last 90 days"
            tone="accent"
          />
          <Stat label="Average Ticket" value={money(eng.avg_ticket, true)} sub="last 90 days" />
          <Stat
            label="Single-Item Trips"
            value={eng.single_item_pct != null ? `${eng.single_item_pct}%` : '-'}
            sub="one product per visit"
            tone="warn"
          />
        </div>

        {days.length > 0 && (
        <Section
          title="When Your Customers Shop"
          hint={peakHours ? `Anonymous transaction patterns. Peak hours: ${peakHours}.` : 'Anonymous transaction patterns.'}
        >
          {days.map((d) => (
            <div key={d.dow} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '5px 0' }}>
              <span className="sa-text-xs sa-fw-600 sa-c-600" style={{ width: 34, flexShrink: 0 }}>
                {DAY[(d.dow || 1) - 1]}
              </span>
              <div style={{ flex: 1 }}>
                <Bar value={d.revenue || 0} max={maxRev} tone="accent" />
              </div>
              <span className="sa-text-xs sa-c-500 sa-num" style={{ width: 90, textAlign: 'right', flexShrink: 0 }}>
                {money(d.revenue)}
              </span>
            </div>
          ))}
        </Section>
        )}
      </div>
    );
  }

  const segs = Object.entries(r.segments || {}).sort((a, b) => {
    const ra = segMeta(a[0]).rank, rb = segMeta(b[0]).rank;
    return ra !== rb ? ra - rb : b[1] - a[1];
  });

  return (
    <div className="sa-stack">
      {r.coverage === 'partial' && (
        <Card className="sa-card--accent sa-p-4 sa-text-sm sa-c-700">
          Based on the {num(r.total_customers)} customers your POS individually tracks. Sales rung
          up without a customer on the ticket are not included, so treat these as your floor.
        </Card>
      )}
      <div className="sa-grid-stats">
        <Stat label="Customer Base" value={num(r.total_customers)} sub="real, contactable people" info={INFO.base} sql="customers.total_customers" />
        <Stat label="At Risk" value={num(r.at_risk_count)} sub="broke their visit pattern" tone="bad" info={INFO.atRisk} sql="customers.at_risk_count" />
        <Stat label="Forecasted Deficit" value={money(r.annual_revenue_at_risk)} sub="per year · upper bound" tone="warn" info={INFO.revenueAtRisk} sql="customers.annual_revenue_at_risk" />
        <Stat label="Priority Outreach" value={num(r.win_back?.length || 0)} sub="highest-value lapsed" tone="accent" info={INFO.winBack} sql="customers.at_risk_count" />
      </div>

      {segs.length > 0 && (
        <Section title="Customer Segments" hint="Your customer base grouped by loyalty and visit pattern">
          <div className="sa-seg-grid">
            {segs.map(([k, v]) => {
              const m = segMeta(k);
              return (
                <div key={k} className={`sa-seg-card sa-seg--${m.tone}`}>
                  <div className="sa-seg-count sa-c-900 sa-num">{num(v)}</div>
                  <div className="sa-seg-label sa-c-800">{m.label}</div>
                  {m.desc && <div className="sa-seg-desc sa-c-500">{m.desc}</div>}
                </div>
              );
            })}
          </div>
        </Section>
      )}

      {(r.win_back || []).length > 0 && (
      <Section
        title="At-Risk Regulars to Win Back"
        hint="Regulars who've gone quiet far longer than usual but recently enough to win back - reach these first"
        info={INFO.winBack}
        sql="customers.win_back"
      >
        <Table head={<><Th>Customer</Th><Th sortKey="visits" sort={winBackSort.sort} onSort={winBackSort.onSort} right>Visits</Th><Th sortKey="annual_value" sort={winBackSort.sort} onSort={winBackSort.onSort} right>Annual value</Th><Th sortKey="days_since_last" sort={winBackSort.sort} onSort={winBackSort.onSort} right>Last seen</Th><Th sortKey="cadence_days" sort={winBackSort.sort} onSort={winBackSort.onSort} right>Usual gap</Th><Th>Likes</Th></>}>
          {winBackPage.slice.map((c) => (
            <tr key={c.customer_id}>
              <Td className="sa-c-800">{c.name || `cust ${c.customer_id.slice(0, 8)}`}</Td>
              <Td right>{num(c.visits)}</Td>
              <Td right className="sa-fw-500 sa-good">{money(c.annual_value)}</Td>
              <Td right className="sa-c-600">{num(c.days_since_last)}d ago</Td>
              <Td right className="sa-c-600">{Math.round(c.cadence_days)}d</Td>
              <Td>{c.favorite_category ? <Badge tone="accent">{c.favorite_category}</Badge> : <span className="sa-c-500">-</span>}</Td>
            </tr>
          ))}
        </Table>
        <Pagination {...winBackPage} onPage={winBackPage.setPage} csvName="win-back-customers" />
      </Section>
      )}

      {r.top_customers && r.top_customers.length > 0 && (
        <Section
          title="Top Customers"
          hint="Your highest-spending customers, with a suggested next step for each"
          info={INFO.vips}
          sql="customers.top_customers"
        >
          <Table head={<><Th>Customer</Th><Th sortKey="spend" sort={topSort.sort} onSort={topSort.onSort} right>Lifetime spend</Th><Th sortKey="visits" sort={topSort.sort} onSort={topSort.onSort} right>Visits</Th><Th sortKey="days_since_last" sort={topSort.sort} onSort={topSort.onSort} right>Last seen</Th><Th>What to do</Th></>}>
            {topPage.slice.map((c) => {
              const act = vipAction(c);
              return (
                <tr key={c.customer_id} style={c.at_risk ? { background: 'rgba(220, 38, 38, 0.05)' } : undefined}>
                  <Td className="sa-c-800">{titleFor(c.name, `cust ${c.customer_id.slice(0, 8)}`)}</Td>
                  <Td right className="sa-fw-500">{money(c.spend)}</Td>
                  <Td right>{num(c.visits)}</Td>
                  <Td right className="sa-c-600">{num(c.days_since_last)}d ago</Td>
                  <Td><Badge tone={act.tone}>{act.label}</Badge></Td>
                </tr>
              );
            })}
          </Table>
          <Pagination {...topPage} onPage={topPage.setPage} csvName="top-customers" />
        </Section>
      )}

    </div>
  );
}
