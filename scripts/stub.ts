// Placeholder used by not-yet-built commands so `pnpm <cmd>` is runnable from day one.
export function notYet(name: string): void {
  console.log(`${name}: not implemented yet (see docs/BUILD_PLAN.md).`);
}
