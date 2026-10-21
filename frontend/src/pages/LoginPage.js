import React, { useState, useEffect } from 'react';
import { useTheme } from '../utils/useTheme';
import { errorText } from '../utils/errorText';
import { useNavigate } from 'react-router-dom';
import Wordmark from '../components/Wordmark';
import { Eye, EyeOff, ArrowLeft, X } from 'lucide-react';
import './LoginPage.css';
import { API_BASE as ENV_API_BASE } from '../utils/env';

// Validated in utils/env.js: a note typed after the value in .env is part of
// the value, and every request then 404s at a path nobody recognises.
const API_BASE = ENV_API_BASE;

function LoginPage() {
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  // Called for its effect: it stamps <html data-theme> from the saved
  // preference and, under 'system', keeps following the OS while this screen is
  // open. The login screen carries no theme control of its own.
  useTheme();
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [showTermsModal, setShowTermsModal] = useState(false);
  // ?reason=idle - set by the idle timeout (utils/useIdleLogout) so the user
  // is told why they were signed out instead of just finding the login screen.
  const [idleNotice, setIdleNotice] = useState(
    () => new URLSearchParams(window.location.search).get('reason') === 'idle',
  );

  // useTheme stamps <html data-theme> and follows the OS under 'system'.

  // If already logged in, land on AI Recommendations (the home / default view)
  useEffect(() => {
    if (localStorage.getItem('botella_token')) {
      navigate('/recommendations', { replace: true });
    }
  }, [navigate]);

  // Close the terms modal on Escape
  useEffect(() => {
    if (!showTermsModal) return;
    const onKeyDown = (e) => { if (e.key === 'Escape') setShowTermsModal(false); };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [showTermsModal]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    // Guard: must accept terms before login. Button is disabled too, but this
    // catches keyboard form-submission (Enter key) when checkbox is unchecked.
    if (!acceptedTerms) {
      setError('Please accept the Terms & Conditions to continue.');
      return;
    }
    setError('');
    setIdleNotice(false); // they are acting on it; stop explaining the last sign-out
    setLoading(true);

    const url = `${API_BASE}/auth/login`;

    // Every failure below used to arrive at one catch that said "Cannot connect
    // to server. Please check if the backend is running." That sentence is a
    // guess, and on a machine that is not the developer's it is usually the
    // WRONG guess: a running backend behind a dev server with no proxy, a 404
    // answered as HTML, a 500 from a database it cannot reach and a genuine
    // connection refusal all landed on it identically. The person reading it
    // then goes and checks the one thing that was never broken.
    //
    // So each failure is now named, and the URL that was actually called is
    // shown. The URL matters more than anything else here: it is the difference
    // between "the path is wrong" and "the server is down", and it is invisible
    // in a screenshot of the old message.
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'ngrok-skip-browser-warning': 'true',
        },
        body: JSON.stringify({ username: username.trim().toLowerCase(), password }),
      });
    } catch (err) {
      // fetch() rejects only when the request never got an HTTP response at
      // all: nothing listening, DNS failure, the tunnel down, or the browser
      // blocking it. THIS is the case the old message described - and the only
      // one where "is the backend running?" is the right question to ask.
      setError(
        `Cannot reach the server at ${url} - no response at all. ` +
          'The API is not running, or this page is pointed at the wrong host.',
      );
      setLoading(false);
      return;
    }

    // A response arrived, so the server IS reachable. What it said may still
    // not be JSON: a dev-server proxy that cannot reach its target, an HTML 404
    // page, or an nginx error all come back as text/html, and res.json() throws
    // on them. Reporting that as "cannot connect" hides a reachable server that
    // answered with something unexpected.
    let data;
    try {
      data = await res.json();
    } catch (err) {
      const kind = res.headers.get('content-type') || 'no content-type';
      setError(
        `${url} answered ${res.status} ${res.statusText} with ${kind}, not JSON. ` +
          (res.status === 404
            ? 'Nothing is mounted at that path - check the API base this page was built with.'
            : 'The request reached something other than the API.'),
      );
      setLoading(false);
      return;
    }

    try {
      if (!res.ok) {
        // errorText, not data.error: /api/auth/login answers with a STRING for
        // an expected failure (bad credentials) and with the { code, message }
        // envelope from its catch-all when something is genuinely broken - a
        // database it cannot reach, a timeout. Rendering that object crashed
        // the page with "Objects are not valid as a React child", hiding the
        // real reason at the exact moment it mattered.
        // A 5xx is the API failing, not the credentials. The commonest cause on
        // a machine that is not the developer's is that the API is running fine
        // but cannot reach the warehouse from this network - /api/health passes
        // (it touches no database), so the backend looks healthy while every
        // login 500s. "Trouble accessing your data" is true but unactionable;
        // name the check that tells them which layer is actually broken.
        const code = data.error && data.error.code;
        setError(
          errorText(data.error, 'Login failed. Please try again.') +
            (res.status >= 500
              ? ` (${code || 'HTTP ' + res.status}) - the API answered but could not ` +
                'complete the login. Run: npm run doctor --prefix backend'
              : ''),
        );
        setLoading(false);
        return;
      }

      // Store auth data
      localStorage.setItem('botella_token', data.token);
      localStorage.setItem('botella_client_id', data.client_id);
      localStorage.setItem('botella_location_id', data.location_id);
      localStorage.setItem('botella_client_name', data.client_name);
      localStorage.setItem('botella_location_name', data.location_name);
      localStorage.setItem('botella_username', data.username);
      // Identity and market, so no screen has to hard-code a name or a state.
      // Written even when empty, so a re-login clears a previous store's value
      // rather than leaving it to be read by the next one.
      localStorage.setItem('botella_contact_name', data.contact_name || '');
      localStorage.setItem('botella_state', data.state || '');
      localStorage.setItem('botella_city', data.city || '');
      // When this session began. The backend recomputes store intelligence on
      // login (routes/auth.js), which takes minutes and finishes long after the
      // tabs have rendered from the pre-login cache. StoreAgentPanel compares
      // each cached row's computed_at against this stamp to know which numbers
      // are still the previous session's, and swaps them in when they land.
      localStorage.setItem('botella_session_started', new Date().toISOString());

      navigate('/recommendations', { replace: true });
    } catch (err) {
      // The credentials were accepted and the token is stored; what failed is
      // something after that - writing to localStorage in a private window, or
      // the navigation itself. Saying "cannot connect" here sends the user to
      // check a server that just answered them correctly.
      setError(`Signed in, but the app could not open: ${err.message}`);
      setLoading(false);
    }
  };

  return (
    <div className="login-page">
      {/* Same three-source violet bloom as the marketing hero, so signing in
          feels like walking through the same door. */}
      <div className="login-aurora" aria-hidden="true" />
      <div className="login-card">
        <button className="login-back-btn" onClick={() => navigate('/')}>
          <ArrowLeft size={18} />
          <span>Back</span>
        </button>
        <div className="login-header">
          {/* The site wordmark, not a second lockup - one mark everywhere. */}
          <Wordmark size="nav" className="login-wordmark" />
          <h1 className="login-title">Sign in to your store</h1>
          <p className="login-subtitle">
            Your Retail AI is waiting with today&rsquo;s priorities.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="login-form">
          {error && <div className="login-error">{error}</div>}
          {idleNotice && !error && (
            <div className="login-notice">
              You were signed out after a period of inactivity. Please sign in again.
            </div>
          )}

          <div className="login-field">
            <label htmlFor="username">Username</label>
            <input
              id="username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Enter your username"
              autoComplete="username"
              autoFocus
              required
            />
          </div>

          <div className="login-field">
            <label htmlFor="password">Password</label>
            <div className="login-password-wrapper">
              <input
                id="password"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter your password"
                autoComplete="current-password"
                required
              />
              <button
                type="button"
                className="login-password-toggle"
                onClick={() => setShowPassword((prev) => !prev)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
          </div>

          <label className="login-terms">
            <input
              type="checkbox"
              checked={acceptedTerms}
              onChange={(e) => setAcceptedTerms(e.target.checked)}
            />
            <span>
              I agree to the{' '}
              <button
                type="button"
                className="login-terms-link"
                onClick={() => setShowTermsModal(true)}
              >
                Terms &amp; Conditions
              </button>
            </span>
          </label>

          <button type="submit" className="login-btn" disabled={loading || !acceptedTerms}>
            {loading ? (
              <span className="login-spinner" />
            ) : (
              'Sign In'
            )}
          </button>
        </form>

        <p className="login-footer">
          Credentials are provided by your administrator
        </p>
      </div>

      {showTermsModal && (
        <div
          className="terms-modal-overlay"
          onClick={() => setShowTermsModal(false)}
          role="dialog"
          aria-modal="true"
          aria-labelledby="terms-modal-title"
        >
          <div className="terms-modal" onClick={(e) => e.stopPropagation()}>
            <header className="terms-modal-header">
              <h2 id="terms-modal-title">Terms &amp; Conditions</h2>
              <button
                type="button"
                className="terms-modal-close"
                onClick={() => setShowTermsModal(false)}
                aria-label="Close terms"
              >
                <X size={18} />
              </button>
            </header>

            <div className="terms-modal-body">
              <p className="terms-modal-intro">
                By signing in to Botella, you agree to the following terms regarding
                the data you provide and the data generated through your use of the
                Service. The full Terms of Service and Privacy Policy are also
                available on request.
              </p>

              <h3>Customer Data and Data Use License</h3>

              <h4>Definitions</h4>
              <p>
                <strong>"Customer Data"</strong> means all data, information, and
                content that (a) Customer or its Authorized Users upload, transmit,
                or otherwise make accessible to Botella through the Service -
                including point-of-sale records, product catalogs, sales history,
                customer records, supplier information, purchase orders, and
                inventory data; and (b) is generated by Customer or its Authorized
                Users through use of the Service - including chat queries, prompts,
                conversation history, queries generated by the AI Agent, and
                AI-generated responses (collectively, <strong>"Service Interaction
                Data"</strong>).
              </p>
              <p>
                <strong>"Aggregated Data"</strong> means Customer Data combined with
                the data of other Botella customers and stripped of any information
                that identifies Customer or any individual.
              </p>
              <p>
                <strong>"De-identified Data"</strong> means Customer Data from which
                all direct and reasonably identifiable indirect identifiers have
                been removed.
              </p>

              <h4>Ownership</h4>
              <p>
                As between Customer and Botella, <strong>Customer owns all right,
                title, and interest in and to the Customer Data</strong>. Botella
                owns all right, title, and interest in the Service, including the
                underlying AI models, software, and algorithms (excluding Customer
                Data).
              </p>

              <h4>License Grant by Customer</h4>
              <p>
                Customer hereby grants to Botella a non-exclusive, royalty-free,
                worldwide, sublicensable license (solely to subprocessors as needed
                to provide the Service) to access, use, copy, store, transmit,
                process, analyze, modify, and create derivative works of Customer
                Data <strong>solely</strong> for the following purposes:
              </p>
              <ol>
                <li>
                  <strong>Service Delivery</strong> - to operate, maintain, and
                  provide the Service to Customer, including responding to
                  Customer's queries through the AI Agent.
                </li>
                <li>
                  <strong>Service Improvement</strong> - to improve, develop, train,
                  fine-tune, and evaluate Botella's AI models, prompts, retrieval
                  systems, and other product features, provided that any model
                  improvements derived from Customer Data shall not expose
                  individually identifiable Customer Data to other customers.
                </li>
                <li>
                  <strong>Aggregated Insights</strong> - to generate Aggregated Data
                  and De-identified Data for internal analytics, industry
                  benchmarks, and product development.
                </li>
                <li>
                  <strong>Security &amp; Compliance</strong> - to detect,
                  investigate, and prevent fraud, abuse, security incidents, or
                  violations of these Terms.
                </li>
                <li>
                  <strong>Legal Compliance</strong> - to comply with applicable law,
                  regulation, legal process, or governmental request.
                </li>
              </ol>

              <h4>Limitations on Botella's Use</h4>
              <p>Botella shall not:</p>
              <ol>
                <li>sell, lease, or rent Customer Data to any third party;</li>
                <li>
                  disclose individually identifiable Customer Data to any third
                  party except (i) to subprocessors bound by confidentiality and
                  data-protection obligations no less protective than those in this
                  Agreement, (ii) as required by law or legal process, or (iii)
                  with Customer's prior written consent;
                </li>
                <li>
                  use Customer Data to compete with Customer's business or to
                  benefit a direct competitor of Customer; or
                </li>
                <li>
                  train any AI model on Customer Data in a manner that would result
                  in another customer's outputs reproducing identifiable Customer
                  Data.
                </li>
              </ol>

              <h4>Customer Rights</h4>
              <p>Customer retains the following rights at all times:</p>
              <ol>
                <li>
                  <strong>Access</strong> - Customer may access its Customer Data
                  through the Service or via reasonable export requests.
                </li>
                <li>
                  <strong>Export</strong> - upon written request, Botella will
                  provide Customer with a copy of Customer Data in a commonly used
                  machine-readable format within thirty (30) days.
                </li>
                <li>
                  <strong>Deletion</strong> - Customer may request deletion of all
                  or specified Customer Data, and Botella will delete such data
                  from active production systems within thirty (30) days, subject
                  to legal retention obligations and reasonable backup-retention
                  windows.
                </li>
                <li>
                  <strong>Termination Effect</strong> - upon termination of this
                  Agreement, Botella will delete all Customer Data within ninety
                  (90) days, except for (i) Aggregated Data and De-identified Data
                  already incorporated into Botella's general analytics and AI
                  models, which Botella may continue to use, and (ii) data Botella
                  is required to retain by law.
                </li>
              </ol>

              <h4>De-identified and Aggregated Data Survives Termination</h4>
              <p>
                Customer acknowledges and agrees that Aggregated Data and
                De-identified Data, by their nature, cannot reasonably be unwound
                from Botella's models, benchmarks, or aggregated analytics, and
                that Botella's right to use such Aggregated and De-identified Data{' '}
                <strong>survives termination</strong> of this Agreement.
              </p>

              <h4>No Sensitive Personal Information</h4>
              <p>
                Customer represents and warrants that it will not upload, transmit,
                or otherwise provide to the Service any of the following without
                Botella's prior written consent: government-issued identifiers
                (SSN, driver's license number, passport number), financial-account
                credentials, health information, biometric data, or other
                "sensitive personal information" as defined under applicable
                privacy laws.
              </p>

              <h4>Compliance with Privacy Laws</h4>
              <p>
                Each party shall comply with all applicable data-protection and
                privacy laws, including (where applicable) the General Data
                Protection Regulation (GDPR), the California Consumer Privacy Act
                (CCPA), and any other relevant U.S. state privacy laws. Where
                Botella processes personal data on behalf of Customer, the parties'
                Data Processing Addendum governs that processing.
              </p>

              <h4>Customer Marketing Use</h4>
              <p>
                Botella may identify Customer (by name and logo) as a Botella
                customer in its marketing materials, website, and investor
                communications, unless Customer notifies Botella in writing to the
                contrary. Use of Customer-specific results, case studies, or
                testimonials requires Customer's prior written approval.
              </p>

              <p className="terms-modal-note">
                By checking the box and signing in, you confirm that you have read,
                understood, and agreed to these terms.
              </p>
            </div>

            <footer className="terms-modal-footer">
              <button
                type="button"
                className="terms-modal-btn"
                onClick={() => {
                  // "I Agree" is the ONLY path that ticks the login checkbox.
                  // Closing via the X button, ESC key, or backdrop click leaves
                  // the checkbox unchecked - by design, so the user explicitly
                  // confirms agreement before the login button enables.
                  setAcceptedTerms(true);
                  setShowTermsModal(false);
                }}
              >
                I Agree
              </button>
            </footer>
          </div>
        </div>
      )}
    </div>
  );
}

export default LoginPage;
