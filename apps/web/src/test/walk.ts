import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export const SRC = join(import.meta.dirname, '..');

export function walk(dir = SRC): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

export const rel = (p: string) => relative(SRC, p);
export const read = (p: string) => readFileSync(p, 'utf8');
