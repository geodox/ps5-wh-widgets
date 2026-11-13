#!/usr/bin/env node
// Minify the widget loader for embedding in the payload.
//
//   node tools/build_loader.js [framework/loader.js] [out/loader.min.js]
//
// The installer prepends the loader to EVERY evaluateJavaScript call in
// SceShellUI, so the embedded copy is minified (comments and whitespace removed,
// locals shortened) to keep the per-eval parse cost low. Property names and
// string contents are left untouched, so the behavior is the same as the readable
// framework/loader.js.
//
// Also checks that the asset-server URL hard-coded in the loader matches
// WH_ASSET_URL in the C sources, so the two cannot drift apart.
//
// Needs the pinned dev dependency: `npm ci` in tools/.
'use strict';
const fs = require('fs');
const path = require('path');
const { minify } = require('terser');

const ROOT = path.resolve(__dirname, '..');
const src = path.resolve(process.argv[2] || path.join(ROOT, 'framework', 'loader.js'));
const dst = path.resolve(process.argv[3] || path.join(ROOT, 'out', 'loader.min.js'));

function assetUrlFromC() {
  const dir = path.join(ROOT, 'framework');
  for (const f of fs.readdirSync(dir)) {
    if (!/\.[ch]$/.test(f)) continue;
    const m = /#define\s+WH_ASSET_URL\s+"([^"]+)"/.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (m) return m[1];
  }
  throw new Error('WH_ASSET_URL not found in framework/*.c|*.h');
}

(async () => {
  const code = fs.readFileSync(src, 'utf8');

  const url = assetUrlFromC();
  const used = new Set(code.match(/http:\/\/[0-9.]+:[0-9]+\//g) || []);
  if (used.size !== 1 || !used.has(url)) {
    throw new Error(`loader uses ${[...used].join(', ') || 'no'} asset URL; WH_ASSET_URL is ${url}`);
  }

  const out = await minify(code, {
    ecma: 5,
    compress: false, // whitespace + local renames only: no code transformations
    mangle: { toplevel: false },
    format: { ecma: 5, comments: false, keep_quoted_props: true, ascii_only: true },
  });
  if (out.code.includes('\0')) throw new Error('loader contains a NUL byte');

  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, out.code);
  console.log(`loader: ${code.length} -> ${out.code.length} bytes -> ${path.relative(ROOT, dst)}`);
})().catch((e) => {
  console.error('build_loader: ' + e.message);
  process.exit(1);
});
