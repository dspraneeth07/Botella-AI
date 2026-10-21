// PrivacyPolicyPage.js
// -----------------------------------------------------------------------------
// /privacy-policy - standalone legal page wrapped in ContentLayout so it
// shares the standard site chrome. Canonical tag is set via useSEO per the
// v2 SEO brief. Copy is plain-language + scoped to the Botella product.
// -----------------------------------------------------------------------------

import React from 'react';
import { Link } from 'react-router-dom';
import ContentLayout from '../components/ContentLayout';
import useSEO from '../utils/useSEO';
import './LegalPage.css';

function PrivacyPolicyPage() {
  useSEO({
    title: 'Privacy Policy | Botella AI',
    description:
      "Botella AI's privacy policy explains what data we collect, how we use it, and the rights you have over your information.",
    canonical: 'https://botella.ai/privacy-policy',
  });

  const effectiveDate = 'May 12, 2026';

  return (
    <ContentLayout>
      <div className="cp-rich legal-page">

        {/* ── HERO ─────────────────────────────────────────────────── */}
        <section className="legal-hero">
          <div className="cp-tag-pill">Legal</div>
          <h1>Privacy Policy</h1>
          <p className="legal-effective">Effective date: {effectiveDate}</p>
          <p className="legal-intro">
            This Privacy Policy describes how Botella AI ("Botella," "we," "us,"
            or "our") collects, uses, and shares information when you visit
            botella.ai, book a demo, or use our AI agent for liquor stores.
          </p>
        </section>

        {/* ── BODY ─────────────────────────────────────────────────── */}
        <div className="legal-body">

          <h2>1. Information we collect</h2>
          <p>We collect the following categories of information:</p>
          <ul>
            <li>
              <strong>Information you provide</strong> - your name, business
              email, phone number, company / store name, business type, and any
              message text when you submit the contact form or book a demo.
            </li>
            <li>
              <strong>Usage data</strong> - pages visited, links clicked, device
              and browser type, IP address, referring URL, and approximate
              geographic location. This is collected via Google Analytics,
              Google Tag Manager, and Microsoft Clarity.
            </li>
            <li>
              <strong>Cookies</strong> - small files placed in your browser to
              support analytics, remember your theme preference, and improve
              the site's performance.
            </li>
            <li>
              <strong>Customer store data</strong> - if you become a Botella
              customer, your POS / inventory / sales data is processed solely
              to deliver the product. This data stays yours and is governed by
              your customer agreement, not this public-site policy.
            </li>
          </ul>

          <h2>2. How we use information</h2>
          <p>We use the information we collect to:</p>
          <ul>
            <li>Respond to demo requests and customer questions.</li>
            <li>Send transactional and marketing emails / WhatsApp messages you've opted into.</li>
            <li>Improve the website, our product, and our communications.</li>
            <li>Detect, prevent, and address fraud or abuse.</li>
            <li>Comply with legal obligations.</li>
          </ul>

          <h2>3. How we share information</h2>
          <p>
            We do <strong>not</strong> sell your personal information. We share
            it only with:
          </p>
          <ul>
            <li>
              <strong>Service providers</strong> who process data on our behalf
              under written contract - for example, email delivery, hosting,
              analytics (Google, Microsoft), and CRM.
            </li>
            <li>
              <strong>Legal authorities</strong> when required to comply with a
              valid subpoena, court order, or applicable law.
            </li>
            <li>
              <strong>A successor entity</strong> in the event of a merger,
              acquisition, or asset sale - subject to this policy.
            </li>
          </ul>

          <h2>4. Cookies & tracking</h2>
          <p>
            We use cookies and similar technologies for analytics, performance
            measurement, and to remember your preferences. You can disable
            cookies in your browser settings, but parts of the site may not
            function as intended. Specific tools we rely on:
          </p>
          <ul>
            <li>Google Analytics 4 (anonymised aggregate usage)</li>
            <li>Google Tag Manager (tag orchestration)</li>
            <li>Microsoft Clarity (session-level analytics + heatmaps)</li>
            <li>Google Search Console + Bing Webmaster Tools (search performance)</li>
          </ul>

          <h2>5. Your rights</h2>
          <p>
            Depending on your jurisdiction (including the EU/UK under GDPR and
            California under CCPA/CPRA), you have rights to:
          </p>
          <ul>
            <li>Access the personal information we hold about you.</li>
            <li>Correct inaccurate information.</li>
            <li>Request deletion of your information.</li>
            <li>Object to or restrict certain processing activities.</li>
            <li>Withdraw consent (where consent is the legal basis).</li>
            <li>Lodge a complaint with your local data protection authority.</li>
          </ul>
          <p>
            To exercise any of these rights, email <a href="mailto:info@botella.ai">info@botella.ai</a>.
            We will respond within 30 days.
          </p>

          <h2>6. Data security</h2>
          <p>
            We use industry-standard administrative, technical, and physical
            safeguards to protect your information - including encryption in
            transit (HTTPS), encryption at rest, role-based access controls,
            and audit logging. No internet transmission can be guaranteed
            100% secure; we will notify affected users without undue delay if
            we ever experience a breach affecting personal data.
          </p>

          <h2>7. Data retention</h2>
          <p>
            We retain personal information only as long as necessary for the
            purposes outlined above, or as required by law. Demo request
            information is retained for up to 24 months unless you ask us to
            delete it sooner.
          </p>

          <h2>8. International transfers</h2>
          <p>
            Botella AI is operated from the United States. If you access the
            service from outside the US, your information will be transferred
            to and processed in the US under appropriate safeguards.
          </p>

          <h2>9. Children's privacy</h2>
          <p>
            Botella AI is a business-to-business product. We do not knowingly
            collect information from anyone under 18. If you believe a minor
            has shared personal data with us, please email{' '}
            <a href="mailto:info@botella.ai">info@botella.ai</a> and we
            will delete it promptly.
          </p>

          <h2>10. Changes to this policy</h2>
          <p>
            We may update this Privacy Policy from time to time. Material
            changes will be flagged with a notice on the site at least 14 days
            before they take effect. The "Effective date" at the top of the
            page always reflects the current version.
          </p>

          <h2>11. Contact us</h2>
          <p>Questions about this policy or your data:</p>
          <ul>
            <li>Email: <a href="mailto:info@botella.ai">info@botella.ai</a></li>
            <li>General: <a href="mailto:info@botella.ai">info@botella.ai</a></li>
            <li>Or send us a message via the <Link to="/contact">contact page</Link>.</li>
          </ul>

          <div className="legal-foot">
            <p>
              See also our <Link to="/terms-and-conditions">Terms and Conditions</Link>.
            </p>
          </div>
        </div>

      </div>
    </ContentLayout>
  );
}

export default PrivacyPolicyPage;
