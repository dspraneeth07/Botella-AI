import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import HomePage from './pages/HomePage';
import PlatformPage from './pages/PlatformPage';
import CompanyPage from './pages/CompanyPage';
import AdvisorsPage from './pages/AdvisorsPage';
import LoginPage from './pages/LoginPage';
import ChatPage from './pages/ChatPage';
import NotFoundPage from './pages/NotFoundPage';
import ContactPage from './pages/ContactPage';
import PrivacyPolicyPage from './pages/PrivacyPolicyPage';
import TermsAndConditionsPage from './pages/TermsAndConditionsPage';
import BlogIndexPage from './pages/BlogIndexPage';
import BlogPostPage from './pages/BlogPostPage';
import ErrorBoundary from './components/ErrorBoundary';
import { DemoPopupProvider } from './components/DemoPopupContext';
import usePageView from './utils/usePageView';
import useIdleLogout from './utils/useIdleLogout';

// SEO landing pages (one per route, from the SEO Changes brief).
// DistilleriesPage and ReorderingPage were removed - Botella is no longer
// pitching to distilleries directly, and the standalone "Automated Reordering"
// page was folded back into the AI Agent narrative.
import RetailersPage              from './pages/seo/RetailersPage';
import AIAgentPage                from './pages/seo/AIAgentPage';
import InventoryPage              from './pages/seo/InventoryPage';
import CustomerInsightsPage       from './pages/seo/CustomerInsightsPage';
import SalesAnalyticsPage         from './pages/seo/SalesAnalyticsPage';
import MarginOptimizationPage     from './pages/seo/MarginOptimizationPage';
import ProductRecommendationsPage from './pages/seo/ProductRecommendationsPage';
import { DialogProvider } from './components/Dialog';

// Tiny component that fires GA4 + GTM pageview events whenever the route
// changes (SPA navigation). Must live inside <BrowserRouter>. Renders
// nothing - it's pure side-effect.
function PageViewTracker() {
  usePageView();
  return null;
}

function ProtectedRoute({ children }) {
  // Every authenticated view goes through here, so this is where the idle
  // timeout is armed - one instance, covering the whole signed-in app.
  useIdleLogout();
  const token = localStorage.getItem('botella_token');
  if (!token) return <Navigate to="/login" replace />;
  return children;
}

// All authenticated app views share the same ChatPage shell but deserve
// distinct URLs for deep-linking, browser history, and analytics. Each of
// these paths renders ChatPage; the component reads the URL to decide which
// view to show.
// Keep in step with VALID_VIEWS in ChatPage: a path here with no slug there
// renders the shell on a view it does not know, and a slug there with no
// path here navigates into the 404.
const APP_VIEW_PATHS = ['/chat', '/recommendations', '/purchasing', '/purchase-orders', '/card-statements', '/market', '/customers', '/effectiveness', '/bottlesense', '/command', '/summary', '/dashboard', '/reports', '/statistics', '/suggestions', '/market-analysis', '/storeagent'];

// Public SEO landing pages, defined as data so we keep the list flat and
// easy to scan. The URL slugs match exactly what's in the SEO brief -
// any rename here would also need to update sitemap.xml + canonical URLs.
const SEO_PUBLIC_PAGES = [
  { path: '/platform',                                      element: <PlatformPage /> },
  { path: '/company',                                       element: <CompanyPage /> },
  { path: '/advisors',                                      element: <AdvisorsPage /> },
  { path: '/contact',                                       element: <ContactPage /> },
  { path: '/privacy-policy',                                element: <PrivacyPolicyPage /> },
  { path: '/terms-and-conditions',                          element: <TermsAndConditionsPage /> },
  { path: '/blog',                                          element: <BlogIndexPage /> },
  { path: '/blog/:slug',                                    element: <BlogPostPage /> },
  { path: '/ai-for-liquor-retailers',                       element: <RetailersPage /> },
  { path: '/ai-agent-for-liquor-stores',                    element: <AIAgentPage /> },
  { path: '/ai-inventory-management-liquor-stores',         element: <InventoryPage /> },
  { path: '/customer-insights-liquor-stores',               element: <CustomerInsightsPage /> },
  { path: '/liquor-store-sales-analytics-insights',         element: <SalesAnalyticsPage /> },
  { path: '/margin-optimization-liquor-stores',             element: <MarginOptimizationPage /> },
  { path: '/ai-product-recommendations-liquor-stores',      element: <ProductRecommendationsPage /> },
];

function App() {
  const chatElement = (
    <ProtectedRoute>
      <div className="app-chat-layout">
        <ChatPage />
      </div>
    </ProtectedRoute>
  );

  return (
    <ErrorBoundary>
      {/* DemoPopupProvider must wrap all routes so every page can call
          useDemoPopup() to open the shared "Book a Demo" email popup.
          One <DemoPopup /> instance lives inside the provider so there's
          no risk of two popups stacking. */}
      {/* Every question the product asks is asked BY the product. A
          window.confirm freezes the tab, is drawn by the OS with our URL
          stamped above it, cannot be themed, and labels its buttons "OK" and
          "Cancel" whatever was asked - which on a shared back-office machine
          reads uncomfortably like a phishing prompt. */}
      <DialogProvider>
      <DemoPopupProvider>
        {/* Fires GA4 + GTM pageview events on every route change.
            Without this, only the initial page load is tracked. */}
        <PageViewTracker />
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/login" element={<LoginPage />} />

          {/* SEO content pages (public - crawlable, no auth) */}
          {SEO_PUBLIC_PAGES.map(({ path, element }) => (
            <Route key={path} path={path} element={element} />
          ))}

          {/* App views (auth-gated, share ChatPage shell) - incl. /storeagent */}
          {APP_VIEW_PATHS.map((path) => (
            <Route key={path} path={path} element={chatElement} />
          ))}

          {/* Catch-all 404 - must be LAST. Any URL that didn't match an
              earlier route falls through here. NotFoundPage uses
              ContentLayout so it shares the same header/footer chrome
              as the rest of the public site, and useSEO({ noindex: true })
              keeps it out of search results. */}
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </DemoPopupProvider>
      </DialogProvider>
    </ErrorBoundary>
  );
}

export default App;
