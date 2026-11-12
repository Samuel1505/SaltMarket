// CLAUDE.md §9 / FRONTEND.md §6: player-facing text never uses chain words. Only features/judge/ may.
// Scans string literals and JSX text in src (outside features/judge and tests). A line may opt out with
// a trailing `// vocab-ok: <reason>` when the word is a protocol identifier, not text a player sees.
import { describe, expect, it } from 'vitest';
import { read, rel, walk } from './walk';

const FORBIDDEN = /\b(wallets?|tokens?|gas|mint(?:ed|ing)?|tx|txs|address(?:es)?|near|blockchain|crypto|on-?chain)\b/i;

const files = walk().filter((p) => /\.tsx?$/.test(p) && !rel(p).startsWith('features/judge/') && !rel(p).startsWith('test/'));

/** Player-visible candidates on a line: quoted strings, template literals and JSX text. */
function visibleText(line: string): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(/'([^'\\]*(?:\\.[^'\\]*)*)'|"([^"\\]*(?:\\.[^"\\]*)*)"|`([^`]*)`/g)) out.push(m[1] ?? m[2] ?? m[3] ?? '');
  for (const m of line.matchAll(/>([^<>{}]+)</g)) out.push(m[1] ?? '');
  // JSX text that runs to the end of the line (multi-line JSX children).
  if (!/[;{}()=]/.test(line.trim()) && /^[A-Za-z]/.test(line.trim())) out.push(line.trim());
  return out;
}

describe('player-facing vocabulary', () => {
  it('no chain words outside features/judge/', () => {
    const problems: string[] = [];
    for (const f of files) {
      read(f)
        .split('\n')
        .forEach((line, i) => {
          if (/vocab-ok/.test(line) || /^\s*(\/\/|\*|import\b)/.test(line)) return;
          for (const t of visibleText(line)) {
            const m = t.match(FORBIDDEN);
            if (m) problems.push(`${rel(f)}:${i + 1}  "${m[0]}" in: ${t.trim()}`);
          }
        });
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('the scanner catches a forbidden word', () => {
    expect(visibleText(`<p>Connect your wallet</p>`).some((t) => FORBIDDEN.test(t))).toBe(true);
    expect(visibleText(`toast('Paid 2 gas')`).some((t) => FORBIDDEN.test(t))).toBe(true);
  });
});
