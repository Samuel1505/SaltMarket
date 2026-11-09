# TUNING_LOG.md — Saltmarket economy tuning

Procedure: `docs/ECONOMY.md` §11, one lever at a time. Checker: `pnpm sim:tune --seeds 10 [--bots 5] [--days 30]`. It runs seeds 1–10 and reports four checks:

- **Clamp:** no good's daily median sits at the 0.5× or 2.5× anchor edge for more than 3 days outside a storm.
- **Burn/mint:** the rolling 5-day ratio is within 0.85–1.10 after day 5, in at least 80% of windows.
- **Supply:** total marks supply changes by no more than ±30% from day 5 to the end.
- **Ceiling:** the Captain's ceiling is not pinned at a bound for more than 3 visits in a row.

All values live in `packages/shared/src/config/economy.ts`. Pricing rules live in `packages/sim/src/pricing/merchant-rules.ts`.

## 2026-11-09 session

| # | Lever | Change | Why | Result (NPC-only, 10 seeds × 30 days) |
| --- | --- | --- | --- | --- |
| 0 | Baseline | — | — | All 4 checks fail. Raw goods at the 0.5× floor for 26 days; ceiling pinned at 90 for 11 visits; burn/mint 0.17–1.08; supply +123–129%; the Cooper closes in every seed. |
| L1 | Captain rule | The Smokehouse may fill demand still unmet in the **last 3 of 12 docked ticks**, beyond its 8-of-16 cap (`captain.smokehouseLateFillTicks`). | With no players nobody supplied the other 8, so the ceiling rose every visit. Players keep priority for the first 9 ticks, so the approved "≈ half" rule holds when players are present. | Ceiling unpinned until the Cooper went broke (day ~17); raw goods still at floor. |
| L2 | Producer base output | Fisherman 8→5/day, salt-panner 6→4, woodcutter 10→4. | Supply was about 2× what the Captain's demand needs (fish 24/day vs ~12). | Ceiling check passes; prices move (fish 8–13); 1 closure per seed. |
| L3 | Ask rule | A seller asks at least 97% of the best standing bid for its good (`askOfBestBid`). | The Smokehouse bought at cost-based asks and kept the whole margin (~4,500 marks hoarded) while producers went broke. | 0 closures; but bids spiralled (barrels at the 2.5× cap) because the Smokehouse bid its full break-even. |
| L4 | Bid rule | Bid = min(break-even × (1 − margin), median × (1 + 0.2 × stock shortfall)) (`bidNeedPremium`). | Buyers should bid near the going price, more when short; never above break-even. | Spiral gone, but the Cooper went broke again. |
| L5 | Ask rule (spec fix) | `cost_basis` = materials + (living + upkeep) ÷ expected daily sales (`expectedDailySales`), as ECONOMY §8.1 specifies. Removed the 0.85 × anchor shortcut. | Merchants could price below their own running costs. | **Clamp check passes; 0 closures**; raw prices settle near cost. Burn/mint 0.41–0.52 (too much minting). |
| L6 | Captain rule | A visit that fills completely (not fast) eases the ceiling 3% (`fullFillLowerBps`). Fast fill still −5%. | The ceiling could only rise once the Smokehouse late-filled each visit. | Ceiling now tracks supply (80→55 over 30 days). |
| L7 | Captain start ceiling | 60 → 50. | Closer to the 45-mark anchor; less early over-minting. | Burn/mint 0.56–0.77. |
| L8 | Demurrage | 0.5%/day above 1,000 → 1.5%/day above 500. | Profits pile up as cash; demurrage is the anti-hoarding sink. | 0.59–0.86. |
| L9 | NPC living cost | 15 → 20 marks/day. | Raise burn. | **No real effect**: cost-plus pricing passes costs into prices, so mint rises with burn. Kept (harmless). |
| L10 | Demurrage | → 3%/day above 300. | Burn the margins, not the costs. | 0.67–0.98, 29% of windows in band. |
| L11 | Production rule | Producers stop producing at 1.5× target stock (`productionStopOfTarget`; was 3×). | Overfull sheds triggered the excess-stock discount, pushing prices below cost; producers fell to 0 cash without closing, so their costs couldn't be burned. | 0.70–1.01, 43% in band. |
| L12 | Starting state | The Smokehouse opens with 8 cured fish. | The first visits were half-filled while it ramped up, pushing the ceiling to ~62 and over-minting early. | **Burn/mint passes** (95%, 0.79–1.06). Supply +16–42%. |
| L13 | Town Fund cap | 5,000 → 1,500 marks. | Needs only ~150 per rescue; tax piling up there counts as supply growth. | **No measurable effect** (the fund stays under the cap). Kept. |
| L14 | Bid rule | Merchant bids are clamped to the same 0.5×–2.5× anchor band as asks. Buying pauses if break-even is below the floor. | A bot dumping fish drove the Smokehouse's bid to 1 mark: a flood should make goods cheap, not free. | Fixes the clamp check with bots present. |
| L15 | Captain volume | The order grows by 2 after a fast fill and shrinks by 2 when ≥ 25% unfilled, within 12–32 (`volumeStep`, `minVolume`, `maxVolume`). | Fixed demand made extra player supply pin the ceiling at its floor. Demand now responds to supply. | **NPC-only: all 4 checks pass** (burn/mint 0.87–1.08 in 100% of windows; supply +7–15%; worst clamp dwell 0; ceiling never pinned). |
| L16 | Captain volume | Max order 32 → 24. | Limit how far players' supply can inflate minting. | NPC-only unchanged (all pass). |

### Current status

- **NPC-only, 10 seeds × 30 days: all four §11 checks pass.**
- **With 5 always-on bot players: 3 of 4 checks fail.** Burn/mint is 0.43–1.04, supply grows +57–71%, and the ceiling sits at its floor for up to 9 visits.
  - Cause: gathering is free and generous. Each bot gathers 12 units a day, enough for one cure batch. Five bots therefore produce about 20 cured fish a day against a Captain who buys 6–12 a day, and every sale is newly minted marks.
  - The levers that would fix this (the daily gather cap, gather yield, or node regeneration) change the approved 30-second loop, so they are a decision for the human. See the open question in `CLAUDE.md` Status.
