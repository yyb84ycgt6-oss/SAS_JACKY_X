#!/usr/bin/env node
/**
 * Integrity manifest — tamper-evidence for protected paths.
 *
 *   node scripts/integrity.mjs verify     # recompute and compare (CI gate; exit 1 on drift)
 *   node scripts/integrity.mjs generate   # rewrite the manifest after an AUTHORIZED change
 *
 * Deliberately dependency-free. A guard that pulls in third-party packages
 * inherits their supply chain, which defeats the point of the guard.
 *
 * Output is deterministic (no timestamps) so regeneration is idempotent and
 * every diff in .integrity/manifest.json is a real change to a protected file.
 *
 * See GOVERNANCE.md for the authority this enforces.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const CONFIG_PATH = '.integrity/protected.json';
const MANIFEST_PATH = '.integrity/manifest.json';

// Never walked: build output, dependencies, VCS internals.
const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'dist-ssr', 'coverage',
  'playwright-report', 'test-results', '.vercel', '.next',
]);

/** Minimal glob → RegExp. Supports **, *, ? with POSIX-style separators. */
function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } // **/ spans zero or more dirs
        else { re += '.*'; i += 1; }                            // ** spans anything
      } else {
        re += '[^/]*';                                          // * stays within one segment
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$');
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, out);
    } else if (entry.isFile()) {
      out.push(relative(ROOT, full).split(sep).join('/'));
    }
  }
  return out;
}

function hashFile(path) {
  return createHash('sha256').update(readFileSync(join(ROOT, path))).digest('hex');
}

function loadPatterns() {
  let raw;
  try {
    raw = readFileSync(join(ROOT, CONFIG_PATH), 'utf8');
  } catch {
    console.error(`FATAL: ${CONFIG_PATH} is missing. The integrity guard cannot run.`);
    console.error('Removing the config is itself a tampering signal — restore it from git history.');
    process.exit(1);
  }
  const patterns = JSON.parse(raw).protected;
  if (!Array.isArray(patterns) || patterns.length === 0) {
    console.error(`FATAL: ${CONFIG_PATH} declares no protected paths.`);
    process.exit(1);
  }
  return patterns.map((p) => ({ glob: p, re: globToRegExp(p) }));
}

/** Every tracked file matching any protected pattern, sorted for determinism. */
function collect() {
  const patterns = loadPatterns();
  return walk(ROOT)
    .filter((f) => patterns.some((p) => p.re.test(f)))
    .sort();
}

function buildManifest() {
  const files = {};
  for (const f of collect()) files[f] = hashFile(f);
  return { algorithm: 'sha256', files };
}

function generate() {
  const manifest = buildManifest();
  writeFileSync(join(ROOT, MANIFEST_PATH), JSON.stringify(manifest, null, 2) + '\n');
  const n = Object.keys(manifest.files).length;
  console.log(`Manifest regenerated: ${n} protected file${n === 1 ? '' : 's'}.`);
  console.log('This records the CURRENT state as authorized. Commit it only if you');
  console.log('intended every change it captures — review the diff before pushing.');
}

function verify() {
  let recorded;
  try {
    recorded = JSON.parse(readFileSync(join(ROOT, MANIFEST_PATH), 'utf8')).files;
  } catch {
    console.error(`FATAL: ${MANIFEST_PATH} is missing or unreadable.`);
    console.error('Run: node scripts/integrity.mjs generate');
    process.exit(1);
  }

  const current = buildManifest().files;
  const modified = [];
  const removed = [];
  const added = [];

  for (const [path, hash] of Object.entries(recorded)) {
    if (!(path in current)) removed.push(path);
    else if (current[path] !== hash) modified.push(path);
  }
  for (const path of Object.keys(current)) {
    if (!(path in recorded)) added.push(path);
  }

  const total = modified.length + removed.length + added.length;
  if (total === 0) {
    console.log(`Integrity OK — ${Object.keys(current).length} protected files match the manifest.`);
    return;
  }

  console.error('INTEGRITY CHECK FAILED — protected files drifted from the manifest.\n');
  for (const p of modified) console.error(`  MODIFIED  ${p}`);
  for (const p of removed)  console.error(`  REMOVED   ${p}`);
  for (const p of added)    console.error(`  ADDED     ${p}`);
  console.error(`
${total} unauthorized change${total === 1 ? '' : 's'} detected.

If this change was NOT authorized by the Principal, reject it. See GOVERNANCE.md.

If it WAS authorized, regenerate the manifest and include it in the same PR:
  node scripts/integrity.mjs generate
The regenerated manifest still requires Code Owner approval to merge.`);
  process.exit(1);
}

const cmd = process.argv[2];
if (cmd === 'generate') generate();
else if (cmd === 'verify') verify();
else {
  console.error('Usage: node scripts/integrity.mjs <verify|generate>');
  process.exit(1);
}
