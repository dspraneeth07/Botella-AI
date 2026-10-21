// TermsAndConditionsPage.js
// -----------------------------------------------------------------------------
// /terms-and-conditions - standalone legal page. Same chrome as the rest of
// the public site via ContentLayout. Copy is plain-language T&C scoped to
// Botella's marketing site + demo bookings - actual product T&C live in the
// customer agreement signed at purchase.
// -----------------------------------------------------------------------------

import React from 'react';
import { Link } from 'react-router-dom';
import ContentLayout from '../components/ContentLayout';
import useSEO from '../utils/useSEO';
import './LegalPage.css';

function TermsAndConditionsPage() {
  useSEO({
    title: 'Terms and Conditions | Botella AI',
    description:
      "Terms and conditions governing your use of botella.ai and Botella AI's marketing materials, demo bookings, and trial access.",
    canonical: 'https://botella.ai/terms-and-conditions',
  });

  const effectiveDate = 'May 12, 2026';

  return (
    <ContentLayout>
      <div className="cp-rich legal-page">

        {/* ── HERO ─────────────────────────────────────────────────── */}
        <section className="legal-hero">
          <div className="cp-tag-pill">Legal</div>
          <h1>Terms and Conditions</h1>
          <p className="legal-effective">Effective date: {effectiveDate}</p>
          <p className="legal-intro">
            These Terms govern your use of the website at botella.ai (the
            "Site") and any demo, trial, or marketing service Botella AI
            ("Botella," "we," "us") makes available. By visiting the Site or
            requesting a demo, you agree to these Terms.
          </p>
        </section>

        {/* ── BODY ─────────────────────────────────────────────────── */}
        <div className="legal-body">

          <h2>1. Acceptance of terms</h2>
          <p>
            By accessing the Site, submitting the contact form, or booking a
            demo, you confirm that you have read, understood, and agreed to be
            bound by these Terms. If you do not agree, please do not use the
            Site.
          </p>

          <h2>2. Use of the site</h2>
          <p>You agree to use the Site only for lawful purposes. You agree not to:</p>
          <ul>
            <li>Attempt to gain unauthorised access to any part of the Site, our servers, or related systems.</li>
            <li>Interfere with or disrupt the Site's functioning (e.g., DDoS attempts, scraping at rates that affect performance).</li>
            <li>Use the Site to transmit malware, viruses, or other malicious code.</li>
            <li>Reverse-engineer, decompile, or otherwise attempt to derive source code from any part of the Site.</li>
            <li>Use any automated means (bots, scrapers, etc.) without our prior written permission.</li>
            <li>Misrepresent your identity or business affiliation when contacting us.</li>
          </ul>

          <h2>3. Demo bookings & trials</h2>
          <p>
            When you book a demo or request a free trial, you agree to provide
            accurate, current, and complete information. We may decline,
            cancel, or end any demo or trial at our sole discretion. Trials
            are provided as-is, without warranty.
          </p>

          <h2>4. Intellectual property</h2>
          <p>
            All content on the Site - including text, images, logos, the
            Botella name, product mockups, code, and design - is the property
            of Botella AI or its licensors and is protected by US and
            international intellectual-property laws. You may not reproduce,
            distribute, modify, or create derivative works from any part of
            the Site without our prior written permission.
          </p>

          <h2>5. User content</h2>
          <p>
            If you submit information through the Site (form messages, emails,
            etc.), you grant Botella a worldwide, non-exclusive, royalty-free
            license to use that information to respond to your request,
            provide a demo, and improve our services. You are responsible for
            ensuring the information you submit does not violate the rights
            of any third party.
          </p>

          <h2>6. Customer agreement (for product users)</h2>
          <p>
            If you become a Botella customer, your use of the product itself
            is governed by a separate <strong>Customer Agreement</strong>
            (or Master Service Agreement) signed at the time of purchase. The
            Customer Agreement controls in the event of any conflict with
            these Terms.
          </p>

          <h2>7. Third-party links</h2>
          <p>
            The Site may contain links to third-party websites (LinkedIn,
            Instagram, Facebook, etc.). We don't control those sites and are
            not responsible for their content, privacy practices, or
            availability.
          </p>

          <h2>8. Disclaimers</h2>
          <p>
            The Site and any free trial are provided <strong>"as is" and
            "as available"</strong>, without warranties of any kind, whether
            express or implied. To the maximum extent permitted by law,
            Botella disclaims all warranties - including merchantability,
            fitness for a particular purpose, and non-infringement.
            Performance benchmarks shown on the Site (response times, margin
            improvements, etc.) are illustrative and depend on each store's
            individual data + setup.
          </p>

          <h2>9. Limitation of liability</h2>
          <p>
            To the maximum extent permitted by law, Botella will not be liable
            for any indirect, incidental, special, consequential, or punitive
            damages - including lost profits, revenue, data, or use - arising
            out of or related to your use of the Site, even if we have been
            advised of the possibility of such damages. Our aggregate
            liability for any claim arising out of these Terms will not
            exceed <strong>$100 USD</strong>.
          </p>

          <h2>10. Indemnification</h2>
          <p>
            You agree to indemnify, defend, and hold harmless Botella and its
            officers, directors, employees, and agents from any claim,
            demand, loss, or damages - including reasonable attorneys' fees -
            arising from (a) your use of the Site, (b) your violation of
            these Terms, or (c) your violation of any rights of a third party.
          </p>

          <h2>11. Modifications</h2>
          <p>
            We may modify these Terms at any time. The "Effective date" at
            the top will be updated and material changes will be announced
            with at least 14 days' notice on the Site. Your continued use of
            the Site after a change takes effect constitutes acceptance of
            the updated Terms.
          </p>

          <h2>12. Termination</h2>
          <p>
            We may suspend or terminate your access to the Site at any time,
            with or without notice, for any reason - including a breach of
            these Terms. Sections that by their nature should survive
            termination will survive (e.g., IP, disclaimers, liability).
          </p>

          <h2>13. Governing law</h2>
          <p>
            These Terms are governed by the laws of the State of Delaware,
            United States, without regard to conflict-of-laws principles. Any
            dispute arising under these Terms will be resolved exclusively in
            the state or federal courts located in Delaware.
          </p>

          <h2>14. Contact</h2>
          <p>Questions about these Terms:</p>
          <ul>
            <li>Email: <a href="mailto:info@botella.ai">info@botella.ai</a></li>
            <li>General: <a href="mailto:info@botella.ai">info@botella.ai</a></li>
            <li>Or reach out via the <Link to="/contact">contact page</Link>.</li>
          </ul>

          <div className="legal-foot">
            <p>
              See also our <Link to="/privacy-policy">Privacy Policy</Link>.
            </p>
          </div>
        </div>

      </div>
    </ContentLayout>
  );
}

export default TermsAndConditionsPage;
