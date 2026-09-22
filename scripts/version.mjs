#!/usr/bin/env node
/**
 * Set every publishable package (and the internal `@wappajs/*` ranges that point at them)
 * to one version. Versions must move in lockstep: create-wappa-agent pins the deps it
 * scaffolds to `^<its own version>`, so a mismatched release scaffolds broken projects.
 *
 *   node scripts/version.mjs 0.1.1
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error('usage: node scripts/version.mjs <x.y.z[-tag]>');
  process.exit(1);
}

// Derive the scope from core rather than hardcoding it, so `rename-scope.mjs` stays a
// one-command switch.
const SCOPE = JSON.parse(readFileSync('packages/core/package.json', 'utf8')).name.split('/')[0] + '/';

const dirs = readdirSync('packages');
for (const d of dirs) {
  const path = `packages/${d}/package.json`;
  const pkg = JSON.parse(readFileSync(path, 'utf8'));
  pkg.version = version;
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
    const deps = pkg[field];
    if (!deps) continue;
    for (const name of Object.keys(deps)) {
      if (name.startsWith(SCOPE)) deps[name] = `^${version}`;
    }
  }
  writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`${pkg.name} -> ${version}`);
}

// The examples are workspaces too. Their own versions stay put (they are private), but
// the ranges they put on the packages must follow, or npm installs the previous release
// from the registry instead of linking the workspace.
for (const d of readdirSync('examples')) {
  const path = `examples/${d}/package.json`;
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    continue;
  }
  let touched = false;
  for (const field of ['dependencies', 'devDependencies']) {
    const deps = pkg[field];
    if (!deps) continue;
    for (const name of Object.keys(deps)) {
      if (name.startsWith(SCOPE)) {
        deps[name] = `^${version}`;
        touched = true;
      }
    }
  }
  if (touched) {
    writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n');
    console.log(`${pkg.name} deps -> ^${version}`);
  }
}

const root = JSON.parse(readFileSync('package.json', 'utf8'));
root.version = version;
writeFileSync('package.json', JSON.stringify(root, null, 2) + '\n');
console.log(`${root.name} -> ${version}`);
