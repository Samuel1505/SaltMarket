import type { Catalog } from '@saltmarket/shared/protocol';

export type Good = Catalog['goods'][number]['id'];

/** Lower-case display name for a good ("cured fish"), from the server's catalog. */
export function goodLabel(catalog: Catalog, good: string): string {
  return (catalog.goods.find((g) => g.id === good)?.name ?? good.replace(/_/g, ' ')).toLowerCase();
}

/** "6 fish + 3 salt + 1 barrel" */
export function bundleText(catalog: Catalog, items: Partial<Record<Good, number>>): string {
  return Object.entries(items)
    .filter(([, n]) => (n ?? 0) > 0)
    .map(([g, n]) => `${n} ${goodLabel(catalog, g)}`)
    .join(' + ');
}

/** Which gather spot yields a good, if any ("Pier"). */
export const GATHER_HINT: Partial<Record<Good, string>> = { fish: 'the Pier', salt: 'the Salt pans', timber: 'the Grove' };
