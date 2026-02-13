# Auto-Battler Dev Checklist (1v1, 7x4) + Text MUD Story Layer

This checklist is for the pivot:
- Core game: session-based 1v1 auto-battler (TFT-like) on a 7x4 board.
- Story: short MUD-style events between rounds, implemented as deterministic build choices.

Conventions:
- [ ] Not started
- [~] In progress / partial
- [x] Done

## A. Product Lock (Do First)
- [x] Mode: 1v1 first, expand to FFA after stabilization
- [x] Board: 7x4 (per side)
- [ ] Session length target: 12-18 minutes
- [ ] Rounds target: 10-14 rounds
- [ ] Phase timings:
  - Prep: 25-40s
  - Fight: 20-40s
  - Result: 5-10s
- [ ] Win condition (MVP): HP depletion or best-of-rounds (pick one and lock)

## B. Data Model (DB)
- [ ] `matches` table (mode/status/seed)
- [ ] `match_players` table (seat/player/officer/hp/gold/level/xp/board/bench/effects)
- [ ] `match_rounds` table (round/phase/timers/result)
- [ ] Indexes for state queries (by match_id, by player_id)
- [ ] Runtime schema ensure in API startup (compatible with existing DB volumes)

## C. Backend APIs (MVP)
### Match lifecycle
- [ ] `POST /api/match/create` (dev): create match for `playerId` vs bot (seat2)
- [ ] `GET /api/match/:matchId/state?playerId=...` (dev): fetch own + opponent state
- [ ] `POST /api/match/:matchId/ready` (optional for later)

### Prep actions
- [ ] `POST /api/match/:matchId/shop/reroll`
- [ ] `POST /api/match/:matchId/shop/lock`
- [ ] `POST /api/match/:matchId/shop/buy`
- [ ] `POST /api/match/:matchId/board/place`
- [ ] `POST /api/match/:matchId/bench/swap` (or a generic move op)

### Story layer (between rounds)
- [ ] Event defs structure (JSONB)
- [ ] `POST /api/match/:matchId/story/choice`
- [ ] Effects interpreter (deterministic) for:
  - [ ] gold delta
  - [ ] reroll cost delta (this round)
  - [ ] shop slot delta (this round)
  - [ ] grant item
  - [ ] reveal enemy info (next round)
  - [ ] temporary buff/debuff (1 round)

## D. Simulation Engine (Server)
### Determinism
- [ ] Match/round seeded PRNG utility (no `Math.random()` in sim path)
- [ ] "Replay" event timeline output format locked

### Core sim v0
- [ ] 2D grid representation (7x4 per side)
- [ ] Unit instances with:
  - [ ] stats: hp/atk/def/as/range/ms
  - [ ] tags: faction/class
  - [ ] target selection rules
  - [ ] movement rules (simple BFS or greedy step)
  - [ ] basic attack + cooldown
- [ ] Combat resolves to win/lose + damage to player HP

### Content gates
- [ ] 12 officers implemented (MVP roster)
- [ ] 8 synergies implemented (threshold 2 levels each)
- [ ] 20 items implemented (simple, readable effects)

## E. Web UI (MVP)
- [ ] "Play" landing: show current match or create match
- [ ] Match screen:
  - [ ] Board (drag/drop)
  - [ ] Bench
  - [ ] Shop (buy/reroll/lock)
  - [ ] Synergy panel
  - [ ] Round timer + phase indicator
- [ ] Story event overlay (2-3 choices, big numeric effect labels)
- [ ] Fight viewer:
  - [ ] minimal 2D rendering (boxes + icons ok)
  - [ ] damage/heal/cc indicators (simple)
- [ ] Post-round summary:
  - [ ] key factors (synergy active, item spikes)
  - [ ] gold/xp/hp deltas

## F. Bots (Dev + Early Content)
- [ ] Bot: basic prep logic
  - [ ] buy best value
  - [ ] simple positioning templates by role
- [ ] Bot difficulty scaling by round

## G. Balance + Telemetry (Minimum)
- [ ] Server-side metrics:
  - [ ] match length
  - [ ] round count
  - [ ] reroll usage
  - [ ] pick rates (officer/synergy/item)
  - [ ] win rates (officer/synergy)
- [ ] Balance scripts (offline sim) (later)

## H. Migration & Compatibility
- [ ] Keep existing MUD/chronicle features running (separate mode)
- [ ] Separate endpoints/DB tables to avoid regressions
- [ ] Remove/disable "auto_day as optimal" in auto-battler mode

## I. Execution Order (Recommended)
1. [ ] DB schema + ensure on startup
2. [ ] `match/create` + `match/state`
3. [ ] Prep actions: shop + board persistence
4. [ ] Round state machine (prep->fight->result)
5. [ ] Combat sim v0 + replay output
6. [ ] Story event overlay + effect interpreter
7. [ ] MVP content (12/8/20)
8. [ ] Balance + telemetry
