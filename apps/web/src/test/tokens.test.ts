// FRONTEND.md §4.3: no inline durations, easing curves or raw colors outside the token files.
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { dur, ease } from '../styles/tokens.motion';
import { SRC, read, rel, walk } from './walk';

const TOKEN_FILES = new Set(['styles/tokens.css', 'styles/tokens.motion.ts']);
const files = walk().filter((p) => /\.(css|tsx?)$/.test(p) && !TOKEN_FILES.has(rel(p)) && !rel(p).startsWith('test/'));

const RULES: Array<[RegExp, string]> = [
  [/cubic-bezier\(/, 'easing curve: use var(--ease-*) or ease.* from tokens.motion.ts'],
  [/(?<![\w$-])\d*\.?\d+m?s\b(?![\w-])/, 'duration literal: use var(--dur-*) or dur.* from tokens.motion.ts'],
  [/#[0-9a-fA-F]{3,8}\b/, 'raw hex color: use a color token'],
  [/\b(?:rgb|rgba|hsl|hsla|oklch|oklab)\(/, 'raw color function: use a color token'],
];

function strip(src: string): string {
  // Drop comments so explanations can mention values.
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('design tokens', () => {
  it('components use tokens only (no raw durations, curves or colors)', () => {
    const problems: string[] = [];
    for (const f of files) {
      strip(read(f))
        .split('\n')
        .forEach((line, i) => {
          for (const [re, why] of RULES) if (re.test(line)) problems.push(`${rel(f)}:${i + 1}  ${why}\n    ${line.trim()}`);
        });
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('tokens.css and tokens.motion.ts agree on motion values', () => {
    const css = read(join(SRC, 'styles/tokens.css'));
    const cssVar = (name: string) => css.match(new RegExp(`--${name}:\\s*([^;]+);`))?.[1]?.trim();
    const kebab = (k: string) => k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
    for (const [k, v] of Object.entries(dur)) expect(cssVar(`dur-${kebab(k)}`), `--dur-${k}`).toBe(`${v}ms`);
    for (const [k, v] of Object.entries(ease)) {
      if (k === 'linear') continue;
      expect(cssVar(`ease-${kebab(k)}`), `--ease-${k}`).toBe(v);
    }
  });

  it('UI motion stays inside the skill budgets (< 300 ms, press 100–160 ms, tooltip 125–200 ms)', () => {
    expect(dur.press).toBeGreaterThanOrEqual(100);
    expect(dur.press).toBeLessThanOrEqual(160);
    expect(dur.tooltip).toBeGreaterThanOrEqual(125);
    expect(dur.tooltip).toBeLessThanOrEqual(200);
    for (const v of Object.values(dur)) expect(v).toBeLessThanOrEqual(300);
  });
});
