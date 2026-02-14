function clamp(n, lo, hi) {
  const x = Number(n);
  if (!Number.isFinite(x)) return lo;
  return Math.max(lo, Math.min(hi, x));
}

function asInt(v, d = 0) {
  const x = Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(x) ? x : d;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(text) {
  const s = String(text || '');
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export const PROTO_ROSTER_4X3 = [
  {
    unitId: 'xuchu',
    name: '허저',
    role: 'juggernaut',
    tags: ['wei', 'juggernaut'],
    hp: 1150,
    atk: 78,
    def: 18,
    aspd: 0.75,
    range: 1
  },
  {
    unitId: 'zhangliao',
    name: '장료',
    role: 'diver',
    tags: ['wei', 'diver'],
    hp: 820,
    atk: 86,
    def: 10,
    aspd: 1.15,
    range: 1
  },
  {
    unitId: 'xunyu',
    name: '순욱',
    role: 'strategist',
    tags: ['wei', 'strategist'],
    hp: 620,
    atk: 92,
    def: 6,
    aspd: 0.85,
    range: 3
  },
  {
    unitId: 'dianwei',
    name: '전위',
    role: 'tank',
    tags: ['wei', 'tank'],
    hp: 1280,
    atk: 62,
    def: 24,
    aspd: 0.65,
    range: 1
  }
];

function rosterById(unitId) {
  const id = String(unitId || '').trim();
  return PROTO_ROSTER_4X3.find((u) => u.unitId === id) || null;
}

function manhattan(a, b) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

function backstab(attacker, target) {
  // "Behind" is approximated as being deeper into enemy territory than the target.
  if (attacker.seat === 1) return attacker.y > target.y;
  return attacker.y < target.y;
}

function stepToward(u, t, W, H) {
  const dx = t.x - u.x;
  const dy = t.y - u.y;
  const candidates = [];
  if (Math.abs(dx) >= Math.abs(dy)) {
    if (dx > 0) candidates.push({ x: u.x + 1, y: u.y });
    if (dx < 0) candidates.push({ x: u.x - 1, y: u.y });
    if (dy > 0) candidates.push({ x: u.x, y: u.y + 1 });
    if (dy < 0) candidates.push({ x: u.x, y: u.y - 1 });
  } else {
    if (dy > 0) candidates.push({ x: u.x, y: u.y + 1 });
    if (dy < 0) candidates.push({ x: u.x, y: u.y - 1 });
    if (dx > 0) candidates.push({ x: u.x + 1, y: u.y });
    if (dx < 0) candidates.push({ x: u.x - 1, y: u.y });
  }
  candidates.push({ x: u.x, y: u.y });
  for (const c of candidates) {
    if (c.x < 0 || c.x >= W) continue;
    if (c.y < 0 || c.y >= H) continue;
    return c; // no collision for prototype
  }
  return { x: u.x, y: u.y };
}

function chooseTarget(u, units) {
  const enemies = units.filter((e) => e.hp > 0 && e.seat !== u.seat);
  if (!enemies.length) return null;
  // Diver prefers strategist first.
  enemies.sort((a, b) => {
    const pa =
      (u.role === 'diver' ? (a.role === 'strategist' ? -100 : 0) : 0) + manhattan(u, a) * 2 + a.hp / 50;
    const pb =
      (u.role === 'diver' ? (b.role === 'strategist' ? -100 : 0) : 0) + manhattan(u, b) * 2 + b.hp / 50;
    if (pa !== pb) return pa - pb;
    return a.id < b.id ? -1 : 1;
  });
  return enemies[0];
}

export function simulateProtoBattle4x3({ seed = '', p1Units = [], p2Units = [] }) {
  // Optional seat modifiers: { seat1: { hpPct, atkPct, defPct }, seat2: {...} }
  // Values are numbers like 0.15 for +15%, -0.3 for -30%.
  // Kept minimal for Phase1 "choice -> immediate effect" validation.
  // eslint-disable-next-line no-use-before-define
  const seatMods = arguments[0]?.seatMods && typeof arguments[0].seatMods === 'object' ? arguments[0].seatMods : {};
  // Global battlefield is 4x6 (p1 y=0..2, p2 y=3..5).
  const W = 4;
  const H = 6;
  const rand = mulberry32(hashSeed(`proto4x3:${seed}`));
  const tickMs = 100;
  const maxTicks = 550; // 55s

  const timeline = [];
  const initial = [];
  const stats = new Map(); // id -> { dmg, kills, skills }
  const units = [];

  function pushEvt(t, evt) {
    timeline.push({ t, ...evt });
  }
  function st(id) {
    if (!stats.has(id)) stats.set(id, { dmg: 0, kills: 0, skills: {} });
    return stats.get(id);
  }

  function addUnit(seat, idx, u) {
    const base = rosterById(u.unitId);
    if (!base) return;
    const mod = seat === 1 ? seatMods.seat1 : seatMods.seat2;
    const hpPct = clamp(mod?.hpPct ?? 0, -0.8, 2.0);
    const atkPct = clamp(mod?.atkPct ?? 0, -0.8, 2.0);
    const defPct = clamp(mod?.defPct ?? 0, -0.8, 2.0);
    const lx = clamp(asInt(u.x, 0), 0, 3);
    const ly = clamp(asInt(u.y, 0), 0, 2);
    const gx = lx;
    const gy = seat === 1 ? ly : 3 + ly;
    const id = `${seat}_${base.unitId}_${idx}`;
    const unit = {
      id,
      seat,
      unitId: base.unitId,
      name: base.name,
      role: base.role,
      tags: base.tags,
      x: gx,
      y: gy,
      hp: Math.max(1, Math.floor(base.hp * (1 + hpPct))),
      hpMax: Math.max(1, Math.floor(base.hp * (1 + hpPct))),
      atk: Math.max(1, Math.floor(base.atk * (1 + atkPct))),
      def: Math.max(0, Math.floor(base.def * (1 + defPct))),
      aspd: base.aspd,
      range: base.range,
      cdAtk: 0,
      cdUlt: base.unitId === 'xunyu' ? 10.0 : 8.0,
      invulnMs: 0,
      slowMs: 0,
      burn: null, // { msLeft, tickMsLeft }
      // Dian Wei: defense share aura is applied on damage calc time (dynamic).
      // Xun Yu: trap uses global state below.
      // Zhang Liao: crit ms buff
      msBuffMs: 0
    };
    units.push(unit);
    initial.push({ id: unit.id, seat: unit.seat, unitId: unit.unitId, name: unit.name, role: unit.role, x: unit.x, y: unit.y, hpMax: unit.hpMax });
  }

  (Array.isArray(p1Units) ? p1Units : []).slice(0, 4).forEach((u, idx) => addUnit(1, idx, u));
  (Array.isArray(p2Units) ? p2Units : []).slice(0, 4).forEach((u, idx) => addUnit(2, idx, u));

  // Xun Yu trap: one trap per seat at start, placed on the center line on enemy-front column-weighted tile.
  const traps = []; // { seatOwner, x,y, armed, srcId }
  for (const u of units) {
    if (u.unitId !== 'xunyu') continue;
    const x = clamp(Math.floor(rand() * W), 0, W - 1);
    const y = u.seat === 1 ? 3 : 2; // center line (enemy-front tile)
    traps.push({ seatOwner: u.seat, srcId: u.id, x, y, armed: true });
    pushEvt(0, { type: 'trap_set', src: u.id, seat: u.seat, at: { x, y } });
  }

  function teamAlive(seat) {
    return units.some((u) => u.hp > 0 && u.seat === seat);
  }

  function applyBurn(t, u) {
    if (!u.burn || u.hp <= 0) return;
    u.burn.msLeft = Math.max(0, u.burn.msLeft - tickMs);
    u.burn.tickMsLeft = Math.max(0, u.burn.tickMsLeft - tickMs);
    if (u.burn.tickMsLeft > 0) return;
    u.burn.tickMsLeft = 1000;
    const src = units.find((x) => x.id === u.burn.srcId) || null;
    const atk = src ? src.atk : 80;
    const raw = Math.floor(atk * 0.5);
    const dmg = Math.max(1, raw - Math.floor(u.def));
    u.hp = Math.max(0, u.hp - dmg);
    st(u.burn.srcId).dmg += dmg;
    st(u.burn.srcId).skills.fire = (st(u.burn.srcId).skills.fire || 0) + dmg;
    pushEvt(t, { type: 'dot', kind: 'fire', src: u.burn.srcId, dst: u.id, amount: dmg, dstHp: u.hp });
    if (u.hp <= 0) {
      pushEvt(t, { type: 'death', src: u.id, seat: u.seat, by: u.burn.srcId, via: 'fire' });
      st(u.burn.srcId).kills += 1;
    }
  }

  function effectiveDef(target) {
    let bonus = 0;
    // Dian Wei defense share: any allied Dian Wei grants 20% of its def to allies within 1 tile.
    for (const g of units) {
      if (g.hp <= 0) continue;
      if (g.seat !== target.seat) continue;
      if (g.unitId !== 'dianwei') continue;
      if (manhattan(g, target) <= 1) bonus += Math.floor(g.def * 0.2);
    }
    return target.def + bonus;
  }

  function maybeInterceptDamage(t, attacker, target, amount) {
    // Dian Wei intercept: if any allied Dian Wei within 1 tile of target, 30% chance to take the hit.
    const guards = units.filter((g) => g.hp > 0 && g.seat === target.seat && g.unitId === 'dianwei' && manhattan(g, target) <= 1);
    if (!guards.length) return { target, amount, intercepted: false };
    if (rand() >= 0.3) return { target, amount, intercepted: false };
    const g = guards.sort((a, b) => a.hp - b.hp)[0];
    pushEvt(t, { type: 'guard', src: g.id, dst: target.id, seat: g.seat });
    return { target: g, amount, intercepted: true };
  }

  function damageReductionFactor(target, incoming, attacker) {
    // Xu Chu passive.
    if (target.unitId !== 'xuchu') return 1.0;
    const low = target.hp / Math.max(1, target.hpMax) <= 0.3;
    if (low) return 0.5;
    if (rand() < 0.1) return 0.5;
    return 1.0;
  }

  function tryTriggerTrap(t, mover) {
    for (const tr of traps) {
      if (!tr.armed) continue;
      if (tr.seatOwner === mover.seat) continue;
      if (tr.x !== mover.x || tr.y !== mover.y) continue;
      tr.armed = false;
      const src = units.find((x) => x.id === tr.srcId) || null;
      const atk = src ? src.atk : 80;
      const raw = Math.floor(atk * 0.8);
      const dmg = Math.max(1, raw - Math.floor(effectiveDef(mover)));
      mover.hp = Math.max(0, mover.hp - dmg);
      st(tr.srcId).dmg += dmg;
      st(tr.srcId).skills.trap = (st(tr.srcId).skills.trap || 0) + dmg;
      pushEvt(t, { type: 'trap_hit', src: tr.srcId, dst: mover.id, amount: dmg, dstHp: mover.hp });
      if (mover.hp <= 0) {
        pushEvt(t, { type: 'death', src: mover.id, seat: mover.seat, by: tr.srcId, via: 'trap' });
        st(tr.srcId).kills += 1;
      }
    }
  }

  function castUlt(t, u) {
    if (u.cdUlt > 0) return false;
    const enemies = units.filter((e) => e.hp > 0 && e.seat !== u.seat);
    if (!enemies.length) return false;

    if (u.unitId === 'xuchu') {
      // Charge: dash up to 2 steps toward nearest enemy, deal 200% atk and knock back 1 tile.
      const target = chooseTarget(u, units);
      if (!target) return false;
      const pre = { x: u.x, y: u.y };
      let steps = 0;
      while (steps < 2 && manhattan(u, target) > 1) {
        const next = stepToward(u, target, W, H);
        if (next.x === u.x && next.y === u.y) break;
        u.x = next.x;
        u.y = next.y;
        steps += 1;
      }
      pushEvt(t, { type: 'skill', skill: 'charge', src: u.id, seat: u.seat, from: pre, to: { x: u.x, y: u.y } });
      const raw = Math.floor(u.atk * 2.0);
      const dmg = Math.max(1, raw - Math.floor(effectiveDef(target)));
      target.hp = Math.max(0, target.hp - dmg);
      st(u.id).dmg += dmg;
      st(u.id).skills.charge = (st(u.id).skills.charge || 0) + dmg;
      pushEvt(t, { type: 'hit', kind: 'skill', skill: 'charge', src: u.id, dst: target.id, amount: dmg, dstHp: target.hp });
      // Knockback
      const dir = u.seat === 1 ? 1 : -1;
      const kb = { x: target.x, y: clamp(target.y + dir, 0, H - 1) };
      target.y = kb.y;
      pushEvt(t, { type: 'knockback', src: u.id, dst: target.id, to: kb });
      if (target.hp <= 0) {
        pushEvt(t, { type: 'death', src: target.id, seat: target.seat, by: u.id, via: 'charge' });
        st(u.id).kills += 1;
      }
      u.cdUlt = 8.0;
      return true;
    }

    if (u.unitId === 'zhangliao') {
      // Execute: teleport to lowest hp enemy and deal 250% atk; on kill, halve cooldown.
      enemies.sort((a, b) => a.hp - b.hp || manhattan(u, a) - manhattan(u, b));
      const target = enemies[0];
      const pre = { x: u.x, y: u.y };
      u.x = target.x;
      u.y = u.seat === 1 ? Math.max(0, target.y - 1) : Math.min(H - 1, target.y + 1);
      pushEvt(t, { type: 'skill', skill: 'execute', src: u.id, seat: u.seat, from: pre, to: { x: u.x, y: u.y }, target: target.id });
      const raw = Math.floor(u.atk * 2.5);
      const dmg = Math.max(1, raw - Math.floor(effectiveDef(target)));
      target.hp = Math.max(0, target.hp - dmg);
      st(u.id).dmg += dmg;
      st(u.id).skills.execute = (st(u.id).skills.execute || 0) + dmg;
      pushEvt(t, { type: 'hit', kind: 'skill', skill: 'execute', src: u.id, dst: target.id, amount: dmg, dstHp: target.hp });
      let cd = 8.0;
      if (target.hp <= 0) {
        pushEvt(t, { type: 'death', src: target.id, seat: target.seat, by: u.id, via: 'execute' });
        st(u.id).kills += 1;
        cd = 4.0;
      }
      u.cdUlt = cd;
      return true;
    }

    if (u.unitId === 'xunyu') {
      // Fire field: pick 2x2 with most enemies.
      let best = null;
      for (let x = 0; x <= W - 2; x += 1) {
        for (let y = 0; y <= H - 2; y += 1) {
          const count = enemies.filter((e) => e.x >= x && e.x <= x + 1 && e.y >= y && e.y <= y + 1).length;
          if (!best || count > best.count) best = { x, y, count };
        }
      }
      if (!best || best.count <= 0) return false;
      pushEvt(t, { type: 'skill', skill: 'fire', src: u.id, seat: u.seat, area: { x: best.x, y: best.y, w: 2, h: 2 } });
      for (const e of enemies) {
        if (e.x < best.x || e.x > best.x + 1 || e.y < best.y || e.y > best.y + 1) continue;
        e.slowMs = Math.max(e.slowMs, 3000);
        e.burn = { srcId: u.id, msLeft: 3000, tickMsLeft: 0 };
      }
      u.cdUlt = 10.0;
      return true;
    }

    if (u.unitId === 'dianwei') {
      // Invuln + brief stun around.
      pushEvt(t, { type: 'skill', skill: 'stand', src: u.id, seat: u.seat });
      u.invulnMs = Math.max(u.invulnMs, 5000);
      const around = enemies.filter((e) => e.hp > 0 && manhattan(u, e) <= 1);
      for (const e of around) {
        // Stun is modeled as slow to 0 for 1s (skip movement/attacks by increasing cds).
        e.slowMs = Math.max(e.slowMs, 1000);
        e.cdAtk = Math.max(e.cdAtk, 1.0);
      }
      u.cdUlt = 8.0;
      return true;
    }
    return false;
  }

  // Main sim
  for (let tick = 0; tick < maxTicks; tick += 1) {
    const t = tick * tickMs;
    if (!teamAlive(1) || !teamAlive(2)) break;

    // Status ticks
    for (const u of units) {
      if (u.hp <= 0) continue;
      u.invulnMs = Math.max(0, u.invulnMs - tickMs);
      u.slowMs = Math.max(0, u.slowMs - tickMs);
      u.msBuffMs = Math.max(0, u.msBuffMs - tickMs);
      applyBurn(t, u);
      if (u.burn && u.burn.msLeft <= 0) u.burn = null;
    }

    const order = units
      .filter((u) => u.hp > 0)
      .slice()
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    for (let i = order.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rand() * (i + 1));
      const tmp = order[i];
      order[i] = order[j];
      order[j] = tmp;
    }

    for (const u of order) {
      if (u.hp <= 0) continue;
      const target = chooseTarget(u, units);
      if (!target) continue;

      u.cdAtk = Math.max(0, u.cdAtk - tickMs / 1000);
      u.cdUlt = Math.max(0, u.cdUlt - tickMs / 1000);

      // If slowed, treat as reduced action rate.
      if (u.slowMs > 0) {
        u.cdAtk = Math.max(u.cdAtk, 0.35);
      }

      // Try ultimate first (gives identity).
      if (castUlt(t, u)) continue;

      const dist = manhattan(u, target);
      if (dist > u.range) {
        // Move: slowed units move less frequently.
        const slowFactor = u.slowMs > 0 ? 0.35 : 1.0;
        if (rand() < slowFactor) {
          const next = stepToward(u, target, W, H);
          if (next.x !== u.x || next.y !== u.y) {
            const from = { x: u.x, y: u.y };
            u.x = next.x;
            u.y = next.y;
            pushEvt(t, { type: 'move', src: u.id, seat: u.seat, from, to: { x: u.x, y: u.y } });
            tryTriggerTrap(t, u);
          }
        }
        continue;
      }

      if (u.cdAtk > 0) continue;

      // Basic attack
      const baseRaw = Math.floor(u.atk + rand() * 8);
      let critChance = 0.05;
      if (u.unitId === 'zhangliao' && backstab(u, target)) critChance += 0.30;
      const isCrit = rand() < critChance;
      if (isCrit && u.unitId === 'zhangliao') u.msBuffMs = Math.max(u.msBuffMs, 5000);
      const raw = isCrit ? Math.floor(baseRaw * 2.0) : baseRaw;

      const { target: tgt2, amount: raw2, intercepted } = maybeInterceptDamage(t, u, target, raw);
      const def = effectiveDef(tgt2);
      const factor = damageReductionFactor(tgt2, raw2, u);
      let dmg = Math.max(1, Math.floor((raw2 - Math.floor(def)) * factor));
      if (tgt2.invulnMs > 0) dmg = 0;

      if (dmg > 0) {
        tgt2.hp = Math.max(0, tgt2.hp - dmg);
        st(u.id).dmg += dmg;
        pushEvt(t, {
          type: 'attack',
          src: u.id,
          dst: tgt2.id,
          seat: u.seat,
          amount: dmg,
          dstHp: tgt2.hp,
          crit: isCrit ? true : undefined,
          guard: intercepted ? true : undefined
        });
        if (tgt2.hp <= 0) {
          pushEvt(t, { type: 'death', src: tgt2.id, seat: tgt2.seat, by: u.id, via: isCrit ? 'crit' : 'attack' });
          st(u.id).kills += 1;
        }
      } else {
        pushEvt(t, { type: 'attack', src: u.id, dst: tgt2.id, seat: u.seat, amount: 0, dstHp: tgt2.hp, blocked: true });
      }

      u.cdAtk = 1 / Math.max(0.35, u.aspd);
    }
  }

  const alive1 = units.filter((u) => u.hp > 0 && u.seat === 1);
  const alive2 = units.filter((u) => u.hp > 0 && u.seat === 2);
  let winnerSeat = null;
  if (alive1.length && !alive2.length) winnerSeat = 1;
  else if (alive2.length && !alive1.length) winnerSeat = 2;
  else {
    const s1 = alive1.reduce((acc, u) => acc + u.hp, 0);
    const s2 = alive2.reduce((acc, u) => acc + u.hp, 0);
    winnerSeat = s1 === s2 ? (rand() < 0.5 ? 1 : 2) : s1 > s2 ? 1 : 2;
  }

  // Analysis
  const deaths = timeline.filter((e) => e.type === 'death');
  const firstDeath = deaths.length ? deaths.slice().sort((a, b) => a.t - b.t)[0] : null;
  let mvpId = null;
  let mvpScore = -1;
  for (const u of units) {
    const s = st(u.id);
    const score = s.dmg + s.kills * 200;
    if (score > mvpScore) {
      mvpScore = score;
      mvpId = u.id;
    }
  }
  const skillHits = timeline.filter((e) => e.type === 'hit' && e.kind === 'skill');
  const decisive = skillHits.length ? skillHits.slice().sort((a, b) => b.amount - a.amount)[0] : null;

  let reason = '';
  const reasons = [];
  if (decisive?.skill === 'execute') {
    reason = '장료의 처형 돌입으로 핵심 유닛이 빠르게 제거됨';
    reasons.push('결정 스킬: 청룡연월(처형)');
  } else if (decisive?.skill === 'fire') {
    reason = '화계 도트/슬로우로 진형이 무너지고 후열이 버티지 못함';
    reasons.push('결정 스킬: 화계(2x2 장판)');
  } else if (decisive?.skill === 'charge') {
    reason = '허저의 돌진으로 전열이 흔들리며 전투가 빠르게 기울어짐';
    reasons.push('결정 스킬: 돌진격');
  } else if (decisive?.skill === 'stand') {
    reason = '전위가 결사저항으로 시간을 벌어 아군 딜이 누적됨';
    reasons.push('결정 스킬: 결사저항');
  }
  if (firstDeath) {
    const fdUnit = units.find((u) => u.id === firstDeath.src) || null;
    if (fdUnit && fdUnit.role === 'strategist') reasons.push('첫 전사: 책사(후열 붕괴)');
    else reasons.push('첫 전사 발생으로 수적 열세가 조기 발생');
  }
  if (!reason) reason = winnerSeat === 1 ? '전열 유지 + 후열 보호가 더 잘 됨' : '후열이 먼저 무너져 딜이 끊김';

  const analysis = {
    winnerSeat,
    mvpId,
    firstDeathId: firstDeath ? firstDeath.src : null,
    decisiveSkill: decisive ? decisive.skill : null,
    reason,
    reasons: reasons.slice(0, 2),
    seatMods
  };

  const summary = {
    winnerSeat,
    survivors: {
      seat1: alive1.map((u) => ({ id: u.id, unitId: u.unitId, hp: u.hp })),
      seat2: alive2.map((u) => ({ id: u.id, unitId: u.unitId, hp: u.hp }))
    }
  };

  return { initial, timeline, summary, analysis };
}
