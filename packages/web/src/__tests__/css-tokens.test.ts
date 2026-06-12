import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SRC = resolve(__dirname, '..'); // packages/web/src
const GLOBALS = join(SRC, 'app', 'globals.css');

function definedTokens(): Set<string> {
  const css = readFileSync(GLOBALS, 'utf-8');
  const defs = css.match(/--[a-z-]+(?=\s*:)/g) ?? [];
  return new Set(defs.map((d) => d.trim()));
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name !== '__tests__') walk(p, out);
    } else if (/\.(ts|tsx|css)$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

function referencedTokens(): Set<string> {
  const refs = new Set<string>();
  for (const file of walk(SRC)) {
    const text = readFileSync(file, 'utf-8');
    for (const m of text.matchAll(/var\((--[a-z-]+)\)/g)) refs.add(m[1]);
  }
  return refs;
}

describe('CSS custom properties', () => {
  it('every var(--x) referenced in src is defined in globals.css', () => {
    const defined = definedTokens();
    const missing = [...referencedTokens()].filter((t) => !defined.has(t)).sort();
    expect(missing).toEqual([]);
  });
});
