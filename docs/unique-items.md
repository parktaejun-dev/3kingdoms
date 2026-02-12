# Unique Items: Design + Drop/Quest Flow (Phase 1)

## Goals
- Make **shop + items** a core loop (gold sinks, clear upgrades).
- Keep the game **officer-centric** (no "lord bestows / loyalty pledge" fantasy).
- Keep systems **easy to understand**:
  - "Get a rumor" -> "Go to a place" -> "Do 1-2 actions" -> "Secure the item".
- Keep all outcomes **server-ruled** and deterministic where possible.
- Ensure unique items are truly unique across the whole season/server.

## Item Types (Phase 1)
- `consumable`: use-once, usually buffs the next action (example: `rest_bonus_once`).
- `book`: applies immediately on purchase, not stored as inventory stack.
- `equipment`: persists, can be equipped in a slot:
  - `slot=weapon`: affects battle attack (`battle_attack_flat`).
  - `slot=mount`: reduces travel AP (`travel_discount`).

## Uniqueness Rule
- Any item with `items.unique_key` is **globally unique**.
- Enforcement lives in `unique_ownership(unique_key -> owner_officer_id)`.
- If the unique is already owned by someone else, it is **sold out**:
  - shop won't sell it (Phase 1: uniques are not shop items)
  - quests cannot grant it

## Acquisition Philosophy
Unique items are never random "loot drops" in Phase 1.
- Non-unique equipment (like `weapon_basic`) can drop rarely through daily episodes.
 - Unique equipment is acquired through a short quest flow with multiple branches:
  1. Rumor/Unlock
  2. Travel to a city
  3. Investigate
  4. Secure via one of:
     - Gold deal (`deal`)
     - Duel / special encounter (`duel`) (once per in-game day)
     - Relationship favor gate (`favor`) (requires high affinity, consumes affinity)

This keeps uniques meaningful, avoids farming, and supports easy UX.

## Phase 1 Unique Questlines (Implemented)

### 1) `red_hare` -> `mount_red_hare` (unique_key=`red_hare`)
- Unlock:
  - `FAME >= 10`
  - `arc190_stage >= 1`
  - item not taken by someone else
- Flow (3 steps):
  1. `travel luo_yang`
  2. `search` in 낙양
  3. Choose one:
     - `deal red_hare` (Gold -2500)
     - `duel red_hare` (AP cost, once/day)
     - `favor red_hare` (requires affinity >= 60 in the city, consumes affinity)

### 2) `qinggang` -> `weapon_qinggang` (unique_key=`qinggang`)
- Unlock:
  - `FAME >= 12`
  - `MERIT >= 500`
  - `arc190_stage >= 2`
  - item not taken by someone else
- Flow (3 steps):
  1. `travel wan`
  2. `socialize` or `search` in 완
  3. Choose one:
     - `deal qinggang` (Gold -2200)
     - `duel qinggang` (AP cost, once/day)
     - `favor qinggang` (requires affinity >= 60 in the city, consumes affinity)

## UI/UX
- `story` shows:
  - unique quest tasks (only active/completed to keep UI clean)
  - quick buttons:
    - `travel <city>`
    - `search`
    - `deal <questKey>`
    - `duel <questKey>`
    - `favor <questKey>` (only when affinity gate is satisfied)
- Inventory overlay:
  - equipment tab shows `EQUIP`
  - slot cards show `UNEQUIP`
  - `CHRONICLE` opens a unique-item lore card view

## Balancing Notes
- Costs are intentionally large to create a long-term gold sink.
- `weapon_basic` remains a small, accessible upgrade.
- Uniques grant bigger utility but should not make early content trivial.

## Next (Phase 2 Ideas)
- Multiple ways to secure uniques (not only gold):
  - duel encounter / special battle instance
  - relationship gate (need affinity with a contact)
  - multi-city chain (spy -> travel -> deal)
- Seasonal rotation of unique availability (keep meta fresh)
- Unique item "lore cards" + biography ending integration
