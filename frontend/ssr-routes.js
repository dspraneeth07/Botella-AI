/* Throwaway: assert every navigable view is actually reachable - the two lists
   that have to agree (ChatPage's VALID_VIEWS and App.js's APP_VIEW_PATHS) plus
   the sidebar handlers that drive them. This is the check that would have
   caught the dead Statistics button. Delete after use. */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, 'src');
const chat = fs.readFileSync(path.join(SRC, 'pages/ChatPage.js'), 'utf8');
const app = fs.readFileSync(path.join(SRC, 'App.js'), 'utf8');
const sidebar = fs.readFileSync(path.join(SRC, 'components/Sidebar.js'), 'utf8');

const list = (src, name) => {
  const m = src.match(new RegExp(name + "\\s*=\\s*\\[([^\\]]*)\\]"));
  if (!m) throw new Error(name + ' not found');
  return m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
};

const views = list(chat, 'VALID_VIEWS');
const paths = list(app, 'APP_VIEW_PATHS').map((p) => p.replace(/^\//, ''));

// /storeagent renders the shell but is not one of ChatPage's view slugs - it is
// a deep link that the Recommendations view consumes. Exclude it from the
// "every path has a view" direction only.
const SHELL_ONLY = new Set(['storeagent']);

const missingPath = views.filter((v) => !paths.includes(v));
const missingView = paths.filter((p) => !views.includes(p) && !SHELL_ONLY.has(p));

// Anything the sidebar can navigate to must be a known view.
const navTargets = [...chat.matchAll(/setActiveView\('([a-z-]+)'\)/g)].map((m) => m[1]);
const badNav = [...new Set(navTargets)].filter((v) => !views.includes(v));

// And each nav prop the sidebar declares must actually be passed in.
const sidebarProps = ['onDashboard', 'onStatistics', 'onSuggestions'];
const unpassed = sidebarProps.filter((p) => !new RegExp(p + '=\\{').test(chat));
const undeclared = sidebarProps.filter((p) => !sidebar.includes(p));

const checks = [
  ['statistics is a known view', views.includes('statistics')],
  ['statistics has a route', paths.includes('statistics')],
  ['every view has a route', missingPath.length === 0, missingPath],
  ['every app path has a view', missingView.length === 0, missingView],
  ['every setActiveView target is valid', badNav.length === 0, badNav],
  ['sidebar nav props are passed by ChatPage', unpassed.length === 0, unpassed],
  ['sidebar declares each nav prop', undeclared.length === 0, undeclared],
];

let failed = 0;
for (const [label, ok, detail] of checks) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail && detail.length ? '  -> ' + detail.join(', ') : ''}`);
}
console.log(`\nviews: ${views.join(', ')}`);
console.log(`paths: ${paths.join(', ')}`);
console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nall route checks pass');
process.exit(failed ? 1 : 0);
