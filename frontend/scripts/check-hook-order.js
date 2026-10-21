#!/usr/bin/env node
/* eslint-disable no-console */
// -----------------------------------------------------------------------------
// One bug class, checked exactly: a hook called on a value declared below it.
//
//     const topPage = useTablePage(top);   // line 93
//     ...
//     const top = useMemo(...);            // line 100
//
// That compiles. `top` is a const, so it is in its temporal dead zone until its
// own line runs, and reading it above throws at RENDER:
//
//     ReferenceError: Cannot access 'top' before initialization
//
// which took the Customers screen down behind a green build. `npm run build`
// cannot catch it - the component is never executed - and eslint's
// no-use-before-define flags the same shape inside callbacks, where it is
// harmless, so it can only be a warning among dozens.
//
// This checks the narrow case that is always a bug: a hook argument, at the top
// level of a component, naming a const declared later in the same file.
// -----------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const SRC = path.resolve(__dirname, '..', 'src');
const HOOK = /^\s*const\s+(\w+)\s*=\s*use[A-Z]\w*\(\s*([A-Za-z_$][\w$]*)\s*[,)]/;
const DECL = /^\s*const\s+([A-Za-z_$][\w$]*)\s*=/;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

let bad = 0;
for (const file of walk(SRC)) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  // Where each top-level-ish const is declared.
  const declaredAt = new Map();
  lines.forEach((ln, i) => {
    const m = DECL.exec(ln);
    if (m && !declaredAt.has(m[1])) declaredAt.set(m[1], i);
  });
  lines.forEach((ln, i) => {
    const m = HOOK.exec(ln);
    if (!m) return;
    const arg = m[2];
    const at = declaredAt.get(arg);
    if (at != null && at > i) {
      bad++;
      console.error(
        `\x1b[31m${path.relative(SRC, file)}:${i + 1}\x1b[0m  ` +
        `${m[1]} = ${ln.trim().split('=')[1].trim().split('(')[0]}(${arg}) ` +
        `reads '${arg}', declared at line ${at + 1}.`);
      console.error(`    Move the hook below the declaration, or it throws on render.`);
    }
  });
}

if (bad) {
  console.error(`\n\x1b[31m[check-hook-order] ${bad} hook(s) read a value declared below them.\x1b[0m`);
  process.exit(1);
}
console.log('\x1b[32m[check-hook-order] every hook argument is declared before its hook.\x1b[0m');
