# TEAM_SPLIT.md — who builds what, and how the two halves meet

Two people, five days. The split below lets the backend/contract owner and the frontend/integration owner work **in parallel** without blocking each other. If this file conflicts with `CLAUDE.md`, `CLAUDE.md` wins; tell the humans and fix this file.

---

## 1. Ownership

| Area | Owner | Paths |
| --- | --- | --- |
| Smart contract | **Backend owner** | `contracts/goods/` |
| Simulation engine, NPCs, economy | **Backend owner** | `packages/sim/`, `packages/shared/src/config/` |
| Ledger adapter, settlement | **Backend owner** | `packages/chain/` |
| Server, API, WebSocket, tick loop, time-lapse | **Backend owner** | `apps/server/` |
| Protocol types and schemas (the interface) | **Backend owner authors; frontend owner reviews** | `packages/shared/src/protocol.ts` |
| Web client, design system, UI polish | **Frontend owner** | `apps/web/` |
| Connecting the web client to the server (REST + WS, auth UI, state store) | **Frontend owner** | `apps/web/src/lib/`, `apps/web/src/store/` |
| Judge panel and Ledger drawer UI | **Frontend owner** | `apps/web/src/features/judge/` |
| Demo video, screenshots, X post draft | Frontend owner (backend owner supports) | |
| README, submission payload, final sign-off | **Both**, with the team lead confirming | `README.md`, `docs/SUBMISSION.md` |

**To settle between the two humans early:** social login. The *widget and redirect flow* live in the web client; the *token verification and account creation* live on the server. Decide who owns each half and write it here.

**Rule for Claude Code sessions:** each session works only in the paths its human owns. If a change is needed in the other person's area, write it up as a request (what and why) instead of editing it.

## 2. The interface is the contract

Everything the frontend needs from the backend lives in **`packages/shared/src/protocol.ts`**, written as zod schemas with inferred TypeScript types: REST responses, WebSocket client→server messages, server→client messages, and the world snapshot and delta shapes (see `ARCHITECTURE.md` §4.4).

Rules:
1. **Publish API v0 first**, before the sim exists (target: within the first hours). The frontend can then build against it.
2. **Changes are additive.** Add fields and message types; do not rename or remove without telling the other person. If a breaking change is unavoidable, bump a `PROTOCOL_VERSION` constant and post a short note.
3. **Error shape is fixed:** `{ ok:false, code, message }` with stable `code` strings (e.g., `INSUFFICIENT_GOODS`). Friendly `message` text is player-facing.
4. **No chain vocabulary in player-facing payloads** (messages, labels). Chain data appears only under judge endpoints.
5. Money is integer pips everywhere in the protocol; the client formats marks for display.

## 3. Mock server: unblock the frontend on day one

The backend owner ships a **mock mode** early:

```bash
pnpm dev:mock      # serves protocol-valid fake data over the real REST + WS endpoints
```

- Streams a scripted world: ticking clock, a handful of price changes, NPC cards with reasoning text, an open and a closed merchant, a Storm event, a ship arrival, and a few feed items.
- Accepts every client message type and replies with plausible acks (`ok:true` or a typical error), so the UI's success and failure states can be built.
- Replaced by the real sim behind the **same** endpoints when ready; the frontend changes nothing but the server URL or a flag.

## 4. Git workflow for two people

- One private team repository. Branches: `main` (stable), `backend/*`, `frontend/*`.
- Each person integrates to `main` at least once a day, after typecheck and tests pass. Keep `packages/shared` merges small and announced.
- `CLAUDE.md` Status block: keep one section per person to avoid merge conflicts (`Status — backend`, `Status — frontend`).
- Claude Code's push rule (from `CLAUDE.md` §3) still applies: **pushing to the private team repo on a feature branch is fine only when the human has said so for this session; force-push, pushing to `main`, and making the repo public always need explicit confirmation.**

## 5. Checkpoints

| When | Backend owner delivers | Frontend owner can then |
| --- | --- | --- |
| Nov 9, tonight | `protocol.ts` API v0 + `pnpm dev:mock` | Build screens against fake data |
| Nov 10, evening | Real tick loop + gather/sell/cure on the real sim behind the same endpoints (thin slice, `MemoryLedger`) | Replace mock with live data; first playtest |
| Nov 11 | Closure/invest, Storm, time-lapse endpoint, tuning | Wire Invest, tooltips from `/explain`, time-lapse panel |
| Nov 11–12 | Minimal NEP-245 contract deployed to testnet (human confirms deploy) | Judge/Ledger drawer UI |
| **Nov 12, end of day — gate** | Server stable on `MemoryLedger`; contract on testnet | Playable loop in browser. If not, shrink NEAR scope and disclose it |
| Nov 13 | `NearLedger` + settlement queue + idempotent batches | Ledger drawer shows real settlements; record demo |
| Nov 14 | Support clean-clone test, README, submission | Final polish, X post |

## 6. Shared secrets and accounts

- Only the backend owner holds the testnet authority and relayer keys, in a local `.env` that is never committed or pasted into chat. The frontend owner never needs them.
- The frontend runs entirely against the server's public endpoints.
- The hackathon payout account (mainnet) and the submission email belong to the team lead and are only needed on Nov 14.

## 7. Questions to resolve together (write the answers here)

1. Who owns social login: client widget vs. server verification?
2. Who writes the README sections: backend owner for architecture/economy/NEAR, frontend owner for "try it" steps and screenshots?
3. Is the demo recorded against `MemoryLedger`, testnet, or both (see `TESTING_AND_DEMO.md` §5)?
