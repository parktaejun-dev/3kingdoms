import express from 'express';
import cors from 'cors';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import Redis from 'ioredis';
import { Queue } from 'bullmq';
import client from 'prom-client';
import { pool, withTx } from './db.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  cultivateYield,
  trainYield,
  recruitYield,
  consumeAP,
  updateMerit,
  nextRankByMerit,
  travelCost,
  searchFindChance,
  employChance,
  spyAccuracy,
  noisyValue
} from './gameEngine.js';
import {
  seedRegions,
  seedFactions,
  seedCities,
  seedEdges,
  seedMapConnections,
  seedOfficers,
  seedItems,
  seedLoreEntries,
  seedStoryArcs,
  seedStoryBeats
} from './seeds/world190.js';
import {
  BATTLE_SIZE,
  calcEnemyDamage,
  calcPlayerDamage,
  enemyStep,
  generateBattleMap,
  isAdjacent,
  renderBattleMap,
  tryMove
} from './battleEngine.js';
import { PROTO_ROSTER_4X3, simulateProtoBattle4x3 } from './protoAutobattle4x3.js';

const app = express();
// Avoid 304/empty-body responses for JSON API fetch() calls (ETag caching breaks r.json()).
app.set('etag', false);
app.use(cors());
app.use(express.json());

// Metrics (minimal observability)
const register = new client.Registry();
client.collectDefaultMetrics({ register });
const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'path', 'status']
});
register.registerMetric(httpRequestsTotal);
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    // Keep cardinality small: bucket common API paths; fallback to original path.
    const p = req.path.startsWith('/api/') ? req.path.replace(/\/[0-9a-f-]{36}(?=\/|$)/gi, '/:id') : req.path;
    httpRequestsTotal.inc({ method: req.method, path: p, status: String(res.statusCode) });
    if (process.env.LOG_HTTP === '1') {
      const ms = Date.now() - start;
      console.log(`[http] ${req.method} ${req.path} ${res.statusCode} ${ms}ms`);
    }
  });
  next();
});

app.use((req, res, next) => {
  if (req.url.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store');
  }
  next();
});
app.use((req, _res, next) => {
  if (
    !req.url.startsWith('/api') &&
    (
      req.url.startsWith('/player/') ||
      req.url.startsWith('/game/') ||
      req.url.startsWith('/battle/') ||
      req.url.startsWith('/map/') ||
      req.url.startsWith('/city/')
    )
  ) {
    req.url = `/api${req.url}`;
  }
  next();
});

const server = createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
const biographyQueue = new Queue(process.env.BIOGRAPHY_QUEUE || 'biography', {
  connection: redis
});
const portraitQueue = new Queue(process.env.PORTRAIT_QUEUE || 'portraits', { connection: redis });
const aiUrl = process.env.AI_URL || 'http://ai:8000';
const portraitsDir = process.env.PORTRAITS_DIR || '/data/portraits';
const sdModelKey = process.env.SD_MODEL_KEY || 'sd_turbo';

// "LoL-like" build layer: skills are equippable passives (Q/W/E/R slots).
// They are deterministic modifiers; AI never changes outcomes.
const SKILL_DEFS = [
  {
    id: 'dash',
    name: 'Dash',
    unlock_level: 2,
    desc: '이동(travel) AP -15% (장비/명마 할인과 합산, 최소치 적용).',
    effects: { travel_discount_pct: 0.15 }
  },
  {
    id: 'silver_tongue',
    name: 'Silver Tongue',
    unlock_level: 2,
    desc: '교류(visit/socialize/gift/banquet) 친밀도 획득 +25%.',
    effects: { relationship_pct: 0.25 }
  },
  {
    id: 'scavenger',
    name: 'Scavenger',
    unlock_level: 3,
    desc: '탐색(search) 금 보상 +25%.',
    effects: { search_gold_pct: 0.25 }
  },
  {
    id: 'duelist',
    name: 'Duelist',
    unlock_level: 3,
    desc: '전투 공격 +2 (weapon 보정과 별도 합산).',
    effects: { battle_attack_flat: 2 }
  },
  {
    id: 'tactician',
    name: 'Tactician',
    unlock_level: 4,
    desc: '정찰(spy) 정확도 보정 +10.',
    effects: { spy_accuracy_flat: 10 }
  },
  {
    id: 'chronicler',
    name: 'Chronicler',
    unlock_level: 4,
    desc: '명성(fame) 획득 +1 (행동당).',
    effects: { fame_flat: 1 }
  }
];

function xpNeededForLevel(nextLevel) {
  // Level curve: 1->2:100, then +80 each level (simple & readable).
  const n = Math.max(2, Number(nextLevel || 2));
  return 100 + (n - 2) * 80;
}

function sha256Hex(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

async function aiEpisodeDraft({ actor, location, objective, options }) {
  // LLM is only allowed to provide flavor/hook/labels; actual options are deterministic.
  const safeOptions = Array.isArray(options) ? options.slice(0, 4) : [];
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 1500);
  try {
    const resp = await fetch(`${aiUrl}/narrate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        actor,
        action: 'episode_draft',
        result: `다음 중 하나를 선택: ${safeOptions.map((o) => `${o.verb}${o.label ? `(${o.label})` : ''}`).join(', ')}`,
        mood: 'calm',
        actor_role: 'officer',
        target: null,
        location,
        objective,
        lore: safeOptions
          .flatMap((o) => (Array.isArray(o.lore) ? o.lore : []))
          .filter(Boolean)
          .slice(0, 6),
        forbid_phrases: [
          '하사',
          '내리니',
          '충성을 맹세',
          '주군',
          '군주',
          '신하',
          '책봉',
          '어명',
          '황제'
        ]
      }),
      signal: controller.signal
    });
    const data = await resp.json().catch(() => null);
    const text = String(data?.text || '').trim();
    // Use narrate output as hook if present; keep it short.
    return text ? text.slice(0, 140) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function fetchLoreByTags(client, { tags, limit = 6 }) {
  const uniq = Array.from(new Set((tags || []).map((x) => String(x || '').trim()).filter(Boolean))).slice(0, 24);
  if (!uniq.length) return [];
  try {
    const r = await client.query(
      `SELECT id, title, body, source
       FROM lore_entries
       WHERE tags && $1::text[]
       ORDER BY updated_at DESC
       LIMIT $2`,
      [uniq, Math.max(1, Math.min(12, Number(limit || 6)))]
    );
    return (r.rows || []).map((x) => ({ title: x.title, body: x.body, source: x.source })).slice(0, limit);
  } catch {
    return [];
  }
}

async function buildEpisodeOptionsWithLore(client, { row, objective, baseOptions }) {
  const tagsBase = [row.officer_id, row.officer_name, row.city_id, row.city_name, row.officer_force_id, row.city_owner_force_id, objective]
    .map((x) => String(x || '').trim())
    .filter(Boolean);
  const coreLore = await fetchLoreByTags(client, { tags: tagsBase, limit: 4 });
  return (baseOptions || []).map((o) => {
    const tags = tagsBase.concat([o.verb, o.label, o.cmd]).map((x) => String(x || '').trim()).filter(Boolean);
    const lore = coreLore.slice(0, 3);
    return { ...o, lore };
  });
}

async function maybeGenerateSmallEpisode(client, { row, objective }) {
  // Small episodes: dynamic hook + fixed-option branching (saved in story_states.flags).
  // Create at most 1 episode per (game) day per officer.
  const st = await getStoryState(client, row.officer_id);
  const flags0 = st.flags || {};
  const pending = flags0.pending_episode && typeof flags0.pending_episode === 'object' ? flags0.pending_episode : null;

  const gt = await client.query(`SELECT year, month, day FROM game_time WHERE id = 1`);
  const g = gt.rows[0] || { year: 0, month: 0, day: 0 };
  const dayKey = `${g.year}.${g.month}.${g.day}`;
  const canCreate = !pending || String(pending.day_key || '') !== dayKey;
  if (!canCreate) return { created: false, episode: pending, flags: flags0 };

  const optionPool = [];
  const pushOpt = (verb, label, reward, weight = 1, cmd = null) =>
    optionPool.push({ id: `${verb}:${label}`.slice(0, 60), verb, label, reward, weight, cmd });
  const gold = asInt(row.officer_gold, 0);
  const ap = asInt(row.ap, 0);
  const custody = String(row.officer_custody_status || 'free');
  const fame = asInt(row.fame, 0);
  const level = asInt(row.officer_level, 1);

  // If a scout contact is in "decision" stage, prioritize it as the day's episode.
  const scout = flags0.scout_offer && typeof flags0.scout_offer === 'object' ? flags0.scout_offer : null;
  if (custody === 'free' && scout && asInt(scout.stage, 0) === 2 && String(scout.to || '').trim()) {
    const to = String(scout.to).trim();
    const from = String(scout.from || row.officer_force_id || 'ronin').trim();
    const fname = String(scout.to_name || to);
    const baseOptions = [
      { id: `scout_join:${to}`.slice(0, 60), verb: 'scout_join', label: `${fname}로 넘어가기`, reward: { fame: 2 }, weight: 1, cmd: `scout_join ${to}` },
      { id: `scout_backout:${to}`.slice(0, 60), verb: 'scout_backout', label: '발을 빼기(위험 회피)', reward: { fame: 0 }, weight: 1, cmd: `scout_backout ${to}` },
      { id: `socialize:laylow`.slice(0, 60), verb: 'socialize', label: '아무 일 없던 척 섞이기', reward: { fame: 1 }, weight: 1, cmd: 'socialize' }
    ];
    const options = await buildEpisodeOptionsWithLore(client, { row, objective, baseOptions });
    const hook =
      (await aiEpisodeDraft({
        actor: row.officer_name,
        location: row.city_name,
        objective,
        options
      })) || `비밀 접선이 끝났다. 이제 ${fname}의 제의를 받아들일지, 발을 뺄지 결단해야 한다.`;

    const ep = {
      id: sha256Hex(`ep|${row.officer_id}|${dayKey}|scout_decide|${to}`).slice(0, 16),
      day_key: dayKey,
      title: '스카우트: 결단',
      hook,
      offer: { factionId: to, factionName: fname, from },
      options: options.map((o) => ({
        id: o.id,
        verb: o.verb,
        label: o.label,
        reward: o.reward,
        cmd: o.cmd || o.verb
      })),
      resolved: false
    };
    const nextFlags = { ...flags0, pending_episode: ep, arc_id: flags0.arc_id || '190_anti_dong_zhuo' };
    await client.query(`UPDATE story_states SET flags=$2::jsonb, updated_at=now() WHERE officer_id=$1`, [
      row.officer_id,
      JSON.stringify(nextFlags)
    ]);
    await client.query(
      `INSERT INTO biography_logs (officer_id, event_type, event_data)
       VALUES ($1, $2, $3)`,
      [row.officer_id, 'episode', { summary: ep.hook, episode: ep }]
    );
    return { created: true, episode: ep, flags: nextFlags };
  }

  // ── Scout offer episode (officer-centric faction drama) ─────────────────────
  // Deterministic chance per day: factions may approach the officer.
  // Not "lord play": it's a personal career/survival choice with risk.
  if (custody === 'free' && (fame >= 2 || level >= 2)) {
    const sr = seededRng(sha256Hex(`${row.officer_id}|${dayKey}|scout`).slice(0, 8));
    const roll = sr();
    const offerChance = row.officer_force_id === 'ronin' ? 0.28 : 0.16;
    if (roll < offerChance) {
      const cur = String(row.officer_force_id || '').trim() || 'ronin';
      const cand = await client
        .query(
          `SELECT id, name_kr
           FROM forces
           WHERE id NOT IN ('neutral','ronin')
             AND id <> $1
           ORDER BY id ASC`,
          [cur]
        )
        .catch(() => ({ rows: [] }));
      const rows = (cand.rows || []).filter((x) => x && x.id);
      if (rows.length) {
        const pick = rows[Math.floor(sr() * rows.length)] || rows[0];
        const fid = String(pick.id);
        const fname = String(pick.name_kr || pick.id);
        const baseOptions = [
          { id: `scout_accept:${fid}`.slice(0, 60), verb: 'scout_accept', label: `${fname} 제의 수락`, reward: { fame: 1 }, weight: 1, cmd: `scout_accept ${fid}` },
          { id: `scout_decline:${fid}`.slice(0, 60), verb: 'scout_decline', label: '거절/침묵으로 넘기기', reward: { fame: 0 }, weight: 1, cmd: `scout_decline ${fid}` },
          { id: `socialize:cover`.slice(0, 60), verb: 'socialize', label: '아무 일 없던 척 섞이기', reward: { fame: 1 }, weight: 1, cmd: 'socialize' }
        ];
        const options = await buildEpisodeOptionsWithLore(client, { row, objective, baseOptions });
        const hook =
          (await aiEpisodeDraft({
            actor: row.officer_name,
            location: row.city_name,
            objective,
            options
          })) || `${row.city_name}에서 누군가가 조용히 다가와 “${fname} 쪽으로 넘어오라”는 제의를 건넨다.`;

        const ep = {
          id: sha256Hex(`ep|${row.officer_id}|${dayKey}|scout|${fid}`).slice(0, 16),
          day_key: dayKey,
          title: '스카우트 제의',
          hook,
          offer: { factionId: fid, factionName: fname, from: cur },
          options: options.map((o) => ({
            id: o.id,
            verb: o.verb,
            label: o.label,
            reward: o.reward,
            cmd: o.cmd || o.verb
          })),
          resolved: false
        };
        const nextFlags = { ...flags0, pending_episode: ep, arc_id: flags0.arc_id || '190_anti_dong_zhuo' };
        await client.query(`UPDATE story_states SET flags=$2::jsonb, updated_at=now() WHERE officer_id=$1`, [
          row.officer_id,
          JSON.stringify(nextFlags)
        ]);
        await client.query(
          `INSERT INTO biography_logs (officer_id, event_type, event_data)
           VALUES ($1, $2, $3)`,
          [row.officer_id, 'episode', { summary: ep.hook, episode: ep }]
        );
        return { created: true, episode: ep, flags: nextFlags };
      }
    }
  }

  // Relationship-aware: pick a recommended target in the same city (highest affinity, fallback random).
  let recTarget = null;
  try {
    const topRel = await client.query(
      `SELECT o.id, o.name_kr, r.affinity_score
       FROM relationships r
       JOIN officers o ON o.id = r.target_officer_id
       WHERE r.source_officer_id=$1
         AND r.rel_type='Acquaintance'
         AND o.city_id=$2
       ORDER BY r.affinity_score DESC
       LIMIT 1`,
      [row.officer_id, row.city_id]
    );
    if (topRel.rows.length) recTarget = topRel.rows[0];
  } catch {
    recTarget = null;
  }
  if (!recTarget) {
    try {
      const any = await client.query(`SELECT id, name_kr FROM officers WHERE city_id=$1 AND id<>$2 ORDER BY random() LIMIT 1`, [
        row.city_id,
        row.officer_id
      ]);
      if (any.rows.length) recTarget = { ...any.rows[0], affinity_score: 0 };
    } catch {
      recTarget = null;
    }
  }

  const hasSocial = !!recTarget;
  const affinity = hasSocial ? asInt(recTarget.affinity_score, 0) : 0;
  const lowAp = ap < 20;
  const lowGold = gold < 120;

  // Build a context-aware pool (deterministic options; LLM only writes hook).
  if (ap >= 10) pushOpt('socialize', '사람들과 섞이기', { fame: 1 }, hasSocial ? 1.4 : 1.0, 'socialize');
  if (ap >= 10)
    pushOpt(
      'visit',
      hasSocial ? `${recTarget.name_kr} 찾아가기` : '누군가 찾아가기',
      { fame: 1 },
      hasSocial ? 1.6 + Math.min(0.6, affinity / 80) : 1.0,
      hasSocial ? `visit ${recTarget.name_kr}` : 'visit'
    );
  if (ap >= 10) pushOpt('patrol', '현장 다독이기', { fame: 1 }, lowAp ? 1.3 : 1.0, 'calm');
  if (ap >= 20) pushOpt('train', '몸을 단련하기', { fame: 1 }, lowAp ? 0.6 : 1.0, 'train');
  if (ap >= 20) pushOpt('search', '수상한 소문 캐기', { gold: 120, fame: 1 }, lowGold ? 1.8 : 1.1, 'search');
  if (ap >= 10 && gold >= 80)
    pushOpt(
      'gift',
      hasSocial ? `${recTarget.name_kr}에게 작은 선물` : '작은 선물로 인연 잇기',
      { fame: 1 },
      hasSocial ? 1.2 + Math.min(0.8, affinity / 60) : 0.8,
      hasSocial ? `gift ${recTarget.name_kr}` : 'gift'
    );
  if (ap >= 15 && gold >= 100) pushOpt('banquet', '짧은 연회로 분위기 풀기', { fame: 2 }, hasSocial ? 1.0 : 0.7, 'banquet');
  if (ap >= 10 && gold >= 50) pushOpt('recruit_rumor', '소문을 퍼뜨리기', { fame: 1 }, hasSocial ? 0.9 : 1.1, 'recruit_rumor');
  pushOpt('rest', '잠깐 숨 고르기', { fame: 0 }, lowAp ? 1.8 : 0.9, 'rest');

  // Pick 2-3 options deterministically by (officerId + dayKey) with weights.
  const rnd = seededRng(sha256Hex(`${row.officer_id}|${dayKey}|epick`).slice(0, 8));
  const baseOptions = pickWeightedUnique(optionPool, 3, rnd);
  if (baseOptions.length < 2) return { created: false, episode: null, flags: flags0 };

  const options = await buildEpisodeOptionsWithLore(client, { row, objective, baseOptions });
  const hook =
    (await aiEpisodeDraft({
      actor: row.officer_name,
      location: row.city_name,
      objective,
      options
    })) || '짧은 틈이 생겼다. 지금은 무엇을 할까?';

  const ep = {
    id: sha256Hex(`ep|${row.officer_id}|${dayKey}`).slice(0, 16),
    day_key: dayKey,
    title: '짧은 에피소드',
    hook,
    options: options.map((o) => ({
      id: o.id,
      verb: o.verb,
      label: o.label,
      reward: o.reward,
      cmd: o.cmd || o.verb
    })),
    resolved: false
  };
  const nextFlags = { ...flags0, pending_episode: ep, arc_id: flags0.arc_id || '190_anti_dong_zhuo' };
  await client.query(`UPDATE story_states SET flags=$2::jsonb, updated_at=now() WHERE officer_id=$1`, [
    row.officer_id,
    JSON.stringify(nextFlags)
  ]);
  // Also add a log so the hook appears consistently in feed.
  const bio = await client.query(
    `INSERT INTO biography_logs (officer_id, event_type, event_data)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [row.officer_id, 'episode', { summary: ep.hook, episode: ep }]
  );
  const bioLogId = bio.rows[0]?.id || null;
  await biographyQueue.add('narrate', {
    bioLogId,
    officerId: row.officer_id,
    actor: row.officer_name,
    actorRole: row.officer_role || 'officer',
    target: null,
    command: 'episode',
    summary: ep.hook
  });
  return { created: true, episode: ep, flags: nextFlags };
}

function seededRng(seedHex8) {
  let s = parseInt(String(seedHex8 || '0'), 16);
  if (!Number.isFinite(s)) s = Math.floor(Math.random() * 0xffffffff);
  let a = s >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickWeightedUnique(pool, k, rand) {
  const picked = [];
  const items = pool.slice();
  while (items.length && picked.length < k) {
    const total = items.reduce((acc, it) => acc + Math.max(0.0001, Number(it.weight || 1)), 0);
    let r = rand() * total;
    let idx = 0;
    for (; idx < items.length; idx += 1) {
      r -= Math.max(0.0001, Number(items[idx].weight || 1));
      if (r <= 0) break;
    }
    if (idx >= items.length) idx = items.length - 1;
    picked.push(items[idx]);
    items.splice(idx, 1);
  }
  return picked;
}

async function ensureBattleSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS battles (
      id TEXT PRIMARY KEY,
      player_id UUID NOT NULL REFERENCES players(id),
      officer_id TEXT NOT NULL REFERENCES officers(id),
      enemy_name TEXT NOT NULL,
      player_hp INT NOT NULL,
      enemy_hp INT NOT NULL,
      player_x INT NOT NULL,
      player_y INT NOT NULL,
      enemy_x INT NOT NULL,
      enemy_y INT NOT NULL,
      map_json JSONB NOT NULL,
      turn_count INT NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'ongoing',
      last_log TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  // Optional reward metadata (backwards compatible). Used for special/unique encounters.
  await pool.query(`ALTER TABLE battles ADD COLUMN IF NOT EXISTS battle_kind TEXT NOT NULL DEFAULT 'normal'`);
  await pool.query(`ALTER TABLE battles ADD COLUMN IF NOT EXISTS reward_item_id TEXT`);
  await pool.query(`ALTER TABLE battles ADD COLUMN IF NOT EXISTS reward_unique_key TEXT`);
  await pool.query(`ALTER TABLE battles ADD COLUMN IF NOT EXISTS reward_granted BOOLEAN NOT NULL DEFAULT FALSE`);
}

async function ensureMatchSchema() {
  // New mode: session-based auto-battler (1v1 first). Keep it isolated from the MUD loop tables.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS matches (
      id TEXT PRIMARY KEY,
      mode TEXT NOT NULL DEFAULT '1v1',
      status TEXT NOT NULL DEFAULT 'lobby',
      seed BIGINT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS match_players (
      match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
      seat INT NOT NULL,
      player_id UUID REFERENCES players(id) ON DELETE CASCADE,
      officer_id TEXT NOT NULL REFERENCES officers(id),
      hp INT NOT NULL DEFAULT 100,
      gold INT NOT NULL DEFAULT 0,
      level INT NOT NULL DEFAULT 1,
      xp INT NOT NULL DEFAULT 0,
      board_state JSONB NOT NULL DEFAULT '{}'::jsonb,
      bench_state JSONB NOT NULL DEFAULT '{}'::jsonb,
      effects JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (match_id, seat)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS match_players_match_idx ON match_players (match_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS match_players_player_idx ON match_players (player_id)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS match_rounds (
      match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
      round INT NOT NULL,
      phase TEXT NOT NULL DEFAULT 'prep',
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      ends_at TIMESTAMPTZ,
      resolved BOOLEAN NOT NULL DEFAULT FALSE,
      result_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      PRIMARY KEY (match_id, round)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS match_rounds_match_idx ON match_rounds (match_id)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS match_shops (
      match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
      seat INT NOT NULL,
      round INT NOT NULL,
      locked BOOLEAN NOT NULL DEFAULT FALSE,
      rolls_used INT NOT NULL DEFAULT 0,
      slots JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (match_id, seat)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS match_shops_match_idx ON match_shops (match_id)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS match_replays (
      match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
      round INT NOT NULL,
      timeline JSONB NOT NULL DEFAULT '[]'::jsonb,
      summary JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (match_id, round)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS match_replays_match_idx ON match_replays (match_id)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS match_story_events (
      match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
      seat INT NOT NULL,
      round INT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      event_id TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      choices JSONB NOT NULL DEFAULT '[]'::jsonb,
      picked_choice_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      resolved_at TIMESTAMPTZ,
      PRIMARY KEY (match_id, seat, round)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS match_story_events_match_idx ON match_story_events (match_id)`);
}

async function ensureWorldSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS forces (
      id TEXT PRIMARY KEY,
      name_kr TEXT NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS edges (
      from_city_id TEXT NOT NULL REFERENCES cities(id),
      to_city_id TEXT NOT NULL REFERENCES cities(id),
      distance INT NOT NULL,
      terrain TEXT NOT NULL DEFAULT 'plains',
      PRIMARY KEY (from_city_id, to_city_id)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS officer_relationships (
      officer_id TEXT NOT NULL REFERENCES officers(id),
      target_id TEXT NOT NULL REFERENCES officers(id),
      rapport INT NOT NULL DEFAULT 0,
      bond TEXT,
      PRIMARY KEY (officer_id, target_id)
    );
  `);

  // Minimal seeds
  await pool.query(
    `INSERT INTO forces (id, name_kr) VALUES
      ('wei','위'),('shu','촉'),('wu','오'),('neutral','중립'),('ronin','재야')
     ON CONFLICT (id) DO NOTHING`
  );
  // Note: do not seed edges here. Scenario edges are seeded by ensureSeedWorld190().
}

async function ensureGameTimeSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS game_time (
      id INT PRIMARY KEY,
      year INT NOT NULL,
      month INT NOT NULL,
      day INT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  // Default scenario: 190 Anti-Dong Zhuo arc (only used on fresh DBs).
  await pool.query(
    `INSERT INTO game_time (id, year, month, day)
     VALUES (1, 190, 1, 1)
     ON CONFLICT (id) DO NOTHING`
  );
}

async function ensureOfficerRoleSchema() {
  // Extend forces
  await pool.query(`ALTER TABLE forces ADD COLUMN IF NOT EXISTS ruler_officer_id TEXT`);
  await pool.query(`ALTER TABLE forces ADD COLUMN IF NOT EXISTS capital_city_id TEXT`);

  // Extend cities: governor slot
  await pool.query(`ALTER TABLE cities ADD COLUMN IF NOT EXISTS governor_officer_id TEXT`);

  // Extend officers: role/title
  await pool.query(`ALTER TABLE officers ADD COLUMN IF NOT EXISTS title TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE officers ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'ronin'`);
  await pool.query(`ALTER TABLE officers ADD COLUMN IF NOT EXISTS governed_city_id TEXT`);
}

async function ensureStorySchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS story_states (
      officer_id TEXT PRIMARY KEY REFERENCES officers(id),
      chapter INT NOT NULL DEFAULT 1,
      objective TEXT NOT NULL DEFAULT '',
      flags JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  // Deterministic "big beats" stored in DB. The server decides progression; LLM only writes small scenes.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS story_arcs (
      arc_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      start_year INT NOT NULL,
      start_month INT NOT NULL,
      start_day INT NOT NULL,
      end_stage INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS story_beats (
      arc_id TEXT NOT NULL REFERENCES story_arcs(arc_id) ON DELETE CASCADE,
      stage INT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      objective TEXT NOT NULL DEFAULT '',
      trigger_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      effect_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      PRIMARY KEY (arc_id, stage)
    )
  `);
}

async function ensureDeepDataSchema() {
  // This project currently uses "schema on boot" rather than migrations.
  // Keep additions backwards compatible with existing deployments.
  await pool.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);

  // Officer: split "visible stats" vs "hidden stats" (jsonb for future expansion).
  await pool.query(`ALTER TABLE officers ADD COLUMN IF NOT EXISTS family_name TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE officers ADD COLUMN IF NOT EXISTS given_name TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE officers ADD COLUMN IF NOT EXISTS style_name TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE officers ADD COLUMN IF NOT EXISTS personality TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE officers ADD COLUMN IF NOT EXISTS hidden_stats JSONB NOT NULL DEFAULT '{}'::jsonb`);
  await pool.query(`ALTER TABLE officers ADD COLUMN IF NOT EXISTS gold INT NOT NULL DEFAULT 500`);
  await pool.query(`ALTER TABLE officers ADD COLUMN IF NOT EXISTS fame INT NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE officers ADD COLUMN IF NOT EXISTS portrait_prompt TEXT NOT NULL DEFAULT ''`);
  // Progression/build system (LoL-like): level/xp + skill points + equipped passives.
  await pool.query(`ALTER TABLE officers ADD COLUMN IF NOT EXISTS level INT NOT NULL DEFAULT 1`);
  await pool.query(`ALTER TABLE officers ADD COLUMN IF NOT EXISTS xp INT NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE officers ADD COLUMN IF NOT EXISTS skill_points INT NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE officers ADD COLUMN IF NOT EXISTS unlocked_skills JSONB NOT NULL DEFAULT '[]'::jsonb`);
  await pool.query(`ALTER TABLE officers ADD COLUMN IF NOT EXISTS equipped_skills JSONB NOT NULL DEFAULT '{}'::jsonb`);
  // Officer selection: only curated/historical officers should appear in the picker.
  await pool.query(`ALTER TABLE officers ADD COLUMN IF NOT EXISTS is_playable BOOLEAN NOT NULL DEFAULT FALSE`);
  await pool.query(`ALTER TABLE officers ADD COLUMN IF NOT EXISTS is_historical BOOLEAN NOT NULL DEFAULT FALSE`);
  // Inventory + party (ronin employ should be meaningful).
  await pool.query(`ALTER TABLE officers ADD COLUMN IF NOT EXISTS inventory JSONB NOT NULL DEFAULT '[]'::jsonb`);
  // Minimal equipment slots (weapon/mount). Inventory holds ownership; equipment holds what is currently active.
  await pool.query(`ALTER TABLE officers ADD COLUMN IF NOT EXISTS equipment JSONB NOT NULL DEFAULT '{}'::jsonb`);
  await pool.query(`ALTER TABLE officers ADD COLUMN IF NOT EXISTS leader_officer_id TEXT`);
  await pool.query(`CREATE INDEX IF NOT EXISTS officers_leader_idx ON officers (leader_officer_id)`);

  // 190 AD scenario extensions: birth/death, ambition/duty, traits, relationships JSONB
  await pool.query(`ALTER TABLE officers ADD COLUMN IF NOT EXISTS birth_year INT`);
  await pool.query(`ALTER TABLE officers ADD COLUMN IF NOT EXISTS lifespan INT`);
  await pool.query(`ALTER TABLE officers ADD COLUMN IF NOT EXISTS ambition INT NOT NULL DEFAULT 50`);
  await pool.query(`ALTER TABLE officers ADD COLUMN IF NOT EXISTS duty INT NOT NULL DEFAULT 50`);
  await pool.query(`ALTER TABLE officers ADD COLUMN IF NOT EXISTS traits JSONB NOT NULL DEFAULT '[]'::jsonb`);
  await pool.query(`ALTER TABLE officers ADD COLUMN IF NOT EXISTS officer_relationships JSONB NOT NULL DEFAULT '{}'::jsonb`);
  await pool.query(`ALTER TABLE officers ADD COLUMN IF NOT EXISTS faction_id TEXT`);
  // Custody system (officer-centric drama): suspicion -> imprisonment -> sentence.
  await pool.query(`ALTER TABLE officers ADD COLUMN IF NOT EXISTS custody_status TEXT NOT NULL DEFAULT 'free'`);
  await pool.query(`ALTER TABLE officers ADD COLUMN IF NOT EXISTS custody_reason TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE officers ADD COLUMN IF NOT EXISTS custody_since_daykey TEXT NOT NULL DEFAULT ''`);

  // City: enrich with region/coordinates/resources, keeping current fields for compatibility.
  await pool.query(`ALTER TABLE cities ADD COLUMN IF NOT EXISTS city_type TEXT NOT NULL DEFAULT 'City'`);
  await pool.query(`ALTER TABLE cities ADD COLUMN IF NOT EXISTS region TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE cities ADD COLUMN IF NOT EXISTS coordinates POINT`);
  await pool.query(`ALTER TABLE cities ADD COLUMN IF NOT EXISTS resources JSONB NOT NULL DEFAULT '{}'::jsonb`);
  await pool.query(`ALTER TABLE cities ADD COLUMN IF NOT EXISTS defense_max INT NOT NULL DEFAULT 1000`);
  await pool.query(`ALTER TABLE cities ADD COLUMN IF NOT EXISTS security INT NOT NULL DEFAULT 50`);
  // 190 AD extensions: region FK, traits, max_population
  await pool.query(`ALTER TABLE cities ADD COLUMN IF NOT EXISTS region_id INT`);
  await pool.query(`ALTER TABLE cities ADD COLUMN IF NOT EXISTS city_traits JSONB NOT NULL DEFAULT '{}'::jsonb`);
  await pool.query(`ALTER TABLE cities ADD COLUMN IF NOT EXISTS max_population INT NOT NULL DEFAULT 500000`);

  // Edge: support chokepoints (gates) and future pathfinding rules.
  await pool.query(`ALTER TABLE edges ADD COLUMN IF NOT EXISTS is_chokepoint BOOLEAN NOT NULL DEFAULT FALSE`);

  // Lore: "big facts" knowledge base for story/RAG. Keep it small and deterministic.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lore_entries (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      tags TEXT[] NOT NULL DEFAULT '{}'::text[],
      body TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS lore_kind_idx ON lore_entries (kind)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS lore_title_idx ON lore_entries (title)`);

  // Skill definitions (for UI listing + auditability). Server logic uses SKILL_DEFS constants for rules.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS skill_defs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      unlock_level INT NOT NULL DEFAULT 1,
      description TEXT NOT NULL DEFAULT '',
      effects JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  for (const s of SKILL_DEFS) {
    await pool.query(
      `INSERT INTO skill_defs (id, name, unlock_level, description, effects)
       VALUES ($1,$2,$3,$4,$5::jsonb)
       ON CONFLICT (id) DO UPDATE
       SET name=EXCLUDED.name, unlock_level=EXCLUDED.unlock_level, description=EXCLUDED.description, effects=EXCLUDED.effects, updated_at=now()`,
      [s.id, s.name, Number(s.unlock_level || 1), String(s.desc || ''), JSON.stringify(s.effects || {})]
    );
  }

  // Generated portraits (async jobs; served as /portraits/<file_name> by nginx).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS portraits (
      id TEXT PRIMARY KEY,
      officer_id TEXT NOT NULL REFERENCES officers(id),
      prompt TEXT NOT NULL,
      negative_prompt TEXT NOT NULL DEFAULT '',
      size INT NOT NULL DEFAULT 256,
      width INT,
      height INT,
      steps INT,
      cfg_scale DOUBLE PRECISION,
      sampling_method TEXT,
      scheduler TEXT,
      preset TEXT,
      model_key TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'queued',
      file_name TEXT,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  // Backward-compatible migrations for existing deployments.
  await pool.query(`ALTER TABLE portraits ADD COLUMN IF NOT EXISTS width INT`);
  await pool.query(`ALTER TABLE portraits ADD COLUMN IF NOT EXISTS height INT`);
  await pool.query(`ALTER TABLE portraits ADD COLUMN IF NOT EXISTS steps INT`);
  await pool.query(`ALTER TABLE portraits ADD COLUMN IF NOT EXISTS cfg_scale DOUBLE PRECISION`);
  await pool.query(`ALTER TABLE portraits ADD COLUMN IF NOT EXISTS sampling_method TEXT`);
  await pool.query(`ALTER TABLE portraits ADD COLUMN IF NOT EXISTS scheduler TEXT`);
  await pool.query(`ALTER TABLE portraits ADD COLUMN IF NOT EXISTS preset TEXT`);
  await pool.query(`CREATE INDEX IF NOT EXISTS portraits_officer_updated_idx ON portraits (officer_id, updated_at DESC)`);

  // Relationships: directed, typed edges (guanxi).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS relationships (
      source_officer_id TEXT NOT NULL REFERENCES officers(id),
      target_officer_id TEXT NOT NULL REFERENCES officers(id),
      rel_type TEXT NOT NULL,
      affinity_score INT NOT NULL DEFAULT 0,
      history_log JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (source_officer_id, target_officer_id, rel_type)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS relationships_source_idx ON relationships (source_officer_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS relationships_target_idx ON relationships (target_officer_id)`);

  // Scenario event system: date + condition_json + effect_script.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS scenario_events (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      trigger_year INT NOT NULL,
      trigger_month INT NOT NULL,
      trigger_day INT NOT NULL,
      condition_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      effect_script JSONB NOT NULL DEFAULT '{}'::jsonb,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      fired_at TIMESTAMPTZ
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS scenario_events_trigger_idx ON scenario_events (trigger_year, trigger_month, trigger_day)`);
}

// ─── 190 AD Relational Schema ──────────────────────────────────────────────────
async function ensure190Schema() {
  // Regions (provinces)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS regions (
      region_id SERIAL PRIMARY KEY,
      name_zh VARCHAR(50) NOT NULL UNIQUE,
      name_en VARCHAR(50) NOT NULL,
      description TEXT,
      resource_modifier JSONB DEFAULT '{"food": 1.0, "gold": 1.0}'::jsonb,
      climate_type VARCHAR(20) DEFAULT 'Temperate'
    )
  `);

  // Factions (warlord groups, TEXT PK to match force_id convention)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS factions (
      id TEXT PRIMARY KEY,
      name_zh VARCHAR(50) NOT NULL,
      name_en VARCHAR(50) NOT NULL,
      ruler_officer_id TEXT,
      color_hex VARCHAR(7) DEFAULT '#FFFFFF',
      reputation INT DEFAULT 0,
      imperial_seal BOOLEAN DEFAULT FALSE,
      capital_city_id TEXT
    )
  `);

  // Map connections (strategic graph with chokepoints/control)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS map_connections (
      connection_id SERIAL PRIMARY KEY,
      city_a_id TEXT NOT NULL REFERENCES cities(id),
      city_b_id TEXT NOT NULL REFERENCES cities(id),
      distance_days INT NOT NULL CHECK (distance_days > 0),
      terrain_type VARCHAR(20) DEFAULT 'Plains',
      is_chokepoint BOOLEAN DEFAULT FALSE,
      control_faction_id TEXT,
      CONSTRAINT uq_map_connection UNIQUE (city_a_id, city_b_id)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_map_conn_a ON map_connections(city_a_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_map_conn_b ON map_connections(city_b_id)`);

  // Items catalog
  await pool.query(`
    CREATE TABLE IF NOT EXISTS items (
      item_id TEXT PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      type VARCHAR(20) NOT NULL,
      effects JSONB DEFAULT '{}'::jsonb,
      price INT DEFAULT 0
    )
  `);
  // Idempotent migrations: older DBs may have a narrower items schema.
  await pool.query(`ALTER TABLE items ADD COLUMN IF NOT EXISTS rarity VARCHAR(20) NOT NULL DEFAULT 'common'`);
  await pool.query(`ALTER TABLE items ADD COLUMN IF NOT EXISTS slot VARCHAR(20) DEFAULT NULL`);
  await pool.query(`ALTER TABLE items ADD COLUMN IF NOT EXISTS stackable BOOLEAN NOT NULL DEFAULT TRUE`);
  await pool.query(`ALTER TABLE items ADD COLUMN IF NOT EXISTS max_stack INT NOT NULL DEFAULT 99`);
  await pool.query(`ALTER TABLE items ADD COLUMN IF NOT EXISTS unique_key TEXT DEFAULT NULL`);
  await pool.query(`ALTER TABLE items ADD COLUMN IF NOT EXISTS is_shop BOOLEAN NOT NULL DEFAULT TRUE`);
  await pool.query(`ALTER TABLE items ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE items ADD COLUMN IF NOT EXISTS sell_price INT NOT NULL DEFAULT 0`);
  await pool.query(`CREATE INDEX IF NOT EXISTS items_shop_idx ON items (is_shop)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS items_unique_idx ON items (unique_key)`);

  // Global uniqueness for legendary named items (e.g., famous horses/swords).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS unique_ownership (
      unique_key TEXT PRIMARY KEY,
      item_id TEXT NOT NULL REFERENCES items(item_id),
      owner_officer_id TEXT NOT NULL REFERENCES officers(id),
      acquired_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  // Officer inventory table (separate from officers.inventory JSONB for structured queries)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS officer_inventory (
      officer_id TEXT PRIMARY KEY REFERENCES officers(id),
      items JSONB DEFAULT '[]'::jsonb
    )
  `);
}

async function ensurePlayableOfficerSeeds() {
  // Mark seed-provided playable officers as playable/historical (idempotent).
  const ids = (seedOfficers || []).filter((o) => o && o.is_playable).map((o) => String(o.id));
  if (ids.length) {
    await pool.query(
      `UPDATE officers
       SET is_playable = TRUE, is_historical = TRUE
       WHERE id = ANY($1::text[])`,
      [ids]
    );
  }
  await pool.query(`UPDATE officers SET is_playable = FALSE WHERE id = 'player_default'`);
}

async function ensureSeedWorld190() {
  // Idempotent world expansion: upsert regions/factions/cities/officers/edges/map_connections/items.
  // This runs on every boot and only inserts what's missing.
  await withTx(async (client) => {
    // 1. Seed regions
    for (const r of seedRegions) {
      await client.query(
        `INSERT INTO regions (name_zh, name_en, description, resource_modifier, climate_type)
         VALUES ($1,$2,$3,$4::jsonb,$5)
         ON CONFLICT DO NOTHING`,
        [r.name_zh, r.name_en, r.description, JSON.stringify(r.resource_modifier), r.climate_type]
      );
    }
    // Build region lookup (name_zh -> region_id)
    const regionRows = await client.query(`SELECT region_id, name_zh FROM regions`);
    const regionMap = {};
    for (const rr of regionRows.rows) regionMap[rr.name_zh] = rr.region_id;

    // 2. Seed factions (maps to forces too)
    for (const f of seedFactions) {
      await client.query(
        `INSERT INTO factions (id, name_zh, name_en, ruler_officer_id, color_hex, reputation, imperial_seal, capital_city_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (id) DO NOTHING`,
        [f.id, f.name_zh, f.name_en, f.ruler_officer_id, f.color_hex, f.reputation, f.imperial_seal, f.capital_city_id]
      );
      // Also sync to legacy forces table
      await client.query(
        `INSERT INTO forces (id, name_kr) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING`,
        [f.id, f.name_zh]
      );
    }

    // 3. Seed cities
    for (const c of seedCities) {
      const regionId = regionMap[c.region_name] || null;
      await client.query(
        `INSERT INTO cities (id, name_kr, owner_force_id, gold, rice, population, commerce, farming, defense,
                             region_id, city_traits, max_population)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)
         ON CONFLICT (id) DO NOTHING`,
        [c.id, c.name_kr, c.owner_force_id, c.gold, c.rice, c.population,
        c.commerce, c.farming, c.defense, regionId, JSON.stringify(c.traits || {}), c.max_population || 500000]
      );
    }

    // 4. Seed edges (legacy bidirectional) + map_connections (new bidirectional)
    for (const e of seedEdges) {
      const [a, b, distance, terrain, isChokepoint] = e;
      // Legacy edges: forward + reverse
      await client.query(
        `INSERT INTO edges (from_city_id, to_city_id, distance, terrain, is_chokepoint)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (from_city_id, to_city_id) DO NOTHING`,
        [a, b, distance, terrain, !!isChokepoint]
      );
      await client.query(
        `INSERT INTO edges (from_city_id, to_city_id, distance, terrain, is_chokepoint)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (from_city_id, to_city_id) DO NOTHING`,
        [b, a, distance, terrain, !!isChokepoint]
      );
    }
    for (const mc of seedMapConnections) {
      const [a, b, distDays, terrainType, isChoke] = mc;
      // map_connections: forward + reverse
      await client.query(
        `INSERT INTO map_connections (city_a_id, city_b_id, distance_days, terrain_type, is_chokepoint)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT ON CONSTRAINT uq_map_connection DO NOTHING`,
        [a, b, distDays, terrainType, !!isChoke]
      );
      await client.query(
        `INSERT INTO map_connections (city_a_id, city_b_id, distance_days, terrain_type, is_chokepoint)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT ON CONSTRAINT uq_map_connection DO NOTHING`,
        [b, a, distDays, terrainType, !!isChoke]
      );
    }

    // 5. Seed officers
    for (const o of seedOfficers) {
      const hiddenStats = { ambition: o.ambition ?? 50, duty: o.duty ?? 50, affinity: o.compatibility ?? 75 };
      await client.query(
        `INSERT INTO officers (
           id, name_kr, war, int_stat, pol, chr, ldr,
           force_id, city_id, rank, compatibility, personality, hidden_stats, gold,
           is_playable, is_historical,
           birth_year, lifespan, ambition, duty, traits, officer_relationships, faction_id
         )
         VALUES (
           $1,$2,$3,$4,$5,$6,$7,
           $8,$9,$10,$11,$12,$13::jsonb,$14,
           $15,$16,
           $17,$18,$19,$20,$21::jsonb,$22::jsonb,$23
         )
         ON CONFLICT (id) DO NOTHING`,
        [
          o.id, o.name_kr, o.war, o.int_stat, o.pol, o.chr, o.ldr,
          o.force_id, o.city_id, o.rank, o.compatibility, '',
          JSON.stringify(hiddenStats), 500,
          !!o.is_playable, !!o.is_historical,
          o.birth_year ?? null, o.lifespan ?? null, o.ambition ?? 50, o.duty ?? 50,
          JSON.stringify(o.traits || []), JSON.stringify(o.relationships || {}),
          o.force_id  // faction_id = force_id for compatibility
        ]
      );
    }

    // 6. Seed items
    for (const it of seedItems) {
      await client.query(
        `INSERT INTO items (item_id, name, type, rarity, slot, stackable, max_stack, unique_key, is_shop, description, effects, price, sell_price)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13)
         ON CONFLICT (item_id) DO UPDATE SET
           name=EXCLUDED.name,
           type=EXCLUDED.type,
           rarity=EXCLUDED.rarity,
           slot=EXCLUDED.slot,
           stackable=EXCLUDED.stackable,
           max_stack=EXCLUDED.max_stack,
           unique_key=EXCLUDED.unique_key,
           is_shop=EXCLUDED.is_shop,
           description=EXCLUDED.description,
           effects=EXCLUDED.effects,
           price=EXCLUDED.price,
           sell_price=EXCLUDED.sell_price`,
        [
          it.item_id,
          it.name,
          it.type,
          it.rarity || 'common',
          it.slot || null,
          it.stackable !== false,
          Number.isFinite(Number(it.max_stack)) ? Number(it.max_stack) : 99,
          it.unique_key || null,
          it.is_shop !== false,
          it.description || '',
          JSON.stringify(it.effects || {}),
          Number(it.price || 0),
          Number(it.sell_price || 0)
        ]
      );
    }
    // Curate shop: only expose current seedItems as shop-buyable to keep UX simple.
    // Previously seeded items remain in DB but are hidden from shop unless re-enabled by future seeds/events.
    const seedItemIds = (seedItems || []).map((x) => String(x?.item_id || '').trim()).filter(Boolean);
    if (seedItemIds.length) {
      await client.query(`UPDATE items SET is_shop = FALSE WHERE is_shop = TRUE AND NOT (item_id = ANY($1::text[]))`, [
        seedItemIds
      ]);
    }

    // 7. Seed story arcs / beats (deterministic big beats)
    for (const a of seedStoryArcs || []) {
      await client.query(
        `INSERT INTO story_arcs (arc_id, title, start_year, start_month, start_day, end_stage)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (arc_id) DO NOTHING`,
        [a.arc_id, a.title, a.start_year, a.start_month, a.start_day, a.end_stage]
      );
    }
    for (const b of seedStoryBeats || []) {
      await client.query(
        `INSERT INTO story_beats (arc_id, stage, title, objective, trigger_json, effect_json)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb)
         ON CONFLICT (arc_id, stage) DO NOTHING`,
        [
          b.arc_id,
          b.stage,
          b.title || '',
          b.objective || '',
          JSON.stringify(b.trigger_json || {}),
          JSON.stringify(b.effect_json || {})
        ]
      );
    }

    // 8. Seed lore entries (RAG/world knowledge). Always upsert to keep content improving.
    // 8.1. Static curated lore
    for (const le of seedLoreEntries || []) {
      await client.query(
        `INSERT INTO lore_entries (id, kind, title, tags, body, source)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (id) DO UPDATE
         SET kind=EXCLUDED.kind, title=EXCLUDED.title, tags=EXCLUDED.tags, body=EXCLUDED.body, source=EXCLUDED.source, updated_at=now()`,
        [
          String(le.id),
          String(le.kind || 'misc'),
          String(le.title || le.id),
          Array.isArray(le.tags) ? le.tags.map(String) : [],
          String(le.body || ''),
          String(le.source || 'seed:lore')
        ]
      );
    }
    // 8.2. Auto-generated lore for any seeded rows (fallback; also upsert to refresh fields)
    for (const f of seedFactions || []) {
      const body =
        `세력:${f.name_zh} (${f.id})\\n` +
        `영문:${f.name_en || ''}\\n` +
        `수도:${f.capital_city_id || '-'}\\n` +
        `색상:${f.color_hex || '-'}\\n` +
        `명성:${Number.isFinite(Number(f.reputation)) ? f.reputation : 0}`;
      await client.query(
        `INSERT INTO lore_entries (id, kind, title, tags, body, source)
         VALUES ($1,'faction',$2,$3,$4,'seed:auto')
         ON CONFLICT (id) DO UPDATE
         SET title=EXCLUDED.title, tags=EXCLUDED.tags, body=EXCLUDED.body, source=EXCLUDED.source, updated_at=now()
         WHERE lore_entries.source = 'seed:auto'`,
        [`faction:${f.id}`, f.name_zh || f.id, [f.id, f.name_zh, f.name_en, f.capital_city_id].filter(Boolean), body]
      );
    }
    for (const c of seedCities) {
      const body =
        `도시:${c.name_kr} (${c.id})\\n` +
        `지역:${c.region_name || '-'}\\n` +
        `소유:${String(c.owner_force_id || 'neutral').toUpperCase()}\\n` +
        `자원: GOLD ${c.gold} / RICE ${c.rice} / POP ${c.population}\\n` +
        `개발: FARM ${c.farming} / COMMERCE ${c.commerce} / DEF ${c.defense}`;
      await client.query(
        `INSERT INTO lore_entries (id, kind, title, tags, body, source)
         VALUES ($1,'city',$2,$3,$4,'seed:auto')
         ON CONFLICT (id) DO UPDATE
         SET title=EXCLUDED.title, tags=EXCLUDED.tags, body=EXCLUDED.body, source=EXCLUDED.source, updated_at=now()
         WHERE lore_entries.source = 'seed:auto'`,
        [`city:${c.id}`, c.name_kr, [c.id, c.name_kr, c.region_name || '', c.owner_force_id || ''].filter(Boolean), body]
      );
    }
    for (const o of seedOfficers) {
      const body =
        `장수:${o.name_kr} (${o.id})\\n` +
        `소속:${String(o.force_id || 'ronin').toUpperCase()}\\n` +
        `거점:${o.city_id}\\n` +
        `능력: LDR ${o.ldr} / WAR ${o.war} / INT ${o.int_stat} / POL ${o.pol} / CHR ${o.chr}\\n` +
        `히든: ambition ${o.ambition ?? 50} / duty ${o.duty ?? 50} / affinity ${o.compatibility ?? 75}`;
      const relTags = [];
      const rel = o.relationships || {};
      if (Array.isArray(rel.sworn_brother)) rel.sworn_brother.forEach((x) => relTags.push(String(x)));
      if (typeof rel.adoptive_father === 'string') relTags.push(rel.adoptive_father);
      await client.query(
        `INSERT INTO lore_entries (id, kind, title, tags, body, source)
         VALUES ($1,'officer',$2,$3,$4,'seed:auto')
         ON CONFLICT (id) DO UPDATE
         SET title=EXCLUDED.title, tags=EXCLUDED.tags, body=EXCLUDED.body, source=EXCLUDED.source, updated_at=now()
         WHERE lore_entries.source = 'seed:auto'`,
        [`officer:${o.id}`, o.name_kr, [o.id, o.name_kr, o.force_id || '', o.city_id || ''].concat(relTags).filter(Boolean), body]
      );
    }
    for (const b of seedStoryBeats || []) {
      const body =
        `큰 줄기:${b.title || ''}\\n` +
        `목표:${b.objective || ''}\\n` +
        `조건:${JSON.stringify(b.trigger_json || {})}\\n` +
        `효과:${JSON.stringify(b.effect_json || {})}`;
      const tags = [b.arc_id, `stage:${b.stage}`, b.title, b.objective]
        .map((x) => String(x || '').trim())
        .filter(Boolean);
      await client.query(
        `INSERT INTO lore_entries (id, kind, title, tags, body, source)
         VALUES ($1,'event',$2,$3,$4,'seed:auto')
         ON CONFLICT (id) DO UPDATE
         SET title=EXCLUDED.title, tags=EXCLUDED.tags, body=EXCLUDED.body, source=EXCLUDED.source, updated_at=now()
         WHERE lore_entries.source = 'seed:auto'`,
        [`event:${b.arc_id}:${b.stage}`, b.title || `${b.arc_id}#${b.stage}`, tags, body]
      );
    }

    // 9. Seed lore cards for unique items (UI + RAG).
    const uniqueLore = [
      {
        item_id: 'mount_red_hare',
        title: '명마: 적토',
        body:
          '적토는 전설로만 전해지는 명마로, 먼 길을 단숨에 달린다.\n' +
          '게임 효과: 이동(travel) AP 비용 대폭 감소.\n' +
          '획득: 유니크 소문/퀘스트를 따라가면 단서를 얻을 수 있다.'
      },
      {
        item_id: 'weapon_qinggang',
        title: '명검: 청강',
        body:
          '청강은 칼날이 서늘하고 예리해, 한 번 휘두르면 빈틈을 가른다.\n' +
          '게임 효과: 전투 공격 보정 증가.\n' +
          '획득: 유니크 소문/퀘스트를 따라가면 거래선(또는 결투)을 만날 수 있다.'
      }
    ];
    for (const it of uniqueLore) {
      await client.query(
        `INSERT INTO lore_entries (id, kind, title, tags, body, source)
         VALUES ($1,'item',$2,$3,$4,'seed:unique-items')
         ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title, tags=EXCLUDED.tags, body=EXCLUDED.body, source=EXCLUDED.source, updated_at=now()`,
        [`item:${it.item_id}`, it.title, [it.item_id].filter(Boolean), it.body]
      );
    }
  });
}

io.on('connection', (socket) => {
  socket.on('join-officer', (officerId) => socket.join(`officer:${officerId}`));
});

app.get('/health', async (_req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true });
});

app.get('/api/health', async (_req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true });
});

app.get('/api/metrics', async (_req, res) => {
  res.setHeader('content-type', register.contentType);
  res.end(await register.metrics());
});

app.get('/api/lore/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const limit = Math.max(1, Math.min(50, Number(req.query.limit || 20)));
    if (!q) return res.json({ ok: true, items: [] });
    const rows = await pool.query(
      `SELECT id, kind, title, tags, body, source, updated_at
       FROM lore_entries
       WHERE title ILIKE $1 OR body ILIKE $1
       ORDER BY title ASC
       LIMIT $2`,
      [`%${q}%`, limit]
    );
    res.json({ ok: true, items: rows.rows });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message || 'lore search failed' });
  }
});

app.get('/api/items/catalog', async (_req, res) => {
  try {
    const rows = await pool.query(
      `SELECT item_id AS id, name, type, rarity, slot, stackable, max_stack, unique_key, is_shop, description AS desc, effects, price, sell_price
       FROM items
       ORDER BY
         CASE rarity WHEN 'legendary' THEN 4 WHEN 'epic' THEN 3 WHEN 'rare' THEN 2 ELSE 1 END DESC,
         price DESC,
         name ASC`
    );
    res.json({ ok: true, items: rows.rows });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message || 'catalog failed' });
  }
});

app.get('/api/player/:playerId/chronicle', async (req, res) => {
  const { playerId } = req.params;
  try {
    const p = await pool.query(
      `SELECT p.id AS player_id, o.id AS officer_id, o.name_kr, o.inventory, o.equipment, o.fame, o.merit
       FROM players p
       JOIN officers o ON o.id = p.officer_id
       WHERE p.id = $1`,
      [playerId]
    );
    if (!p.rows.length) return res.status(404).json({ ok: false, error: 'player not found' });
    const me = p.rows[0];

    const inv = parseInventory(me.inventory);
    const invIds = inv.map((x) => String(x?.id || '').trim()).filter(Boolean);
    const uniqueItems = await pool.query(
      `SELECT item_id, name, type, rarity, slot, unique_key, description, effects
       FROM items
       WHERE unique_key IS NOT NULL
         AND item_id = ANY($1::text[])
       ORDER BY rarity DESC, name ASC`,
      [invIds.length ? invIds : ['__none__']]
    );

    const loot = await pool.query(
      `SELECT id, created_at, event_data
       FROM biography_logs
       WHERE officer_id=$1 AND event_type='loot' AND (event_data->>'unique_key') IS NOT NULL
       ORDER BY created_at DESC
       LIMIT 30`,
      [me.officer_id]
    );
    const acquiredAtByKey = new Map();
    for (const l of loot.rows) {
      const k = l.event_data && typeof l.event_data === 'object' ? String(l.event_data.unique_key || '') : '';
      if (k && !acquiredAtByKey.has(k)) acquiredAtByKey.set(k, l.created_at);
    }

    const loreIds = uniqueItems.rows.map((it) => `item:${it.item_id}`);
    const lore = loreIds.length
      ? await pool.query(
          `SELECT id, title, body, tags, updated_at
           FROM lore_entries
           WHERE id = ANY($1::text[])
           ORDER BY id ASC`,
          [loreIds]
        )
      : { rows: [] };
    const loreMap = new Map(lore.rows.map((r) => [String(r.id), r]));

    const st = await pool.query(`SELECT flags FROM story_states WHERE officer_id=$1`, [me.officer_id]);
    const flags = st.rows[0]?.flags || {};
    const ending = flags?.arc190_ending || null;

    res.json({
      ok: true,
      officer: { id: me.officer_id, name_kr: me.name_kr, fame: asInt(me.fame, 0), merit: asInt(me.merit, 0) },
      uniques: uniqueItems.rows.map((it) => ({
        item_id: it.item_id,
        name: it.name,
        rarity: it.rarity,
        slot: it.slot,
        unique_key: it.unique_key,
        description: it.description,
        effects: it.effects || {},
        acquired_at: acquiredAtByKey.get(String(it.unique_key)) || null,
        lore: loreMap.get(`item:${it.item_id}`) ? { title: loreMap.get(`item:${it.item_id}`).title, body: loreMap.get(`item:${it.item_id}`).body } : null
      })),
      ending
    });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message || 'chronicle failed' });
  }
});

app.post('/api/portraits/generate', async (req, res) => {
  try {
    const { playerId, size = 256, prompt = null, preset = null } = req.body || {};
    const pid = String(playerId || '').trim();
    if (!pid) return res.status(400).json({ ok: false, error: 'playerId is required' });

    const wantedSize = Number(size);
    const sz = wantedSize === 512 ? 512 : 256;
    const presetKey = String(preset || '').trim();
    const PRESETS = {
      // Equivalent to the user's "Preset A": stable, hires OFF.
      stable_a: { width: 640, height: 896, steps: 34, cfg_scale: 6.0, sampling_method: 'dpm++2m', scheduler: 'karras' },
      // Equivalent to the user's "Preset B": higher-res generation (not hiresfix; direct render).
      hires_b: { width: 768, height: 1024, steps: 30, cfg_scale: 6.0, sampling_method: 'dpm++2m', scheduler: 'karras' }
    };
    const presetParams = presetKey && PRESETS[presetKey] ? PRESETS[presetKey] : null;

    const q = await pool.query(
      `SELECT p.id AS player_id, o.id AS officer_id, o.name_kr, o.portrait_prompt
       FROM players p
       JOIN officers o ON o.id = p.officer_id
       WHERE p.id = $1`,
      [pid]
    );
    if (!q.rows.length) return res.status(404).json({ ok: false, error: 'player not found' });
    const me = q.rows[0];

    const p = String(prompt || me.portrait_prompt || '').trim();
    if (!p) return res.status(400).json({ ok: false, error: 'portrait prompt is empty (set it first)' });

    const negative = String(process.env.SD_NEGATIVE || 'blurry, low quality, deformed, bad anatomy').trim();
    const modelKey = sdModelKey;
    const w = presetParams ? Number(presetParams.width) : sz;
    const h = presetParams ? Number(presetParams.height) : sz;
    const steps = presetParams ? Number(presetParams.steps) : null;
    const cfgScale = presetParams ? Number(presetParams.cfg_scale) : null;
    const samplingMethod = presetParams ? String(presetParams.sampling_method) : null;
    const scheduler = presetParams ? String(presetParams.scheduler) : null;
    const id = sha256Hex(`${modelKey}|${w}x${h}|steps=${steps ?? ''}|cfg=${cfgScale ?? ''}|sm=${samplingMethod ?? ''}|sch=${scheduler ?? ''}|${negative}|${p}|v2`);
    const fileName = `${id}_${w}x${h}.png`;
    const filePath = path.join(portraitsDir, fileName);

    // Cached file exists => return immediately (still upsert DB for UI).
    const alreadyFile = fs.existsSync(filePath);

    const existing = await pool.query(`SELECT id, status, file_name, error, updated_at FROM portraits WHERE id=$1`, [id]);
    if (!existing.rows.length) {
      await pool.query(
        `INSERT INTO portraits (id, officer_id, prompt, negative_prompt, size, width, height, steps, cfg_scale, sampling_method, scheduler, preset, model_key, status, file_name, error)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [
          id,
          me.officer_id,
          p,
          negative,
          sz,
          w,
          h,
          steps,
          cfgScale,
          samplingMethod,
          scheduler,
          presetKey || null,
          modelKey,
          alreadyFile ? 'done' : 'queued',
          alreadyFile ? fileName : null,
          null
        ]
      );
    } else {
      if (alreadyFile && existing.rows[0].status !== 'done') {
        await pool.query(`UPDATE portraits SET status='done', file_name=$2, error=NULL, updated_at=now() WHERE id=$1`, [id, fileName]);
      }
      if (!alreadyFile && existing.rows[0].status !== 'queued') {
        // Allow retry from 'error' (or any other state) without requiring a new id.
        await pool.query(`UPDATE portraits SET status='queued', error=NULL, updated_at=now() WHERE id=$1`, [id]);
      }
    }

    if (alreadyFile) {
      return res.json({ ok: true, id, status: 'done', url: `/portraits/${fileName}` });
    }

    // Enqueue job (jobId must be unique to allow retries even when a prior job failed).
    await portraitQueue.add(
      'generate',
      { portraitId: id },
      { jobId: `${id}-${Date.now()}`, removeOnComplete: 200, removeOnFail: 500 }
    );
    res.json({ ok: true, id, status: 'queued', url: null, preset: presetKey || null, width: w, height: h });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message || 'portrait generate failed' });
  }
});

app.get('/api/portraits/suggest', async (req, res) => {
  try {
    const pid = String(req.query.playerId || '').trim();
    const style = String(req.query.style || 'drama').trim(); // drama | realistic | ink | pixel
    const focus = String(req.query.focus || 'face').trim(); // face | bust
    if (!pid) return res.status(400).json({ ok: false, error: 'playerId is required' });

    const q = await pool.query(
      `SELECT p.id AS player_id, o.id AS officer_id, o.name_kr, o.force_id, o.city_id, o.war, o.int_stat, o.pol, o.chr, o.ldr, o.traits, o.officer_relationships, o.is_historical,
              c.name_kr AS city_name
       FROM players p
       JOIN officers o ON o.id = p.officer_id
       JOIN cities c ON c.id = o.city_id
       WHERE p.id = $1`,
      [pid]
    );
    if (!q.rows.length) return res.status(404).json({ ok: false, error: 'player not found' });
    const me = q.rows[0];

    const tags = [
      me.officer_id,
      me.name_kr,
      me.force_id,
      me.city_id,
      me.city_name,
      `officer:${me.officer_id}`,
      `city:${me.city_id}`,
      `faction:${me.force_id}`
    ]
      .map((x) => String(x || '').trim())
      .filter(Boolean);

    // Prevent unrelated officer lore leaking in via broad tags like "ronin".
    const strictOfficerTags = [
      me.officer_id,
      me.name_kr,
      `officer:${me.officer_id}`
    ]
      .map((x) => String(x || '').trim())
      .filter(Boolean);

    // Pull a few factual anchors from lore DB (seeded from story/officer/relationship cards).
    const lore = await pool
      .query(
        `SELECT id, kind, title, body, source, tags
         FROM lore_entries
         WHERE tags && $1::text[]
           AND (kind != 'officer' OR tags && $2::text[])
         ORDER BY
           CASE WHEN source='seed:curated' THEN 2 WHEN source='seed:auto' THEN 1 ELSE 0 END DESC,
           CASE kind WHEN 'relationship' THEN 4 WHEN 'officer' THEN 3 WHEN 'event' THEN 2 WHEN 'city' THEN 1 ELSE 0 END DESC,
           updated_at DESC
         LIMIT 8`,
        [tags, strictOfficerTags]
      )
      .catch(() => ({ rows: [] }));
    // Portrait anchors must be specific to the current officer/city. Relationship/event lore often references
    // other characters in the same era and confuses users, so exclude it here.
    const loreRows = (lore.rows || [])
      .filter(Boolean)
      .filter((r) => {
        const kind = String(r.kind || '').trim();
        if (kind === 'relationship' || kind === 'event') return false;
        return true;
      });
    const loreLines = loreRows
      .map((r) => `${String(r.title || '').trim()}: ${String(r.body || '').replace(/\s+/g, ' ').trim()}`)
      .filter(Boolean)
      .slice(0, 4);

    // Avoid personality/archetype tags in portrait prompts:
    // they often "visualize" into masks/icons/UI motifs instead of a human face.
    const shot = focus === 'bust' ? 'bust portrait, upper body' : 'close-up headshot, face portrait';
    const era = 'late Han dynasty inspired';

    // Model-friendly templates that bias toward "real human face" instead of mask/icon.
    const drama = [
      'photographic portrait of a real East Asian adult man',
      shot,
      `${era} historical drama costume (clothing only)`,
      'simple cloth headwear, no ornament',
      'clearly human facial structure, realistic facial anatomy',
      'skin pores, micro skin texture, subtle wrinkles',
      'natural uneven facial features, natural asymmetry',
      'calm serious expression, natural eyes',
      'cinematic lighting, soft key light',
      'shallow depth of field, 85mm lens',
      'historical drama film still, shot on camera, unretouched',
      'muted realistic color palette, high clarity',
      'no mask, no symbolism'
    ]
      .filter(Boolean)
      .join(', ');

    const base = [
      // "Game-like" but still human.
      'photorealistic human character portrait (real human face)',
      shot,
      `${era} costume (clothing only), simple headwear`,
      'realistic facial anatomy, clearly human face',
      'visible skin texture, pores, micro details',
      'slightly imperfect human face, natural asymmetry, unretouched',
      'neutral soft gradient background',
      'grounded realism, cinematic portrait, film still',
      'no text, no watermark, no logo, no frame, no border',
      'no mask, no symbolism'
    ]
      .filter(Boolean)
      .join(', ');

    const ink = [
      'portrait illustration',
      shot,
      `${era} Chinese officer`,
      'traditional Chinese ink wash illustration, rice paper texture, sumi-e',
      'clear facial features, readable silhouette',
      'restrained color, subtle brush strokes',
      'no text, no seal stamp, no watermark, no frame, no border',
      'no mask, no symbolism'
    ]
      .filter(Boolean)
      .join(', ');

    // NOTE: We still render at 256/512; "pixel" here means "pixel-ish game icon" rather than true 64x64 sprite generation.
    const pixel = [
      'pixel art style game portrait icon',
      shot,
      `${era} Chinese officer`,
      'clean outline, crisp edges, simple shading, readable silhouette',
      'limited palette, no dithering, no noise',
      'friendly heroic look (not horror), normal face proportions',
      'plain background, no text, no watermark, no frame, no border'
    ]
      .filter(Boolean)
      .join(', ');

    const promptCore = style === 'ink' ? ink : style === 'pixel' ? pixel : style === 'realistic' ? base : drama;
    const prompt = `${promptCore}`;
    const negativeBase = String(process.env.SD_NEGATIVE || '').trim() ||
      'worst quality, low quality, lowres, blurry, jpeg artifacts, deformed, disfigured, mutated, bad anatomy, bad proportions, extra limbs, extra fingers, ugly, creepy, horror, gore, blood, text, watermark, logo, signature, frame, border';

    const negativeHumanLock =
      'mask, symbolic face, abstract face, opera, face paint, heavy makeup, ui, interface, panel, stylized, illustration, concept art, game art, icon, poster, splash art, flat shading, perfect symmetry, doll face, plastic skin';

    // Pixel prompts are especially sensitive; push harder against realism to avoid uncanny blobs.
    const negative =
      style === 'pixel'
        ? `${negativeBase}, realistic, photo`
        : style === 'ink'
          ? `${negativeBase}, photo, realistic`
          : `${negativeBase}, ${negativeHumanLock}`;

    res.json({
      ok: true,
      officer: { id: me.officer_id, name_kr: me.name_kr, city: me.city_name, forceId: me.force_id },
      style,
      focus,
      prompt,
      negative_prompt: negative,
      anchors: loreLines,
      sources: loreRows.slice(0, 8).map((r) => ({ id: r.id, kind: r.kind, title: r.title, source: r.source }))
    });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message || 'portrait suggest failed' });
  }
});

app.get('/api/portraits/:id', async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    const r = await pool.query(`SELECT id, officer_id, status, file_name, error, size, model_key, prompt, updated_at FROM portraits WHERE id=$1`, [id]);
    if (!r.rows.length) return res.status(404).json({ ok: false, error: 'not found' });
    const row = r.rows[0];
    const url = row.file_name ? `/portraits/${row.file_name}` : null;
    res.json({ ok: true, portrait: { ...row, url } });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message || 'portrait fetch failed' });
  }
});

app.post('/api/player/bootstrap', async (req, res) => {
  const { username = 'player', telegramUserId = null, officerId = null, officerName = null } = req.body || {};

  try {
    const result = await withTx(async (client) => {
      const existing = telegramUserId
        ? await client.query('SELECT * FROM players WHERE telegram_user_id = $1', [telegramUserId])
        : { rows: [] };

      if (existing.rows.length > 0) return existing.rows[0];

      let pickedOfficerId = null;
      const wantId = typeof officerId === 'string' ? officerId.trim() : '';
      const wantName = typeof officerName === 'string' ? officerName.trim() : '';

      if (wantId || wantName) {
        const q = wantId
          ? await client.query(`SELECT id FROM officers WHERE id=$1 LIMIT 1`, [wantId])
          : await client.query(
            `SELECT id FROM officers WHERE name_kr ILIKE $1 ORDER BY is_playable DESC, is_historical DESC LIMIT 1`,
            [`%${wantName}%`]
          );
        if (!q.rows.length) throw new Error('선택한 장수를 찾을 수 없습니다.');
        pickedOfficerId = q.rows[0].id;

        const taken = await client.query(`SELECT 1 FROM players WHERE officer_id=$1 LIMIT 1`, [pickedOfficerId]);
        if (taken.rows.length) throw new Error('이미 다른 플레이어가 선택한 장수입니다. 다른 장수를 선택하세요.');
      } else {
        // Backward compatible: create an anonymous ronin officer (not playable/historical).
        const personalities = ['대담', '냉정', '소심', '저돌', '신중'];
        const hidden = {
          ambition: Math.floor(Math.random() * 101),
          duty: Math.floor(Math.random() * 101),
          affinity: Math.floor(Math.random() * 150)
        };
        const officer = await client.query(
          `INSERT INTO officers (id, name_kr, war, int_stat, pol, chr, ldr, force_id, city_id, rank, personality, hidden_stats, gold, is_playable, is_historical)
           VALUES ('off_' || substr(md5(random()::text), 1, 8), $1, 72, 68, 70, 73, 71, 'ronin', 'xiang_yang', 9, $2, $3::jsonb, 500, FALSE, FALSE)
           RETURNING id`,
          [username, personalities[Math.floor(Math.random() * personalities.length)], JSON.stringify(hidden)]
        );
        pickedOfficerId = officer.rows[0].id;
      }

      const inserted = await client.query(
        `INSERT INTO players (telegram_user_id, username, officer_id)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [telegramUserId, username, pickedOfficerId]
      );

      // Normalize role for historical officers: if they already belong to a force, they are not "ronin".
      // Keeps the officer-centric fantasy while avoiding "lord game" framing.
      await client.query(
        `UPDATE officers
         SET role = CASE WHEN force_id = 'ronin' THEN 'ronin' ELSE 'vassal' END
         WHERE id = $1 AND (role IS NULL OR role = 'ronin')`,
        [pickedOfficerId]
      );

      // Ensure a story row exists immediately (so next_actions can show an objective without extra clicks).
      const o = await client.query(`SELECT force_id, role, merit, rank, hidden_stats FROM officers WHERE id=$1`, [pickedOfficerId]);
      const forceId = o.rows[0]?.force_id || 'ronin';
      const role = o.rows[0]?.role || 'ronin';
      const merit = asInt(o.rows[0]?.merit, 0);
      const rank = asInt(o.rows[0]?.rank, 9);
      const ambition = getHiddenStat(o.rows[0]?.hidden_stats, 'ambition', 50);
      const computed = computeStoryObjective({ forceId, role, merit, rank, ambition, roninStep: 0, arc190Stage: 0 });
      await client.query(
        `INSERT INTO story_states (officer_id, chapter, objective, flags, updated_at)
         VALUES ($1,$2,$3,$4::jsonb, now())
         ON CONFLICT (officer_id) DO NOTHING`,
        [pickedOfficerId, computed.chapter, computed.objective, JSON.stringify({ story_step: 0, arc190_stage: 0, arc_id: '190_anti_dong_zhuo' })]
      );

      return inserted.rows[0];
    });

    res.json(result);
  } catch (err) {
    res.status(400).json({ ok: false, error: err?.message ? String(err.message) : String(err) });
  }
});

app.get('/api/officers/available', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const limitRaw = Number(req.query.limit || 30);
  const limit = Math.max(1, Math.min(100, Number.isFinite(limitRaw) ? limitRaw : 30));
  const cityId = String(req.query.cityId || '').trim();
  const forceId = String(req.query.forceId || '').trim();

  const where = [];
  const args = [];
  let idx = 1;

  where.push(`o.is_playable = TRUE`);
  where.push(`NOT EXISTS (SELECT 1 FROM players p WHERE p.officer_id = o.id)`);
  if (q) {
    where.push(
      `(o.name_kr ILIKE $${idx} OR o.family_name ILIKE $${idx} OR o.given_name ILIKE $${idx} OR o.style_name ILIKE $${idx})`
    );
    args.push(`%${q}%`);
    idx += 1;
  }
  if (cityId) {
    where.push(`o.city_id = $${idx}`);
    args.push(cityId);
    idx += 1;
  }
  if (forceId) {
    where.push(`o.force_id = $${idx}`);
    args.push(forceId);
    idx += 1;
  }

  const sql = `
    SELECT
      o.id,
      o.name_kr,
      o.family_name,
      o.given_name,
      o.style_name,
      o.war, o.int_stat, o.pol, o.chr, o.ldr,
      o.force_id,
      o.city_id,
      c.name_kr AS city_name,
      o.is_historical
    FROM officers o
    JOIN cities c ON c.id = o.city_id
    WHERE ${where.join(' AND ')}
    ORDER BY o.is_historical DESC, o.force_id ASC, o.rank ASC, o.ldr DESC, o.war DESC
    LIMIT ${limit}
  `;
  const rows = await pool.query(sql, args);
  res.json({ ok: true, items: rows.rows });
});

app.get('/api/player/:playerId/employ_candidates', async (req, res) => {
  const { playerId } = req.params;
  const me = await pool.query(
    `SELECT o.id AS officer_id, o.city_id
     FROM players p JOIN officers o ON o.id = p.officer_id
     WHERE p.id = $1`,
    [playerId]
  );
  if (!me.rows.length) return res.status(404).json({ ok: false, error: 'player not found' });
  const { officer_id, city_id } = me.rows[0];

  const rows = await pool.query(
    `SELECT o.id, o.name_kr, o.war, o.int_stat, o.pol, o.chr, o.ldr
     FROM officers o
     WHERE o.city_id = $1
       AND o.force_id = 'ronin'
       AND o.id <> $2
       AND o.leader_officer_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM players p WHERE p.officer_id = o.id)
     ORDER BY o.war DESC, o.ldr DESC
     LIMIT 8`,
    [city_id, officer_id]
  );
  res.json({ ok: true, items: rows.rows });
});

app.get('/api/player/:playerId/status', async (req, res) => {
  const { playerId } = req.params;
  const row = await pool.query(
    `SELECT p.id AS player_id, p.username, o.*, c.name_kr AS city_name
     FROM players p
     JOIN officers o ON o.id = p.officer_id
     JOIN cities c ON c.id = o.city_id
     WHERE p.id = $1`,
    [playerId]
  );

  if (!row.rows.length) return res.status(404).json({ error: 'player not found' });

  const officerId = row.rows[0].id;
  const party = await pool.query(`SELECT COUNT(*)::int AS cnt FROM officers WHERE leader_officer_id = $1`, [officerId]);
  const time = await pool.query('SELECT year, month, day FROM game_time WHERE id = 1');
  const portrait = await pool.query(
    `SELECT id, status, file_name, error, updated_at
     FROM portraits
     WHERE officer_id = $1
     ORDER BY updated_at DESC
     LIMIT 1`,
    [officerId]
  );
  const p = portrait.rows[0] || null;
  res.json({
    player: {
      ...row.rows[0],
      portrait: p
        ? {
            id: p.id,
            status: p.status,
            file_name: p.file_name,
            error: p.error,
            updated_at: p.updated_at,
            url: p.file_name ? `/portraits/${p.file_name}` : null
          }
        : null
    },
    party: { count: party.rows[0]?.cnt ?? 0 },
    gameTime: time.rows[0]
  });
});

app.get('/api/player/:playerId/feed', async (req, res) => {
  const { playerId } = req.params;
  const limitRaw = Number(req.query.limit || 30);
  const limit = Math.max(1, Math.min(100, Number.isFinite(limitRaw) ? limitRaw : 30));

  const p = await pool.query(
    `SELECT o.id AS officer_id
     FROM players p
     JOIN officers o ON o.id = p.officer_id
     WHERE p.id = $1`,
    [playerId]
  );
  if (!p.rows.length) return res.status(404).json({ ok: false, error: 'player not found' });

  const officerId = p.rows[0].officer_id;
  const logs = await pool.query(
    `SELECT id, event_type, event_data, narration, created_at
     FROM biography_logs
     WHERE officer_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [officerId, limit]
  );

  res.json({ ok: true, officerId, items: logs.rows.reverse() });
});

app.get('/api/player/:playerId/next_actions', async (req, res) => {
  const { playerId } = req.params;
  const q = await pool.query(
    `SELECT p.id AS player_id, o.id AS officer_id, o.name_kr, o.ap, o.merit, o.rank, o.role, o.force_id, o.city_id, o.hidden_stats,
            o.gold AS officer_gold,
            o.custody_status,
            o.level, o.xp, o.skill_points,
            c.name_kr AS city_name, c.owner_force_id
     FROM players p
     JOIN officers o ON o.id = p.officer_id
     JOIN cities c ON c.id = o.city_id
     WHERE p.id = $1`,
    [playerId]
  );
  if (!q.rows.length) return res.status(404).json({ error: 'player not found' });
  const me = q.rows[0];

  const nearby = await pool.query(
    `SELECT e.to_city_id AS city_id, c.name_kr, c.owner_force_id, e.distance, e.terrain
     FROM edges e JOIN cities c ON c.id = e.to_city_id
     WHERE e.from_city_id = $1
     ORDER BY e.distance ASC`,
    [me.city_id]
  );

  const actions = [];
  // Always surface the current objective in recommendations.
  const st = await pool.query(`SELECT objective FROM story_states WHERE officer_id=$1`, [me.officer_id]);
  const objective = String(st.rows[0]?.objective || '').trim();
  if (objective) actions.push({ cmd: 'story', why: objective, command: 'story', payload: {} });
  actions.push({ cmd: 'end_turn', why: '턴 종료: 하루 진행 + AP/제한 리셋', command: 'end_turn', payload: {} });
  actions.push({ cmd: 'next', why: '추천 갱신(시간 진행 없음)', command: 'next', payload: {} });
  actions.push({ cmd: 'status', why: '현재 상태 확인', command: 'status', payload: {} });
  actions.push({ cmd: 'map_nearby', why: '인접 도시 확인', command: 'map_nearby', payload: {} });
  if ((me.skill_points ?? 0) > 0 || (me.level ?? 1) >= 2) actions.push({ cmd: 'skills', why: '스킬/빌드(LoL처럼 세팅)', command: 'skills', payload: {} });
  if (String(me.custody_status || 'free') !== 'free') actions.push({ cmd: 'breakout', why: '구금 탈출 시도(리스크/보상)', command: 'breakout', payload: {} });
  // rest is intentionally not a primary recommendation; end_turn is simpler.
  if (me.officer_gold >= 120) actions.push({ cmd: 'shop', why: '상점에서 아이템 확인/구매', command: 'shop', payload: {} });
  if (String(me.custody_status || 'free') === 'free' && me.ap >= 25) actions.push({ cmd: 'skirmish', why: '소규모 개인전(오토배틀)로 성장/보상', command: 'skirmish', payload: {} });
  try {
    const st3 = await pool.query(`SELECT flags FROM story_states WHERE officer_id=$1`, [me.officer_id]);
    const flags = st3.rows[0]?.flags && typeof st3.rows[0].flags === 'object' ? st3.rows[0].flags : {};
    const sc = flags.scout_offer && typeof flags.scout_offer === 'object' ? flags.scout_offer : null;
    if (sc && asInt(sc.stage, 0) === 1) actions.push({ cmd: 'socialize', why: '스카우트 접선: socialize/visit/gift 중 하나로 접선 완료', command: 'socialize', payload: {} });
    if (sc && asInt(sc.stage, 0) === 2 && String(sc.to || '').trim()) {
      actions.push({ cmd: `scout_join ${String(sc.to).trim()}`, why: '스카우트: 최종 합류', command: 'scout_join', payload: { factionId: String(sc.to).trim() } });
      actions.push({ cmd: `scout_backout ${String(sc.to).trim()}`, why: '스카우트: 발 빼기', command: 'scout_backout', payload: { factionId: String(sc.to).trim() } });
    }
  } catch {
    // ignore
  }

  // If a small episode is pending, surface it as top-priority clickable choices.
  try {
    const st2 = await pool.query(`SELECT flags FROM story_states WHERE officer_id=$1`, [me.officer_id]);
    const flags = st2.rows[0]?.flags && typeof st2.rows[0].flags === 'object' ? st2.rows[0].flags : {};
    const pe = flags.pending_episode && typeof flags.pending_episode === 'object' ? flags.pending_episode : null;
    if (pe && Array.isArray(pe.options) && pe.options.length && pe.resolved !== true) {
      actions.unshift({
        cmd: 'story',
        why: `에피소드: ${String(pe.hook || '').slice(0, 120)}`,
        command: 'story',
        payload: {}
      });
      pe.options
        .slice(0, 3)
        .reverse()
        .forEach((o) => {
          const cmd = String(o.cmd || o.verb || '').trim() || 'story';
          const label = String(o.label || o.verb || '').trim() || '선택';
          actions.unshift({
            cmd,
            why: `선택지: ${label}`,
            command: cmd.split(/\s+/)[0],
            payload: cmd.startsWith('visit ')
              ? { targetName: cmd.slice(6).trim() }
              : cmd.startsWith('gift ')
                ? { targetName: cmd.slice(5).trim() }
                : cmd.startsWith('travel ')
                  ? { toCityId: cmd.slice(7).trim(), toCityName: cmd.slice(7).trim() }
                  : cmd.startsWith('spy ')
                    ? { toCityId: cmd.slice(4).trim(), toCityName: cmd.slice(4).trim() }
                    : cmd.startsWith('scout_accept ')
                      ? { factionId: cmd.slice('scout_accept '.length).trim() }
                      : cmd.startsWith('scout_decline ')
                        ? { factionId: cmd.slice('scout_decline '.length).trim() }
                    : {}
          });
        });
    }
  } catch {
    // ignore
  }

  if (me.force_id === 'ronin') {
    // 장수 게임의 핵심: 인맥 -> 등용 -> 커리어 확장
    if (me.ap >= 10) actions.push({ cmd: 'visit', why: '주변 인물과 대화(관시 +)', command: 'visit', payload: {} });
    if (me.ap >= 10) actions.push({ cmd: 'gift', why: '선물로 관계를 크게 올림(금 필요)', command: 'gift', payload: {} });
    if (me.ap >= 15) actions.push({ cmd: 'banquet', why: '연회로 인맥 확대(금 필요)', command: 'banquet', payload: {} });
    if (me.ap >= 10) actions.push({ cmd: 'socialize', why: '주막에서 인맥을 쌓아 등용/임무 성공률을 올림', command: 'socialize', payload: {} });
    if (me.ap >= 10 && me.officer_gold >= 50) actions.push({ cmd: 'recruit_rumor', why: '소문을 퍼뜨려 다음 탐색에서 인재 조우 확률 +', command: 'recruit_rumor', payload: {} });

    const prospects = await pool.query(
      `SELECT
         o.id,
         o.name_kr,
         o.loyalty,
         o.compatibility,
         COALESCE(r.affinity_score, 0) AS affinity_score
       FROM officers o
       LEFT JOIN relationships r
         ON r.source_officer_id = $1
        AND r.target_officer_id = o.id
        AND r.rel_type = 'Acquaintance'
       WHERE o.city_id = $2
         AND o.force_id = 'ronin'
       ORDER BY COALESCE(r.affinity_score, 0) DESC, o.war DESC
       LIMIT 3`,
      [me.officer_id, me.city_id]
    );

    if (prospects.rows.length) {
      const t = prospects.rows[0];
      if (me.ap >= 30) {
        actions.push({
          cmd: `employ ${t.name_kr}`,
          why: `재야 장수 [${t.name_kr}] 등용 시도 (친밀도 ${t.affinity_score >= 0 ? '+' : ''}${t.affinity_score})`,
          command: 'employ',
          payload: { targetName: t.name_kr }
        });
      }
    }

    if (nearby.rows.length) {
      const best = nearby.rows[0];
      if (me.ap >= 25) {
        actions.push({
          cmd: `spy ${best.city_id}`,
          why: `인접 도시(${best.name_kr}) 정찰`,
          command: 'spy',
          payload: { toCityId: best.city_id, toCityName: best.name_kr }
        });
      }
      actions.push({
        cmd: `travel ${best.city_id}`,
        why: `인접 도시(${best.name_kr})로 이동`,
        command: 'travel',
        payload: { toCityId: best.city_id, toCityName: best.name_kr }
      });
    }
    if (me.ap >= 20) actions.push({ cmd: 'search', why: '탐색으로 금/재야 장수 발견', command: 'search', payload: {} });
    // Officer-only design: joining a faction via pledge is deprecated (quest-driven progression instead).
  } else {
    if (me.ap >= 10) actions.push({ cmd: 'socialize', why: '동료 장수와 친분을 쌓아 등용/임무에 도움', command: 'socialize', payload: {} });
    if (me.ap >= 10) actions.push({ cmd: 'visit', why: '동료와 교류(관시 +)', command: 'visit', payload: {} });
    if (me.ap >= 10) actions.push({ cmd: 'gift', why: '선물로 관계 강화(금 필요)', command: 'gift', payload: {} });
    if (me.ap >= 10) actions.push({ cmd: 'patrol', why: 'calm(patrol): 다음 등용/교섭 보정(안전/꾸준)', command: 'patrol', payload: {} });
    if (me.ap >= 15) actions.push({ cmd: 'banquet', why: '연회로 인맥 확대(금 필요)', command: 'banquet', payload: {} });
    actions.push({ cmd: 'cultivate', why: 'work(cultivate): 현장 지원(전공/자원) (간단/안전)', command: 'cultivate', payload: {} });
    actions.push({ cmd: 'train', why: '공적 획득(간단/안전)', command: 'train', payload: {} });
    // Officer-only design: do not surface ruler/office mechanics like governor requests.
  }

  actions.push({ cmd: 'auto_day', why: '추천 행동을 자동으로 여러 번 실행', command: 'auto_day', payload: {} });

  res.json({
    ok: true,
    me: {
      playerId: me.player_id,
      officerId: me.officer_id,
      name: me.name_kr,
      ap: me.ap,
      merit: me.merit,
      rank: me.rank,
      role: me.role,
      forceId: me.force_id,
      cityId: me.city_id,
      cityName: me.city_name
    },
    nearby: nearby.rows,
    actions
  });
});

app.get('/api/map/nearby', async (req, res) => {
  const playerId = String(req.query.playerId || '');
  if (!playerId) return res.status(400).json({ error: 'playerId is required' });

  const q = await pool.query(
    `SELECT o.city_id
     FROM players p
     JOIN officers o ON o.id = p.officer_id
     WHERE p.id = $1`,
    [playerId]
  );
  if (!q.rows.length) return res.status(404).json({ error: 'player not found' });

  const cityId = q.rows[0].city_id;
  const near = await pool.query(
    `SELECT e.to_city_id AS city_id, c.name_kr, c.owner_force_id, e.distance, e.terrain
     FROM edges e
     JOIN cities c ON c.id = e.to_city_id
     WHERE e.from_city_id = $1
     ORDER BY e.distance ASC`,
    [cityId]
  );
  res.json({ ok: true, fromCityId: cityId, nearby: near.rows });
});

app.get('/api/city/:cityId', async (req, res) => {
  const playerId = String(req.query.playerId || '');
  const { cityId } = req.params;
  if (!playerId) return res.status(400).json({ error: 'playerId is required' });

  const me = await pool.query(
    `SELECT o.city_id
     FROM players p
     JOIN officers o ON o.id = p.officer_id
     WHERE p.id = $1`,
    [playerId]
  );
  if (!me.rows.length) return res.status(404).json({ error: 'player not found' });
  const fromCityId = me.rows[0].city_id;

  // Allow calling by city name (e.g. "city 허창") for easy play.
  let resolved = null;
  try {
    resolved = await resolveCityIdByIdOrName(pool, cityId);
  } catch (err) {
    return res.status(400).json({ error: err.message || 'city resolve failed' });
  }
  if (!resolved) return res.status(404).json({ error: 'city not found' });
  const resolvedCityId = resolved.id;

  const visible =
    fromCityId === resolvedCityId ||
    (await pool.query(`SELECT 1 FROM edges WHERE from_city_id=$1 AND to_city_id=$2`, [fromCityId, resolvedCityId]))
      .rows.length > 0;

  if (!visible) return res.status(403).json({ error: 'fog: not visible (use spy)' });

  const c = await pool.query(
    `SELECT id, name_kr, owner_force_id, gold, rice, population, commerce, farming, defense
     FROM cities WHERE id = $1`,
    [resolvedCityId]
  );
  if (!c.rows.length) return res.status(404).json({ error: 'city not found' });
  res.json({ ok: true, city: c.rows[0] });
});

function rankPrivileges(rank) {
  // Lower number means higher rank.
  const canPetition = rank <= 6;
  const canGovernor = rank <= 5;
  const canViceroy = rank <= 2;
  return { canPetition, canGovernor, canViceroy };
}

async function resolveCityIdByIdOrName(client, input) {
  const raw = String(input || '').trim();
  if (!raw) return null;

  const byId = await client.query(`SELECT id, name_kr FROM cities WHERE id = $1`, [raw]);
  if (byId.rows.length) return byId.rows[0];

  const byExactName = await client.query(`SELECT id, name_kr FROM cities WHERE name_kr = $1`, [raw]);
  if (byExactName.rows.length === 1) return byExactName.rows[0];

  // Partial match fallback, but detect ambiguity to avoid "wrong city" moves.
  const byLike = await client.query(
    `SELECT id, name_kr
     FROM cities
     WHERE name_kr ILIKE $1
     ORDER BY length(name_kr) ASC
     LIMIT 6`,
    [`%${raw}%`]
  );
  if (!byLike.rows.length) return null;
  if (byLike.rows.length > 1) {
    const names = byLike.rows.slice(0, 5).map((r) => r.name_kr).join(', ');
    throw new Error(`도시명이 모호합니다: ${names}`);
  }
  return byLike.rows[0];
}

async function getJoinedPlayerForUpdate(client, playerId) {
  const joined = await client.query(
    `SELECT
       p.id AS player_id,
       o.id AS officer_id,
       o.name_kr AS officer_name,
       o.hidden_stats AS officer_hidden_stats,
       o.personality AS officer_personality,
       o.custody_status AS officer_custody_status,
       o.custody_reason AS officer_custody_reason,
       o.custody_since_daykey AS officer_custody_since_daykey,
       o.war,
       o.int_stat,
       o.pol,
       o.chr,
       o.ldr,
       o.ap,
       o.merit,
       o.fame,
       o.rank,
       o.gold AS officer_gold,
       o.inventory AS officer_inventory,
       o.equipment AS officer_equipment,
       o.level AS officer_level,
       o.xp AS officer_xp,
       o.skill_points AS officer_skill_points,
       o.unlocked_skills AS officer_unlocked_skills,
       o.equipped_skills AS officer_equipped_skills,
       o.leader_officer_id AS officer_leader_officer_id,
       o.force_id AS officer_force_id,
       o.compatibility AS officer_compatibility,
       o.role AS officer_role,
       o.title AS officer_title,
       o.city_id AS officer_city_id,
       c.id AS city_id,
       c.name_kr AS city_name,
       c.population,
       c.security AS city_security,
       c.owner_force_id AS city_owner_force_id,
       c.governor_officer_id AS city_governor_officer_id
     FROM players p
     JOIN officers o ON o.id = p.officer_id
     JOIN cities c ON c.id = o.city_id
     WHERE p.id = $1
     FOR UPDATE`,
    [playerId]
  );
  if (!joined.rows.length) throw new Error('플레이어를 찾을 수 없습니다.');
  return joined.rows[0];
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function asInt(x, fallback = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? Math.floor(n) : fallback;
}

function getHiddenStat(hidden, key, fallback = 0) {
  try {
    if (!hidden || typeof hidden !== 'object') return fallback;
    if (!(key in hidden)) return fallback;
    return asInt(hidden[key], fallback);
  } catch {
    return fallback;
  }
}

function getGameDayKey({ year, month, day }) {
  return `${asInt(year, 0)}.${asInt(month, 0)}.${asInt(day, 0)}`;
}

function parseHiddenStats(raw) {
  try {
    if (!raw) return {};
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
    return JSON.parse(String(raw));
  } catch {
    return {};
  }
}

async function updateHiddenStats(client, officerId, patch) {
  const cur = await client.query(`SELECT hidden_stats FROM officers WHERE id=$1 FOR UPDATE`, [officerId]);
  if (!cur.rows.length) return null;
  const hs0 = parseHiddenStats(cur.rows[0].hidden_stats);
  const hs = { ...hs0, ...(patch || {}) };
  await client.query(`UPDATE officers SET hidden_stats=$2::jsonb WHERE id=$1`, [officerId, JSON.stringify(hs)]);
  return hs;
}

async function bumpSuspicion(client, officerId, delta, meta = {}) {
  const cur = await client.query(`SELECT hidden_stats FROM officers WHERE id=$1 FOR UPDATE`, [officerId]);
  if (!cur.rows.length) return null;
  const hs0 = parseHiddenStats(cur.rows[0].hidden_stats);
  const next = clamp(asInt(hs0.suspicion, 0) + asInt(delta, 0), 0, 100);
  const hs = { ...hs0, suspicion: next, ...(meta || {}) };
  await client.query(`UPDATE officers SET hidden_stats=$2::jsonb WHERE id=$1`, [officerId, JSON.stringify(hs)]);
  return hs;
}

async function weaponBonusForOfficer(client, { inventory, equipment }) {
  const inv = parseInventory(inventory);
  const eq = parseEquipment(equipment);
  const weaponId = getEquippedId(eq, 'weapon') || (hasItem(inv, 'weapon_basic') ? 'weapon_basic' : null);
  if (!weaponId) return { weaponId: null, bonus: 0 };
  let bonus = 0;
  try {
    const it = await getItemById(client, weaponId);
    if (it?.effects?.kind === 'battle_attack_flat') bonus = asInt(it.effects.amount, 0);
    if (typeof it?.effects?.battle_attack_flat === 'number') bonus = asInt(it.effects.battle_attack_flat, bonus);
  } catch {
    bonus = 0;
  }
  if (weaponId === 'weapon_basic') bonus = Math.max(bonus, 2);
  return { weaponId, bonus };
}

function unitHp({ ldr, level }) {
  return 70 + asInt(ldr, 0) * 2 + asInt(level, 1) * 10;
}

function unitDamage({ war, weaponBonus, skillBonus, rand }) {
  const base = asInt(war, 0) * 0.55 + weaponBonus * 6 + skillBonus * 8;
  const swing = 0.88 + rand() * 0.28; // 0.88..1.16
  return Math.max(6, Math.floor(base * swing));
}

function parseInventory(raw) {
  try {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    // pg may decode jsonb into object/array
    if (typeof raw === 'object') return raw;
    return JSON.parse(String(raw));
  } catch {
    return [];
  }
}

function parseEquipment(raw) {
  try {
    if (!raw) return {};
    if (typeof raw === 'object') return raw;
    return JSON.parse(String(raw));
  } catch {
    return {};
  }
}

function parseJsonArray(raw) {
  try {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    if (typeof raw === 'object') return raw;
    return JSON.parse(String(raw));
  } catch {
    return [];
  }
}

function parseJsonObject(raw) {
  try {
    if (!raw) return {};
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
    return JSON.parse(String(raw));
  } catch {
    return {};
  }
}

function equippedSkillMods(row) {
  const eq = parseJsonObject(row?.officer_equipped_skills);
  const ids = Object.values(eq || {}).map((x) => String(x || '').trim()).filter(Boolean);
  const mods = { travel_discount_pct: 0, relationship_pct: 0, search_gold_pct: 0, battle_attack_flat: 0, spy_accuracy_flat: 0, fame_flat: 0 };
  for (const id of ids) {
    const def = SKILL_DEFS.find((s) => s.id === id);
    if (!def) continue;
    const e = def.effects || {};
    if (typeof e.travel_discount_pct === 'number') mods.travel_discount_pct += e.travel_discount_pct;
    if (typeof e.relationship_pct === 'number') mods.relationship_pct += e.relationship_pct;
    if (typeof e.search_gold_pct === 'number') mods.search_gold_pct += e.search_gold_pct;
    if (typeof e.battle_attack_flat === 'number') mods.battle_attack_flat += e.battle_attack_flat;
    if (typeof e.spy_accuracy_flat === 'number') mods.spy_accuracy_flat += e.spy_accuracy_flat;
    if (typeof e.fame_flat === 'number') mods.fame_flat += e.fame_flat;
  }
  // Cap some stacked effects to avoid runaway.
  mods.travel_discount_pct = clamp(mods.travel_discount_pct, 0, 0.40);
  mods.relationship_pct = clamp(mods.relationship_pct, 0, 0.60);
  mods.search_gold_pct = clamp(mods.search_gold_pct, 0, 0.60);
  mods.battle_attack_flat = clamp(mods.battle_attack_flat, 0, 12);
  mods.spy_accuracy_flat = clamp(mods.spy_accuracy_flat, 0, 25);
  mods.fame_flat = clamp(mods.fame_flat, 0, 5);
  return mods;
}

function equipSlotOf(item) {
  const slot = String(item?.slot || '').trim().toLowerCase();
  if (slot === 'weapon') return 'weapon';
  if (slot === 'mount') return 'mount';
  return null;
}

function getEquippedId(equipment, slot) {
  const eq = equipment && typeof equipment === 'object' ? equipment : {};
  const s = String(slot || '').trim().toLowerCase();
  const id = eq[s];
  return typeof id === 'string' && id.trim() ? id.trim() : null;
}

function setEquippedId(equipment, slot, itemIdOrNull) {
  const eq = equipment && typeof equipment === 'object' ? { ...equipment } : {};
  const s = String(slot || '').trim().toLowerCase();
  if (!s) return eq;
  if (itemIdOrNull == null || String(itemIdOrNull).trim() === '') {
    delete eq[s];
    return eq;
  }
  eq[s] = String(itemIdOrNull).trim();
  return eq;
}

function applyTravelDiscountFromItem(apCost, item) {
  const it = item && typeof item === 'object' ? item : null;
  const kind = String(it?.effects?.kind || '').trim();
  if (kind !== 'travel_discount') return apCost;
  const pct = Number(it.effects?.pct);
  const minAp = asInt(it.effects?.min_ap, 5);
  if (!Number.isFinite(pct) || pct <= 0) return apCost;
  const discounted = Math.floor(apCost * (1 - pct));
  return Math.max(minAp, Math.max(1, discounted));
}

function hasItem(inventory, itemId) {
  const id = String(itemId || '').trim();
  if (!id) return false;
  const inv = Array.isArray(inventory) ? inventory : [];
  return inv.some((it) => String(it?.id || '') === id);
}

function inventoryCount(inventory, itemId) {
  const id = String(itemId || '').trim();
  if (!id) return 0;
  const inv = Array.isArray(inventory) ? inventory : [];
  const it = inv.find((x) => String(x?.id || '') === id);
  return asInt(it?.qty, 0);
}

function setInventoryCount(inventory, itemId, qty) {
  const inv = Array.isArray(inventory) ? inventory.slice() : [];
  const id = String(itemId || '').trim();
  const q = asInt(qty, 0);
  const idx = inv.findIndex((x) => String(x?.id || '') === id);
  if (q <= 0) {
    if (idx >= 0) inv.splice(idx, 1);
    return inv;
  }
  if (idx >= 0) {
    inv[idx] = { ...inv[idx], qty: q };
  } else {
    inv.push({ id, qty: q });
  }
  return inv;
}

async function listShopItems(client) {
  const rows = await client.query(
    `SELECT item_id, name, type, rarity, slot, stackable, max_stack, unique_key, is_shop, description, effects, price, sell_price
     FROM items
     WHERE is_shop = TRUE
     ORDER BY
       CASE rarity WHEN 'legendary' THEN 4 WHEN 'epic' THEN 3 WHEN 'rare' THEN 2 ELSE 1 END DESC,
       price DESC,
       name ASC`
  );
  // Mark sold-out for unique items (global uniqueness).
  const uniques = rows.rows.filter((r) => r.unique_key);
  const sold = new Map(); // unique_key -> owner_officer_id
  if (uniques.length) {
    const keys = uniques.map((u) => u.unique_key);
    const hit = await client.query(`SELECT unique_key, owner_officer_id FROM unique_ownership WHERE unique_key = ANY($1::text[])`, [keys]);
    for (const h of hit.rows) sold.set(String(h.unique_key), String(h.owner_officer_id || ''));
  }
  return rows.rows.map((r) => ({
    id: r.item_id, // legacy UI
    item_id: r.item_id,
    name: r.name,
    type: r.type,
    rarity: r.rarity,
    slot: r.slot,
    stackable: r.stackable,
    max_stack: r.max_stack,
    unique_key: r.unique_key,
    soldOut: r.unique_key ? sold.has(String(r.unique_key)) : false,
    sold_out: r.unique_key ? sold.has(String(r.unique_key)) : false,
    taken_by: r.unique_key ? sold.get(String(r.unique_key)) || null : null,
    desc: r.description, // legacy UI
    description: r.description,
    effects: r.effects || {},
    price: r.price,
    sell_price: r.sell_price
  }));
}

async function getItemById(client, itemId) {
  const id = String(itemId || '').trim();
  if (!id) return null;
  const r = await client.query(
    `SELECT item_id, name, type, rarity, slot, stackable, max_stack, unique_key, is_shop, description, effects, price, sell_price
     FROM items
     WHERE item_id = $1`,
    [id]
  );
  if (!r.rows.length) return null;
  const row = r.rows[0];
  return {
    id: row.item_id,
    item_id: row.item_id,
    name: row.name,
    type: row.type,
    rarity: row.rarity,
    slot: row.slot,
    stackable: row.stackable,
    max_stack: row.max_stack,
    unique_key: row.unique_key,
    is_shop: row.is_shop,
    desc: row.description,
    description: row.description,
    effects: row.effects || {},
    price: row.price,
    sell_price: row.sell_price
  };
}

async function getWeaponBonusFlat(client, equipment, inventory) {
  // Prefer equipped weapon, but keep backward compatibility for existing inventories.
  const eq = parseEquipment(equipment);
  let weaponId = getEquippedId(eq, 'weapon');
  if (!weaponId) {
    const inv = parseInventory(inventory);
    if (hasItem(inv, 'weapon_basic')) weaponId = 'weapon_basic';
  }
  if (!weaponId) return { itemId: null, bonus: 0 };
  const it = await getItemById(client, weaponId);
  const kind = String(it?.effects?.kind || '').trim();
  if (kind !== 'battle_attack_flat') return { itemId: weaponId, bonus: 0 };
  const amount = asInt(it.effects?.amount, 0);
  return { itemId: weaponId, bonus: amount };
}

async function enrichInventory(client, rawInventory) {
  const inv = parseInventory(rawInventory);
  const ids = Array.from(new Set(inv.map((x) => String(x?.id || '').trim()).filter(Boolean)));
  if (!ids.length) return [];
  const items = await client.query(
    `SELECT item_id, name, type, rarity, slot, stackable, max_stack, unique_key, description, effects, price, sell_price
     FROM items
     WHERE item_id = ANY($1::text[])`,
    [ids]
  );
  const map = new Map(items.rows.map((x) => [String(x.item_id), x]));
  return inv
    .map((x) => {
      const id = String(x?.id || '').trim();
      const qty = asInt(x?.qty, 0);
      if (!id || qty <= 0) return null;
      const it = map.get(id);
      return {
        id,
        qty,
        item: it
          ? {
              item_id: it.item_id,
              name: it.name,
              type: it.type,
              rarity: it.rarity,
              slot: it.slot,
              stackable: !!it.stackable,
              max_stack: asInt(it.max_stack, 99),
              unique_key: it.unique_key,
              description: it.description,
              effects: it.effects || {},
              price: asInt(it.price, 0),
              sell_price: asInt(it.sell_price, 0)
            }
          : {
              item_id: id,
              name: id,
              type: 'unknown',
              rarity: 'common',
              slot: null,
              stackable: true,
              max_stack: 999,
              unique_key: null,
              description: '(알 수 없는 아이템)',
              effects: {},
              price: 0,
              sell_price: 0
            }
      };
    })
    .filter(Boolean);
}

async function getStoryState(client, officerId) {
  const st = await client.query(`SELECT chapter, objective, flags FROM story_states WHERE officer_id=$1`, [officerId]);
  return {
    chapter: st.rows[0]?.chapter ?? 1,
    objective: st.rows[0]?.objective ?? '',
    flags: st.rows[0]?.flags ?? {}
  };
}

async function grantGoldOnce(client, { officerId, flags, rewardKey, amount, reason }) {
  const key = String(rewardKey || '').trim();
  const gold = asInt(amount, 0);
  if (!key || gold <= 0) return { ok: true, granted: false };
  const f = flags && typeof flags === 'object' ? flags : {};
  if (f[key] === true) return { ok: true, granted: false };

  await client.query(`UPDATE officers SET gold = gold + $1 WHERE id = $2`, [gold, officerId]);
  const nextFlags = { ...f, [key]: true };
  await client.query(
    `UPDATE story_states SET flags = $2::jsonb, updated_at = now() WHERE officer_id = $1`,
    [officerId, JSON.stringify(nextFlags)]
  );

  const summary = `보상 획득: GOLD +${gold} (${String(reason || '퀘스트')})`;
  // Reward logs are deterministic; skip LLM narration.
  await client.query(
    `INSERT INTO biography_logs (officer_id, event_type, event_data)
     VALUES ($1, $2, $3)`,
    [officerId, 'reward', { summary, gold, rewardKey: key, reason: String(reason || '') }]
  );

  return { ok: true, granted: true, gold, summary, flags: nextFlags };
}

async function grantFameOnce(client, { officerId, flags, rewardKey, amount, reason }) {
  const key = String(rewardKey || '').trim();
  const fame = asInt(amount, 0);
  if (!key || fame <= 0) return { ok: true, granted: false };
  const f = flags && typeof flags === 'object' ? flags : {};
  if (f[key] === true) return { ok: true, granted: false };

  await client.query(`UPDATE officers SET fame = fame + $1 WHERE id = $2`, [fame, officerId]);
  const nextFlags = { ...f, [key]: true };
  await client.query(
    `UPDATE story_states SET flags = $2::jsonb, updated_at = now() WHERE officer_id = $1`,
    [officerId, JSON.stringify(nextFlags)]
  );

  const summary = `명성 상승: FAME +${fame} (${String(reason || '업적')})`;
  await client.query(
    `INSERT INTO biography_logs (officer_id, event_type, event_data)
     VALUES ($1, $2, $3)`,
    [officerId, 'fame', { summary, fame, rewardKey: key, reason: String(reason || '') }]
  );

  return { ok: true, granted: true, fame, summary, flags: nextFlags };
}

async function grantItemOnce(client, { officerId, flags, rewardKey, itemId, qty, reason }) {
  const key = String(rewardKey || '').trim();
  const id = String(itemId || '').trim();
  const q = asInt(qty, 0);
  if (!key || !id || q <= 0) return { ok: true, granted: false };
  const f = flags && typeof flags === 'object' ? flags : {};
  if (f[key] === true) return { ok: true, granted: false };

  const meta = await client.query(`SELECT name, stackable, max_stack FROM items WHERE item_id=$1 LIMIT 1`, [id]);
  const itemName = String(meta.rows[0]?.name || id);
  const stackable = meta.rows.length ? !!meta.rows[0].stackable : true;
  const maxStack = meta.rows.length ? asInt(meta.rows[0].max_stack, 99) : 99;

  // Lock officer row so inventory updates are safe inside the tx.
  const cur = await client.query(`SELECT name_kr, inventory FROM officers WHERE id=$1 FOR UPDATE`, [officerId]);
  if (!cur.rows.length) return { ok: false, error: 'officer not found' };
  const name = cur.rows[0].name_kr || '장수';
  const inv0 = parseInventory(cur.rows[0].inventory);
  const curQty = inventoryCount(inv0, id);
  let addQty = q;
  if (!stackable) {
    if (curQty > 0) {
      // Still consume reward key to prevent repeated attempts.
      const nextFlags = { ...f, [key]: true };
      await client.query(`UPDATE story_states SET flags=$2::jsonb, updated_at=now() WHERE officer_id=$1`, [
        officerId,
        JSON.stringify(nextFlags)
      ]);
      return { ok: true, granted: false, itemId: id, qty: 0, itemName, flags: nextFlags };
    }
    addQty = 1;
  } else {
    const cap = Math.max(1, maxStack);
    if (curQty >= cap) {
      const nextFlags = { ...f, [key]: true };
      await client.query(`UPDATE story_states SET flags=$2::jsonb, updated_at=now() WHERE officer_id=$1`, [
        officerId,
        JSON.stringify(nextFlags)
      ]);
      return { ok: true, granted: false, itemId: id, qty: 0, itemName, flags: nextFlags };
    }
    addQty = Math.min(addQty, cap - curQty);
  }
  const next = setInventoryCount(inv0, id, curQty + addQty);
  await client.query(`UPDATE officers SET inventory=$2::jsonb WHERE id=$1`, [officerId, JSON.stringify(next)]);

  const st = await getStoryState(client, officerId);
  const nextFlags = { ...f, [key]: true };
  await client.query(
    `INSERT INTO story_states (officer_id, chapter, objective, flags, updated_at)
     VALUES ($1,$2,$3,$4::jsonb, now())
     ON CONFLICT (officer_id) DO UPDATE
     SET flags=$4::jsonb, updated_at=now()`,
    [officerId, st.chapter || 1, st.objective || '', JSON.stringify(nextFlags)]
  );

  const summary = `획득: ${itemName} x${addQty} (${String(reason || '보상')})`;
  const bio = await client.query(
    `INSERT INTO biography_logs (officer_id, event_type, event_data)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [officerId, 'loot', { summary, itemId: id, qty: addQty, itemName }]
  );
  const bioLogId = bio.rows[0]?.id || null;
  // Narrate loot lightly (keeps it fun but deterministic outcome remains the same).
  await biographyQueue.add('narrate', {
    bioLogId,
    officerId,
    actor: name,
    actorRole: 'officer',
    target: null,
    command: 'loot',
    summary
  });

  return { ok: true, granted: true, itemId: id, qty: addQty, itemName, summary, flags: nextFlags, inventory: next };
}

function endingCandidates() {
  return [
    { id: 'warlike', name: '명장', desc: '전공과 무용으로 이름을 떨침' },
    { id: 'strategist', name: '책사', desc: '정보/계략으로 판을 뒤집음' },
    { id: 'loyal', name: '충의', desc: '인연과 의리를 끝까지 지킴' },
    { id: 'wanderer', name: '유랑', desc: '세력에 얽매이지 않고 난세를 횡단' },
    { id: 'survivor', name: '생환', desc: '끝까지 살아남아 은퇴/생환' }
  ];
}

async function finalizeArc190Ending(client, { officerId }) {
  const st = await getStoryState(client, officerId);
  const flags = st.flags || {};
  if (flags.arc190_ending && typeof flags.arc190_ending === 'object') return { ok: true, already: true, flags };

  const o = await client.query(
    `SELECT id, name_kr, war, int_stat, pol, chr, ldr, merit, fame, force_id, city_id
     FROM officers
     WHERE id=$1`,
    [officerId]
  );
  if (!o.rows.length) return { ok: false, error: 'officer not found' };
  const me = o.rows[0];

  const counts = await client.query(
    `SELECT
       COUNT(*) FILTER (WHERE event_type='travel')::int AS travel_cnt,
       COUNT(*) FILTER (WHERE event_type='spy')::int AS spy_cnt,
       COUNT(*) FILTER (WHERE event_type='socialize')::int AS socialize_cnt,
       COUNT(*) FILTER (WHERE event_type='visit')::int AS visit_cnt,
       COUNT(*) FILTER (WHERE event_type='gift')::int AS gift_cnt,
       COUNT(*) FILTER (WHERE event_type='banquet')::int AS banquet_cnt,
       COUNT(*) FILTER (WHERE event_type='employ')::int AS employ_cnt,
       COUNT(*) FILTER (WHERE event_type='next')::int AS next_cnt
     FROM biography_logs
     WHERE officer_id=$1`,
    [officerId]
  );
  const c = counts.rows[0] || {};

  const rel = await client.query(
    `SELECT
       COALESCE(MAX(affinity_score), 0)::int AS best_affinity,
       COUNT(*) FILTER (WHERE affinity_score >= 30)::int AS friend_cnt
     FROM relationships
     WHERE source_officer_id=$1 AND rel_type='Acquaintance'`,
    [officerId]
  );
  const r = rel.rows[0] || { best_affinity: 0, friend_cnt: 0 };

  const uniqCities = await client.query(
    `SELECT COUNT(*)::int AS cnt
     FROM (
       SELECT DISTINCT NULLIF(event_data->'payload'->>'toCityId','') AS cid
       FROM biography_logs
       WHERE officer_id=$1 AND event_type='travel'
     ) t
     WHERE cid IS NOT NULL`,
    [officerId]
  );
  const uniqueCityCnt = uniqCities.rows[0]?.cnt ?? 0;

  const merit = asInt(me.merit, 0);
  const fame = asInt(me.fame, 0);
  const war = asInt(me.war, 0);
  const ldr = asInt(me.ldr, 0);
  const intl = asInt(me.int_stat, 0);
  const pol = asInt(me.pol, 0);
  const cha = asInt(me.chr, 0);

  const scores = {
    warlike: Math.floor(merit * 0.25 + fame * 1.2 + war * 12 + ldr * 8),
    strategist: Math.floor(fame * 1.6 + intl * 12 + pol * 8 + asInt(c.spy_cnt, 0) * 20),
    loyal: Math.floor(fame * 1.0 + cha * 10 + asInt(r.best_affinity, 0) * 4 + asInt(r.friend_cnt, 0) * 30),
    wanderer: Math.floor(fame * 0.9 + asInt(c.travel_cnt, 0) * 25 + uniqueCityCnt * 40),
    survivor: Math.floor(fame * 0.7 + asInt(c.next_cnt, 0) * 12 + merit * 0.1)
  };

  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0] || ['survivor', 0];
  const endingId = best[0];
  const endingMeta = endingCandidates().find((x) => x.id === endingId) || endingCandidates()[0];

  const ending = {
    arc: '190_anti_dong_zhuo',
    endingId,
    endingName: endingMeta.name,
    endingDesc: endingMeta.desc,
    scores,
    snapshot: {
      war,
      ldr,
      int: intl,
      pol,
      chr: cha,
      merit,
      fame,
      travel_cnt: asInt(c.travel_cnt, 0),
      spy_cnt: asInt(c.spy_cnt, 0),
      friend_cnt: asInt(r.friend_cnt, 0),
      best_affinity: asInt(r.best_affinity, 0),
      unique_city_cnt: uniqueCityCnt
    }
  };

  const nextFlags = { ...flags, arc190_ended: true, arc190_finalized: true, arc190_ending: ending };
  await client.query(
    `UPDATE story_states SET flags=$2::jsonb, updated_at=now() WHERE officer_id=$1`,
    [officerId, JSON.stringify(nextFlags)]
  );

  const summary = `[챕터 종료] 연합 해산: ${me.name_kr}의 열전 결말은 '${endingMeta.name}'로 기록된다.`;
  const bio = await client.query(
    `INSERT INTO biography_logs (officer_id, event_type, event_data)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [officerId, 'chapter_end', { summary, ending }]
  );
  const bioLogId = bio.rows[0]?.id || null;
  await biographyQueue.add('narrate', {
    bioLogId,
    officerId,
    actor: me.name_kr,
    actorRole: 'officer',
    target: null,
    command: 'chapter_end',
    summary
  });

  return { ok: true, ending, flags: nextFlags };
}

function nextRoninStep(prevStep, command) {
  const step = asInt(prevStep, 0);
  if (step <= 0 && (command === 'socialize' || command === 'visit')) return 1;
  if (step === 1 && (command === 'patrol' || command === 'search')) return 2;
  if (step === 2 && command === 'travel') return 3;
  if (step === 3 && command === 'employ') return 4;
  return step;
}

function computeStoryObjective({ forceId, role, merit, rank, ambition, roninStep, arc190Stage }) {
  // Officer-centric, easy progression objectives.
  const a190 = asInt(arc190Stage, 0);
  if (forceId === 'ronin') {
    const step = asInt(roninStep, 0);
    if (step <= 0) {
      return {
        chapter: 1,
        step,
        objective: '주막에서 socialize 또는 visit으로 사람을 만나 인맥을 만드세요.'
      };
    }
    if (step === 1) {
      return {
        chapter: 1,
        step,
        objective: 'calm(patrol) 또는 search로 기반을 다지세요. (평판/자금/정보 확보)'
      };
    }
    if (step === 2) {
      return {
        chapter: 1,
        step,
        objective: 'map_nearby를 보고 인접 도시로 travel 해 보세요. (기회 찾기)'
      };
    }
    if (step === 3) {
      const hint =
        ambition >= 70
          ? '야망이 크다면 빠르게 동료를 만들어(등용) 선택지를 넓히는 편이 유리합니다.'
          : '재야 장수 등용(employ)으로 동료를 만들 수 있습니다.';
      return {
        chapter: 1,
        step,
        objective: `다음 선택: 동료 만들기(등용: employ). ${hint}`
      };
    }
    // After first career choice: guide into the 190 arc.
    if (a190 < 1) return { chapter: 2, step, objective: '190년의 소문이 중원에 번진다. 먼저 [완]으로 이동해 소문의 근원을 잡으세요. (travel 완)' };
    if (a190 === 1) return { chapter: 2, step, objective: '완에서 낙양의 동향을 캐내세요. (spy 낙양)' };
    if (a190 === 2) return { chapter: 2, step, objective: '결정적인 소문을 확인했습니다. 직접 [낙양]으로 가서 상황을 보세요. (travel 낙양)' };
    if (a190 >= 4) {
      return {
        chapter: 3,
        step,
        objective: '챕터 종료: 연합은 해산했다. story로 열전을 확인하고, 다음 장(군웅할거)으로 넘어갈 준비를 하세요.'
      };
    }
    return {
      chapter: 3,
      step,
      objective: '낙양에 도착했습니다. 인맥을 넓히고(socialize), 동료를 늘리세요(employ). 작은 에피소드 선택지도 자주 뜹니다.'
    };
  }

  // 190 arc is also available for non-ronin players (officer viewpoint): a simple intel run.
  if (a190 < 1) return { chapter: 2, step: 0, objective: '190년의 큰 소문: 낙양. 먼저 [완]으로 이동해 동향을 잡으세요. (travel 완)' };
  if (a190 === 1) return { chapter: 2, step: 0, objective: '완에서 낙양의 동향을 캐내세요. (spy 낙양)' };
  if (a190 === 2) return { chapter: 2, step: 0, objective: '결정적인 소문을 확인했습니다. 직접 [낙양]으로 가서 상황을 보세요. (travel 낙양)' };
  if (a190 >= 4) {
    return { chapter: 3, step: 0, objective: '챕터 종료: 연합은 해산했다. story로 열전을 확인하고, 다음 장(군웅할거)으로 넘어갈 준비를 하세요.' };
  }

  if (merit < 1000) {
    return { chapter: 2, step: 0, objective: '공적 1,000을 모아 8품관을 달성하세요. (추천: cultivate/train 또는 auto_day)' };
  }
  if (rank > 5) {
    return { chapter: 3, step: 0, objective: '공적 10,000을 목표로 성장하세요. (인맥은 socialize/visit/gift)' };
  }
  return { chapter: 4, step: 0, objective: '이동(travel)과 정찰(spy)로 전장을 찾아 전공을 쌓으세요.' };
}

const UNIQUE_QUEST_DEFS = [
  {
    key: 'red_hare',
    title: '명마: 적토',
    itemId: 'mount_red_hare',
    uniqueKey: 'red_hare',
    // Keep "easy": piggyback on the 190 arc path (players already travel to Luoyang).
    cityId: 'luo_yang',
    unlock: { fame: 10, arc190Stage: 1 },
    costGold: 2500,
    stages: [
      { stage: 1, text: '낙양으로 이동하라. (travel 낙양)', on: { cmd: 'travel', cityId: 'luo_yang' } },
      { stage: 2, text: '낙양에서 소문을 더 캐라. (search)', on: { cmd: 'search', cityId: 'luo_yang' } },
      { stage: 3, text: '흑시장 거래로 확보하라. (deal red_hare)', on: { cmd: 'deal', cityId: 'luo_yang' } }
    ]
  },
  {
    key: 'qinggang',
    title: '명검: 청강',
    itemId: 'weapon_qinggang',
    uniqueKey: 'qinggang',
    // Keep "easy": piggyback on the 190 arc path (Wan -> spy Luoyang).
    cityId: 'wan',
    unlock: { fame: 12, merit: 500, arc190Stage: 2 },
    costGold: 2200,
    stages: [
      { stage: 1, text: '완으로 이동하라. (travel 완)', on: { cmd: 'travel', cityId: 'wan' } },
      { stage: 2, text: '완에서 단서를 찾자. (socialize 또는 search)', on: { cmdAny: ['socialize', 'search'], cityId: 'wan' } },
      { stage: 3, text: '암거래로 확보하라. (deal qinggang)', on: { cmd: 'deal', cityId: 'wan' } }
    ]
  }
];

function uqGet(flags, key) {
  const f = flags && typeof flags === 'object' ? flags : {};
  const uq = f.unique_quests && typeof f.unique_quests === 'object' ? f.unique_quests : {};
  const st = uq[key] && typeof uq[key] === 'object' ? uq[key] : null;
  if (!st) return { stage: 0, active: false, done: false };
  return {
    stage: asInt(st.stage, 0),
    active: st.active === true,
    done: st.done === true
  };
}

function uqSet(flags, key, next) {
  const f = flags && typeof flags === 'object' ? flags : {};
  const uq0 = f.unique_quests && typeof f.unique_quests === 'object' ? f.unique_quests : {};
  const uq1 = { ...uq0, [key]: { ...uqGet(f, key), ...(next || {}), updated_at: new Date().toISOString() } };
  return { ...f, unique_quests: uq1 };
}

async function isUniqueTaken(client, uniqueKey) {
  const key = String(uniqueKey || '').trim();
  if (!key) return false;
  const r = await client.query(`SELECT owner_officer_id FROM unique_ownership WHERE unique_key=$1 LIMIT 1`, [key]);
  return r.rows.length > 0;
}

async function bestAffinityInCity(client, { sourceOfficerId, cityId }) {
  const s = String(sourceOfficerId || '').trim();
  const c = String(cityId || '').trim();
  if (!s || !c) return { best: 0, target: null };
  const r = await client.query(
    `SELECT o.id, o.name_kr, r.affinity_score
     FROM relationships r
     JOIN officers o ON o.id = r.target_officer_id
     WHERE r.source_officer_id=$1 AND r.rel_type='Acquaintance' AND o.city_id=$2
     ORDER BY r.affinity_score DESC
     LIMIT 1`,
    [s, c]
  );
  if (!r.rows.length) return { best: 0, target: null };
  return { best: asInt(r.rows[0].affinity_score, 0), target: { id: r.rows[0].id, name_kr: r.rows[0].name_kr } };
}

async function grantUniqueEquipmentOnce(client, { officerId, flags, rewardKey, itemId, reason }) {
  const key = String(rewardKey || '').trim();
  const id = String(itemId || '').trim();
  if (!key || !id) return { ok: true, granted: false, flags: flags || {} };
  const f = flags && typeof flags === 'object' ? flags : {};
  if (f[key] === true) return { ok: true, granted: false, flags: f };

  const it = await getItemById(client, id);
  if (!it) throw new Error('알 수 없는 아이템입니다.');
  if (it.type !== 'equipment') throw new Error('유니크 보상은 장비만 지원합니다.');
  if (!it.unique_key) throw new Error('유니크 키가 없는 아이템입니다.');

  const owned = await client.query(`SELECT owner_officer_id FROM unique_ownership WHERE unique_key=$1 LIMIT 1`, [it.unique_key]);
  const owner = owned.rows[0]?.owner_officer_id ? String(owned.rows[0].owner_officer_id) : null;
  if (owner && owner !== String(officerId)) throw new Error('해당 유니크 아이템은 이미 다른 누군가가 보유 중입니다.');
  if (!owner) {
    await client.query(
      `INSERT INTO unique_ownership (unique_key, item_id, owner_officer_id)
       VALUES ($1,$2,$3)
       ON CONFLICT (unique_key) DO NOTHING`,
      [it.unique_key, it.item_id, officerId]
    );
  }

  const cur = await client.query(`SELECT name_kr, inventory, equipment FROM officers WHERE id=$1 FOR UPDATE`, [officerId]);
  if (!cur.rows.length) throw new Error('officer not found');
  const inv0 = parseInventory(cur.rows[0].inventory);
  let inv = inv0;
  if (!hasItem(inv0, id)) inv = setInventoryCount(inv0, id, 1);

  const eq0 = parseEquipment(cur.rows[0].equipment);
  const slot = equipSlotOf(it);
  const eq = slot && !getEquippedId(eq0, slot) ? setEquippedId(eq0, slot, id) : eq0;

  await client.query(`UPDATE officers SET inventory=$2::jsonb, equipment=$3::jsonb WHERE id=$1`, [
    officerId,
    JSON.stringify(inv),
    JSON.stringify(eq)
  ]);

  const nextFlags = { ...f, [key]: true };
  await client.query(`UPDATE story_states SET flags=$2::jsonb, updated_at=now() WHERE officer_id=$1`, [
    officerId,
    JSON.stringify(nextFlags)
  ]);

  const summary = `유니크 획득: ${it.name} (${String(reason || '퀘스트')})`;
  await client.query(
    `INSERT INTO biography_logs (officer_id, event_type, event_data)
     VALUES ($1, $2, $3)`,
    [officerId, 'loot', { summary, itemId: id, itemName: it.name, qty: 1, unique_key: it.unique_key, reason: String(reason || '') }]
  );

  return { ok: true, granted: true, itemId: id, itemName: it.name, flags: nextFlags, inventory: inv, equipment: eq, summary };
}

async function updateStoryAfterCommand(client, { officerId, command, payload, extra, forceId, role, merit, rank, prevRank, ambition }) {
  const st = await getStoryState(client, officerId);
  const flags = st.flags || {};
  const prevStep = asInt(flags.story_step, 0);
  const nextStep = forceId === 'ronin' ? nextRoninStep(prevStep, command) : 0;

  let nextArc190 = asInt(flags.arc190_stage, 0);
  // Stage advancement uses explicit commands (easy + deterministic).
  if (command === 'travel') {
    const to = String(payload?.toCityId || payload?.toCityName || extra?.toCityId || extra?.toCityName || '').trim();
    if (to === 'wan' || to.includes('완')) nextArc190 = Math.max(nextArc190, 1);
    if (to === 'luo_yang' || to.includes('낙양')) nextArc190 = Math.max(nextArc190, 3);
  }
  if (command === 'spy') {
    const to = String(payload?.toCityId || payload?.toCityName || extra?.intel?.cityId || extra?.intel?.name || '').trim();
    if (to === 'luo_yang' || to.includes('낙양')) nextArc190 = Math.max(nextArc190, 2);
  }

  // Chapter end trigger: after reaching Luoyang (stage 3), passing a day finalizes the arc.
  if (command === 'end_turn') {
    const loc = await client.query(`SELECT city_id FROM officers WHERE id=$1`, [officerId]);
    const cityId = String(loc.rows[0]?.city_id || '');
    if (cityId === 'luo_yang' && nextArc190 >= 3) nextArc190 = Math.max(nextArc190, 4);
  }

  let nextFlags = { ...flags, story_step: nextStep, arc190_stage: nextArc190, arc_id: flags.arc_id || '190_anti_dong_zhuo' };

  // Scout mini-quest progression (officer-centric):
  // stage 1: accept offer -> do one "contact" action (socialize/visit/gift) to confirm
  // stage 2: decision is surfaced via episode: scout_join / scout_backout
  try {
    const sc = nextFlags.scout_offer && typeof nextFlags.scout_offer === 'object' ? nextFlags.scout_offer : null;
    const stage = sc ? asInt(sc.stage, 0) : 0;
    if (sc && stage === 1 && ['socialize', 'visit', 'gift'].includes(String(command || ''))) {
      nextFlags = { ...nextFlags, scout_offer: { ...sc, stage: 2, met_at: new Date().toISOString() } };
      await client.query(`INSERT INTO biography_logs (officer_id, event_type, event_data) VALUES ($1,$2,$3)`, [
        officerId,
        'quest',
        { summary: `비밀 접선 완료: ${String(sc.to_name || sc.to || '')}`, questKey: 'scout', stage: 2, to: sc.to }
      ]);
    }
  } catch {
    // ignore
  }

  // Unique quest activation/progression (deterministic, officer-centric).
  try {
    const off = await client.query(`SELECT city_id, fame, merit FROM officers WHERE id=$1`, [officerId]);
    const cityIdNow = String(off.rows[0]?.city_id || '');
    const fameNow = asInt(off.rows[0]?.fame, 0);
    const meritNow = asInt(off.rows[0]?.merit, 0);
    for (const q of UNIQUE_QUEST_DEFS) {
      const cur = uqGet(nextFlags, q.key);
      if (cur.done) continue;
      // unlock gating
      const needFame = asInt(q.unlock?.fame, 0);
      const needMerit = asInt(q.unlock?.merit, 0);
      const needArc = asInt(q.unlock?.arc190Stage, 0);
      if (fameNow < needFame) continue;
      if (meritNow < needMerit) continue;
      if (asInt(nextArc190, 0) < needArc) continue;
      if (await isUniqueTaken(client, q.uniqueKey)) continue;
      // auto-activate once
      if (!cur.active && cur.stage <= 0) {
        nextFlags = uqSet(nextFlags, q.key, { stage: 1, active: true, done: false });
        await client.query(
          `INSERT INTO biography_logs (officer_id, event_type, event_data)
           VALUES ($1,$2,$3)`,
          [officerId, 'quest', { summary: `유니크 소문: ${q.title} (진행 시작)`, questKey: q.key, stage: 1 }]
        );
      }

      const now = uqGet(nextFlags, q.key);
      if (!now.active || now.done) continue;

      // Stage advancement: relies on post-command city_id (already updated in officers table).
      if (now.stage === 1 && command === 'travel' && cityIdNow === q.cityId) {
        nextFlags = uqSet(nextFlags, q.key, { stage: 2 });
        await client.query(`INSERT INTO biography_logs (officer_id, event_type, event_data) VALUES ($1,$2,$3)`, [
          officerId,
          'quest',
          { summary: `단서 확보: ${q.title} (1/3)`, questKey: q.key, stage: 2 }
        ]);
      } else if (now.stage === 2 && command === 'search' && cityIdNow === q.cityId) {
        nextFlags = uqSet(nextFlags, q.key, { stage: 3 });
        await client.query(`INSERT INTO biography_logs (officer_id, event_type, event_data) VALUES ($1,$2,$3)`, [
          officerId,
          'quest',
          { summary: `거래선 포착: ${q.title} (2/3)`, questKey: q.key, stage: 3 }
        ]);
      } else if (
        now.stage === 2 &&
        Array.isArray(q.stages?.[1]?.on?.cmdAny) &&
        q.stages[1].on.cmdAny.includes(String(command || '')) &&
        cityIdNow === q.cityId
      ) {
        nextFlags = uqSet(nextFlags, q.key, { stage: 3 });
        await client.query(`INSERT INTO biography_logs (officer_id, event_type, event_data) VALUES ($1,$2,$3)`, [
          officerId,
          'quest',
          { summary: `거래선 포착: ${q.title} (2/3)`, questKey: q.key, stage: 3 }
        ]);
      }
    }
  } catch {
    // Never block main loop on quest helper failures.
  }

  // Resolve pending "small episode" if the player executes one of the offered verbs.
  // Episodes are officer-centric: small personal choices, rewards are deterministic.
  try {
    const pe = nextFlags.pending_episode && typeof nextFlags.pending_episode === 'object' ? nextFlags.pending_episode : null;
    if (pe && Array.isArray(pe.options) && pe.options.length && pe.resolved !== true) {
      const verb = String(command || '').trim();
      const cmdLine = String(command || '').trim();
      const hit =
        pe.options.find((o) => String(o?.cmd || '').trim() === cmdLine) ||
        pe.options.find((o) => String(o?.verb || '').trim() === verb) ||
        null;
      if (hit) {
        const episodeId = String(pe.id || '').trim();
        const choiceId = String(hit.id || verb).trim();
        const rewardKey = episodeId ? `episode_done_${episodeId}` : '';

        // Reward: small fame/gold bumps; never "lord-ish".
        const fame = asInt(hit?.reward?.fame, 0);
        const gold = asInt(hit?.reward?.gold, 0);
        if (gold > 0 && rewardKey) {
          const r = await grantGoldOnce(client, {
            officerId,
            flags: nextFlags,
            rewardKey,
            amount: gold,
            reason: '에피소드 선택'
          });
          if (r?.flags) nextFlags = r.flags;
        }
        if (fame > 0 && rewardKey) {
          const r = await grantFameOnce(client, {
            officerId,
            flags: nextFlags,
            rewardKey: `${rewardKey}_f`,
            amount: fame,
            reason: '에피소드 선택'
          });
          if (r?.flags) nextFlags = r.flags;
        }

        // Deterministic item drop (common consumables only).
        // This gives a "growth feel" without adding complexity/imbalance.
        if (rewardKey) {
          const seed = sha256Hex(`drop|${officerId}|${episodeId}|${choiceId}`).slice(0, 8);
          const roll = parseInt(seed, 16) / 0xffffffff;
          const v = String(hit?.verb || verb);
          let chance = 0.0;
          let dropId = null;
          let dropQty = 1;
          if (v === 'search') {
            chance = 0.70;
            dropId = 'med_small';
          } else if (v === 'rest') {
            chance = 0.25;
            dropId = 'med_tiny';
          } else {
            chance = 0.45;
            dropId = 'med_tiny';
          }
          if (dropId && roll < chance) {
            const r = await grantItemOnce(client, {
              officerId,
              flags: nextFlags,
              rewardKey: `${rewardKey}_item`,
              itemId: dropId,
              qty: dropQty,
              reason: '에피소드 보상'
            });
            if (r?.flags) nextFlags = r.flags;
            // Attach to episode for UI/AI consistency.
            if (r?.granted) {
              const prevEp = nextFlags.pending_episode && typeof nextFlags.pending_episode === 'object' ? nextFlags.pending_episode : pe;
              const prevDrops = Array.isArray(prevEp.drops) ? prevEp.drops : [];
              nextFlags.pending_episode = { ...prevEp, drops: prevDrops.concat([{ itemId: dropId, qty: r.qty }]).slice(0, 4) };
            }
          }

          // Very-low chance equipment drop (common only). Still deterministic; no farming.
          const seed2 = sha256Hex(`equip|${officerId}|${episodeId}|${choiceId}`).slice(0, 8);
          const roll2 = parseInt(seed2, 16) / 0xffffffff;
          let eqChance = 0.0;
          if (v === 'search') eqChance = 0.04;
          else if (v === 'rest') eqChance = 0.02;
          else if (v === 'recruit_rumor') eqChance = 0.03;
          else eqChance = 0.06;
          if (roll2 < eqChance) {
            const eqId = 'weapon_basic';
            const r2 = await grantItemOnce(client, {
              officerId,
              flags: nextFlags,
              rewardKey: `${rewardKey}_equip`,
              itemId: eqId,
              qty: 1,
              reason: '에피소드 발견'
            });
            if (r2?.flags) nextFlags = r2.flags;
            if (r2?.granted) {
              const prevEp = nextFlags.pending_episode && typeof nextFlags.pending_episode === 'object' ? nextFlags.pending_episode : pe;
              const prevDrops = Array.isArray(prevEp.drops) ? prevEp.drops : [];
              nextFlags.pending_episode = { ...prevEp, drops: prevDrops.concat([{ itemId: eqId, qty: r2.qty }]).slice(0, 4) };
            }
          }
        }

        // Mark resolved and log result (so UI/AI can render a coherent branch).
        const prevEp = nextFlags.pending_episode && typeof nextFlags.pending_episode === 'object' ? nextFlags.pending_episode : pe;
        nextFlags.pending_episode = { ...prevEp, resolved: true, resolved_at: new Date().toISOString(), choice: choiceId };
        await client.query(
          `UPDATE story_states SET flags=$2::jsonb, updated_at=now() WHERE officer_id=$1`,
          [officerId, JSON.stringify(nextFlags)]
        );
        const summary = `작은 선택: ${String(pe.title || '에피소드')} -> ${String(hit.label || hit.verb || choiceId)}`;
        const bio = await client.query(
          `INSERT INTO biography_logs (officer_id, event_type, event_data)
           VALUES ($1, $2, $3)
           RETURNING id`,
          [officerId, 'episode_resolve', { summary, episode: { ...pe, ...(nextFlags.pending_episode || {}) }, choice: hit }]
        );
        const bioLogId = bio.rows[0]?.id || null;
        await biographyQueue.add('narrate', {
          bioLogId,
          officerId,
          actor: (await client.query(`SELECT name_kr FROM officers WHERE id=$1`, [officerId])).rows[0]?.name_kr || '장수',
          actorRole: role || 'officer',
          target: null,
          command: 'episode_resolve',
          summary
        });
      }
    }
  } catch {
    // ignore episode resolution failures (never break main progression)
  }

  // Prefer DB-driven objective for the current arc stage if available.
  let arcObjective = '';
  try {
    if (nextArc190 > 0) {
      const beat = await client.query(`SELECT objective FROM story_beats WHERE arc_id=$1 AND stage=$2`, [
        '190_anti_dong_zhuo',
        nextArc190
      ]);
      arcObjective = String(beat.rows[0]?.objective || '').trim();
    }
  } catch {
    arcObjective = '';
  }

  let computed = computeStoryObjective({ forceId, role, merit, rank, ambition, roninStep: nextStep, arc190Stage: nextArc190 });
  if (arcObjective) {
    computed = { ...computed, objective: arcObjective, chapter: Math.max(2, asInt(computed.chapter, 2)) };
  }
  if (nextArc190 >= 4) {
    computed = {
      ...computed,
      chapter: Math.max(3, asInt(computed.chapter, 3)),
      objective: '챕터 종료: 연합은 해산했다. story로 열전을 확인하고, 다음 장(군웅할거)으로 넘어갈 준비를 하세요.'
    };
    nextFlags.arc190_ended = true;
  }
  await client.query(
    `INSERT INTO story_states (officer_id, chapter, objective, flags, updated_at)
     VALUES ($1,$2,$3,$4::jsonb, now())
     ON CONFLICT (officer_id) DO UPDATE
     SET chapter=$2, objective=$3, flags=$4::jsonb, updated_at=now()`,
    [officerId, computed.chapter, computed.objective, JSON.stringify(nextFlags)]
  );

  // Quest rewards: add personal GOLD on milestone completion.
  let reward = null;
  if (forceId === 'ronin' && nextStep > prevStep) {
    const stepRewards = { 1: 120, 2: 180, 3: 220, 4: 300 };
    const amt = stepRewards[nextStep] || 0;
    const r = await grantGoldOnce(client, {
      officerId,
      flags: nextFlags,
      rewardKey: `reward_ronin_step_${nextStep}`,
      amount: amt,
      reason: `재야 단계 ${nextStep} 달성`
    });
    if (r?.granted) reward = { type: 'gold', gold: r.gold, summary: r.summary };
  }

  // Arc 190 milestone rewards (all roles): Wan -> Spy Luoyang -> Enter Luoyang.
  const prevArc190 = asInt(flags.arc190_stage, 0);
  if (nextArc190 > prevArc190) {
    const arcRewards = { 1: 200, 2: 260, 3: 380 };
    const amt = arcRewards[nextArc190] || 0;
    const r = await grantGoldOnce(client, {
      officerId,
      flags: nextFlags,
      rewardKey: `reward_arc190_${nextArc190}`,
      amount: amt,
      reason: `190년 소문 추적 ${nextArc190}/3`
    });
    if (r?.granted) reward = { type: 'gold', gold: r.gold, summary: r.summary };

    const fameRewards = { 1: 2, 2: 3, 3: 4, 4: 12 };
    const fam = fameRewards[nextArc190] || 0;
    if (fam > 0) {
      await grantFameOnce(client, {
        officerId,
        flags: nextFlags,
        rewardKey: `reward_fame_arc190_${nextArc190}`,
        amount: fam,
        reason: nextArc190 >= 4 ? '연합 해산을 목격하고 이름이 퍼짐' : `190년 소문 추적 ${nextArc190}/3`
      });
    }
  }

  const pr = asInt(prevRank, asInt(rank, 9));
  const nr = asInt(rank, 9);
  if (forceId !== 'ronin' && nr < pr) {
    const rankRewards = { 8: 300, 5: 800, 2: 1500 };
    const amt = rankRewards[nr] || 0;
    const r = await grantGoldOnce(client, {
      officerId,
      flags: nextFlags,
      rewardKey: `reward_rank_${nr}`,
      amount: amt,
      reason: `품관 ${nr} 달성`
    });
    if (r?.granted) reward = { type: 'gold', gold: r.gold, summary: r.summary };
  }

  // Finalize chapter ending exactly once when arc hits stage 4.
  if (nextArc190 >= 4 && flags.arc190_ended !== true) {
    await finalizeArc190Ending(client, { officerId });
  }

  return { computed, reward };
}

async function bumpRelationship(client, { sourceOfficerId, targetOfficerId, relType, delta, note }) {
  const d = asInt(delta, 0);
  const entry = {
    at: new Date().toISOString(),
    note: String(note || '').slice(0, 200)
  };
  await client.query(
    `INSERT INTO relationships (source_officer_id, target_officer_id, rel_type, affinity_score, history_log, updated_at)
     VALUES ($1,$2,$3,$4,$5::jsonb, now())
     ON CONFLICT (source_officer_id, target_officer_id, rel_type)
     DO UPDATE SET
       affinity_score = GREATEST(-100, LEAST(100, relationships.affinity_score + EXCLUDED.affinity_score)),
       history_log = relationships.history_log || EXCLUDED.history_log,
       updated_at = now()`,
    [sourceOfficerId, targetOfficerId, relType, d, JSON.stringify([entry])]
  );
}

async function runGameCommandInTx(client, { playerId, command, payload, key }, opts = {}) {
  const options = {
    idempotency: true,
    logResult: true,
    narrate: true,
    emit: true,
    ...opts
  };

  if (options.idempotency && key) {
    const existing = await client.query('SELECT result FROM command_logs WHERE idempotency_key = $1', [key]);
    if (existing.rows.length) return existing.rows[0].result;
  }

  // Normalize user-facing aliases (UI hides "city management" verbs).
  if (command === 'calm') command = 'patrol';
  if (command === 'work') command = 'cultivate';

  if (command === 'skills') {
    const row = await getJoinedPlayerForUpdate(client, playerId);
    const level = asInt(row.officer_level, 1);
    const xp = asInt(row.officer_xp, 0);
    const sp = asInt(row.officer_skill_points, 0);
    const unlocked = parseJsonArray(row.officer_unlocked_skills).map((x) => String(x || '').trim()).filter(Boolean);
    const equipped = parseJsonObject(row.officer_equipped_skills);
    const list = SKILL_DEFS.map((s) => ({
      id: s.id,
      name: s.name,
      unlock_level: s.unlock_level,
      desc: s.desc,
      unlocked: unlocked.includes(s.id),
      can_unlock: level >= s.unlock_level && sp > 0 && !unlocked.includes(s.id)
    }));
    const response = {
      ok: true,
      summary: `스킬: Lv${level} XP ${xp}/${xpNeededForLevel(level + 1)} SP ${sp}`,
      officer: { id: row.officer_id, name: row.officer_name, level, xp, skill_points: sp },
      extra: { skills: list, unlocked, equipped, slots: ['q', 'w', 'e', 'r'] }
    };
    if (options.logResult && key) {
      await client.query(
        `INSERT INTO command_logs (idempotency_key, player_id, command_name, payload, result)
         VALUES ($1, $2, $3, $4, $5)`,
        [key, playerId, command, payload, response]
      );
    }
    return response;
  }

  if (command === 'skill_unlock') {
    const row = await getJoinedPlayerForUpdate(client, playerId);
    const skillId = String(payload.skillId || payload.id || payload.skill || '').trim();
    if (!skillId) throw new Error('해금할 스킬이 필요합니다. 예) skill_unlock dash');
    const def = SKILL_DEFS.find((s) => s.id === skillId);
    if (!def) throw new Error('알 수 없는 스킬입니다.');
    const level = asInt(row.officer_level, 1);
    const sp0 = asInt(row.officer_skill_points, 0);
    if (level < def.unlock_level) throw new Error(`레벨이 부족합니다. (필요 Lv${def.unlock_level})`);
    if (sp0 <= 0) throw new Error('스킬 포인트가 없습니다.');
    const unlocked0 = parseJsonArray(row.officer_unlocked_skills).map((x) => String(x || '').trim()).filter(Boolean);
    if (unlocked0.includes(skillId)) throw new Error('이미 해금한 스킬입니다.');
    const unlocked = unlocked0.concat([skillId]).slice(0, 32);
    const sp = sp0 - 1;
    await client.query(`UPDATE officers SET unlocked_skills=$1::jsonb, skill_points=$2 WHERE id=$3`, [
      JSON.stringify(unlocked),
      sp,
      row.officer_id
    ]);
    return { ok: true, summary: `스킬 해금: ${def.name} (-1 SP)`, officer: { id: row.officer_id, level, skill_points: sp }, extra: { skillId } };
  }

  if (command === 'skill_equip') {
    const row = await getJoinedPlayerForUpdate(client, playerId);
    const slot = String(payload.slot || '').trim().toLowerCase();
    const skillId = String(payload.skillId || payload.id || payload.skill || '').trim();
    if (!slot || !['q', 'w', 'e', 'r'].includes(slot)) throw new Error('슬롯이 필요합니다. (q/w/e/r)');
    if (!skillId) throw new Error('장착할 스킬이 필요합니다.');
    const def = SKILL_DEFS.find((s) => s.id === skillId);
    if (!def) throw new Error('알 수 없는 스킬입니다.');
    const unlocked = parseJsonArray(row.officer_unlocked_skills).map((x) => String(x || '').trim()).filter(Boolean);
    if (!unlocked.includes(skillId)) throw new Error('해금하지 않은 스킬입니다. (skills / skill_unlock)');
    const eq0 = parseJsonObject(row.officer_equipped_skills);
    const nextEq = { ...(eq0 || {}), [slot]: skillId };
    await client.query(`UPDATE officers SET equipped_skills=$1::jsonb WHERE id=$2`, [JSON.stringify(nextEq), row.officer_id]);
    return { ok: true, summary: `스킬 장착: ${slot.toUpperCase()} = ${def.name}`, officer: { id: row.officer_id }, extra: { slot, skillId, equipped: nextEq } };
  }

  if (command === 'skill_unequip') {
    const row = await getJoinedPlayerForUpdate(client, playerId);
    const slot = String(payload.slot || '').trim().toLowerCase();
    if (!slot || !['q', 'w', 'e', 'r'].includes(slot)) throw new Error('슬롯이 필요합니다. (q/w/e/r)');
    const eq0 = parseJsonObject(row.officer_equipped_skills);
    const nextEq = { ...(eq0 || {}) };
    delete nextEq[slot];
    await client.query(`UPDATE officers SET equipped_skills=$1::jsonb WHERE id=$2`, [JSON.stringify(nextEq), row.officer_id]);
    return { ok: true, summary: `스킬 해제: ${slot.toUpperCase()}`, officer: { id: row.officer_id }, extra: { slot, equipped: nextEq } };
  }

  // Auto-run multiple actions. Sub-actions intentionally do not emit/narrate to keep chat clean.
  if (command === 'auto_day') {
    const maxSteps = Math.max(1, Math.min(10, Number(payload.maxSteps || 5)));
    const logs = [];
    let steps = 0;
    let didSpy = false;

    while (steps < maxSteps) {
      const row = await getJoinedPlayerForUpdate(client, playerId);

      // Pick a reasonable next action that keeps the game moving and easy.
      let next = null;

      if (row.officer_force_id === 'ronin') {
        // Officer-only design: no pledge/governor. Keep the loop focused on exploration + relationships + recruiting.
        // If there is a ronin in the same city, try to build relationship / recruit.
        const localRonin = await client.query(
          `SELECT id, name_kr
           FROM officers
           WHERE city_id = $1 AND force_id = 'ronin' AND id <> $2
           ORDER BY random()
           LIMIT 1`,
          [row.city_id, row.officer_id]
        );
        if (!next && localRonin.rows.length) {
          const t = localRonin.rows[0];
          if (row.ap >= 30) {
            next = { command: 'employ', payload: { targetOfficerId: t.id, targetName: t.name_kr } };
          } else if (row.ap >= 10 && steps % 2 === 0) {
            next = { command: 'socialize', payload: {} };
          }
        }

        const near = await client.query(
          `SELECT e.to_city_id AS city_id, c.name_kr, c.owner_force_id, e.distance, e.terrain
           FROM edges e JOIN cities c ON c.id = e.to_city_id
           WHERE e.from_city_id = $1
           ORDER BY e.distance ASC`,
          [row.city_id]
        );
        const prefer = near.rows.find((c) => c.owner_force_id !== 'neutral' && c.owner_force_id !== 'ronin') || near.rows[0] || null;

        if (!didSpy && prefer && row.ap >= 25) {
          next = { command: 'spy', payload: { toCityId: prefer.city_id, toCityName: prefer.name_kr } };
        } else if (prefer) {
          const cost = travelCost(prefer.distance);
          if (row.ap >= cost && prefer.city_id !== row.city_id) {
            next = { command: 'travel', payload: { toCityId: prefer.city_id, toCityName: prefer.name_kr } };
          }
        }

        if (!next && row.ap >= 20) next = { command: 'search', payload: {} };
      } else {
        // Non-ronin: keep it as personal actions only (no office mechanics).
        if (row.ap >= 20) {
          next = { command: steps % 2 === 0 ? 'cultivate' : 'train', payload: {} };
        } else {
          break;
        }
      }

      if (!next) break;
      if (next.command === 'spy') didSpy = true;

      const r = await runGameCommandInTx(
        client,
        { playerId, command: next.command, payload: next.payload, key: null },
        { idempotency: false, logResult: false, narrate: false, emit: false }
      );
      logs.push({ command: next.command, summary: r.summary });
      steps += 1;
    }

    const after = await getJoinedPlayerForUpdate(client, playerId);
    const summary = `${after.officer_name} 자동 진행 ${steps}회 완료: ${logs.map((l) => l.command).join(' -> ') || '없음'}`;
    const response = {
      ok: true,
      summary,
      officer: { id: after.officer_id, name: after.officer_name, ap: after.ap, merit: after.merit, rank: after.rank },
      extra: { steps, logs }
    };

    const bio = await client.query(
      `INSERT INTO biography_logs (officer_id, event_type, event_data)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [after.officer_id, 'auto_day', { summary, payload, logs }]
    );
    const bioLogId = bio.rows[0]?.id || null;
    if (options.logResult && key) {
      await client.query(
        `INSERT INTO command_logs (idempotency_key, player_id, command_name, payload, result)
         VALUES ($1, $2, $3, $4, $5)`,
        [key, playerId, command, payload, response]
      );
    }
    if (options.narrate) {
      await biographyQueue.add('narrate', {
        bioLogId,
        officerId: after.officer_id,
        actor: after.officer_name,
        actorRole: after.officer_role || 'officer',
        target: null,
        command,
        summary
      });
    }
    if (options.emit) {
      io.to(`officer:${after.officer_id}`).emit('game-event', response);
    }
    return response;
  }

  const row = await getJoinedPlayerForUpdate(client, playerId);
  const skillMods = equippedSkillMods(row);

  // Custody gate: if imprisoned, most actions are blocked until breakout or time passes.
  const custodyStatus = String(row.officer_custody_status || 'free');
  if (custodyStatus !== 'free') {
    const allow = new Set(['status', 'story', 'next', 'end_turn', 'breakout', 'skills', 'skill_unlock', 'skill_equip', 'skill_unequip']);
    if (!allow.has(String(command || ''))) {
      throw new Error('현재 구금 상태입니다. (breakout으로 탈출 시도, 또는 end_turn로 시간이 흐르면 처분이 결정될 수 있습니다)');
    }
  }

  let apCost = 0;
  let summary = '';
  let meritGain = 0;
  let fameGain = 0;
  let extra = {};
  let nextOfficerCityId = row.officer_city_id;
  let overrideNextAP = null;
  let nextOfficerGold = row.officer_gold ?? 0;

  const ambition = getHiddenStat(row.officer_hidden_stats, 'ambition', 50);
  const duty = getHiddenStat(row.officer_hidden_stats, 'duty', 50);
  let nextForceId = row.officer_force_id;
  let nextRole = row.officer_role;

  if (command === 'next') {
    apCost = 0;
    summary = `추천을 갱신했다. (턴 종료: end_turn)`;
    meritGain = 0;
    fameGain = 0;
    extra = {};
  } else if (command === 'end_turn') {
    apCost = 0;
    // Advance global day and restore AP (easy-mode). Also acts as a chapter beat trigger.
    await client.query('UPDATE game_time SET day = day + 1, updated_at = now() WHERE id = 1');

    const now = await client.query('SELECT year, month, day FROM game_time WHERE id = 1 FOR UPDATE');
    let { year, month, day } = now.rows[0];

    // New day: restore AP for all officers.
    await client.query('UPDATE officers SET ap = 100');

    if (day > 30) {
      day = 1;
      month += 1;
      await client.query('UPDATE cities SET gold = gold + commerce * 10, rice = rice + farming * 20');
    }
    if (month > 12) {
      month = 1;
      year += 1;
    }
    await client.query('UPDATE game_time SET year = $1, month = $2, day = $3, updated_at = now() WHERE id = 1', [
      year,
      month,
      day
    ]);

    summary = `하루가 지났다. (${year}.${month}.${day}) 기력이 회복된다.`;
    meritGain = 0;
    fameGain = 0;
    overrideNextAP = 100;
    extra = { gameTime: { year, month, day } };

  // Custody drama: suspicion -> imprisonment -> sentence/exile.
  try {
      const dayKey = getGameDayKey({ year, month, day });
      const cur = await client.query(`SELECT custody_status, custody_since_daykey, force_id, loyalty, hidden_stats, duty, name_kr FROM officers WHERE id=$1 FOR UPDATE`, [
        row.officer_id
      ]);
      const me2 = cur.rows[0] || null;
      if (me2) {
        const hs = parseHiddenStats(me2.hidden_stats);
        const suspicion = clamp(asInt(hs.suspicion, 0), 0, 100);
        const custody = String(me2.custody_status || 'free');
        const since = String(me2.custody_since_daykey || '');

        if (custody === 'free' && me2.force_id !== 'ronin') {
          // Natural daily decay: time cools things down (especially if you keep a low profile).
          if (suspicion > 0) {
            const duty = asInt(me2.duty, 50);
            const dec = 3 + Math.floor(Math.max(0, duty - 50) / 20); // 3..6
            hs.suspicion = Math.max(0, suspicion - dec);
          }
          // Deterministic check per day.
          const r = seededRng(sha256Hex(`${row.officer_id}|${dayKey}|custody`).slice(0, 8));
          const base = suspicion >= 80 ? 0.35 : suspicion >= 60 ? 0.18 : 0.0;
          const duty = asInt(me2.duty, 50);
          const chance = Math.max(0, base - Math.max(0, (duty - 60) / 300)); // duty slightly reduces risk
          if (chance > 0 && r() < chance) {
            await client.query(`UPDATE officers SET custody_status='imprisoned', custody_reason=$2, custody_since_daykey=$3 WHERE id=$1`, [
              row.officer_id,
              '의심이 짙어져 구금되었다',
              dayKey
            ]);
            summary += `\n(경고) 의심이 커져 구금되었다. 탈출(breakout)하거나 시간이 지나면 처분이 내려질 수 있다.`;
          }
          // Persist daily suspicion decay (even if not imprisoned).
          await client.query(`UPDATE officers SET hidden_stats=$2::jsonb WHERE id=$1`, [row.officer_id, JSON.stringify(hs)]);
        } else if (custody === 'imprisoned') {
          // After 2+ days imprisoned, deterministic "sentence" may happen.
          const daysHeld = since ? (dayKey === since ? 1 : 2) : 2; // coarse but stable enough for now
          const held0 = clamp(asInt(hs.held_days, 0), 0, 999);
          const held = held0 + 1;
          hs.held_days = held;
          await client.query(`UPDATE officers SET hidden_stats=$2::jsonb WHERE id=$1`, [row.officer_id, JSON.stringify(hs)]);

          if (held >= 2) {
            const r = seededRng(sha256Hex(`${row.officer_id}|${dayKey}|sentence`).slice(0, 8));
            const severity = clamp(Math.round((suspicion - 50) / 50), 0, 2); // 0..2
            const p = severity === 2 ? 0.55 : severity === 1 ? 0.30 : 0.15;
            if (r() < p) {
              // Non-permadeath by default: exile + reset to ronin + losses.
              const goldLoss = Math.min(400, Math.max(120, 120 + suspicion * 2));
              await client.query(
                `UPDATE officers
                 SET custody_status='free', custody_reason='', custody_since_daykey='',
                     force_id='ronin',
                     loyalty=50,
                     fame=GREATEST(0, fame - 5),
                     gold=GREATEST(0, gold - $2),
                     hidden_stats=$3::jsonb
                 WHERE id=$1`,
                [
                  row.officer_id,
                  goldLoss,
                  JSON.stringify({ ...hs, suspicion: 0, held_days: 0, last_sentence_daykey: dayKey })
                ]
              );
              summary += `\n(처분) 강제로 재야로 내몰렸다. (명성 -5, 금 -${goldLoss})`;
              await client.query(
                `INSERT INTO biography_logs (officer_id, event_type, event_data)
                 VALUES ($1,$2,$3)`,
                [row.officer_id, 'sentence', { summary: '구금 끝에 추방되었다.', goldLoss, dayKey }]
              );
            }
          }
        }
      }
    } catch {
      // ignore custody failures
    }

    // Immediately offer a small branching episode for the new day (easy-mode pacing).
    try {
      const row2 = await getJoinedPlayerForUpdate(client, playerId);
      const st2 = await client.query(`SELECT objective FROM story_states WHERE officer_id=$1`, [row2.officer_id]);
      const obj2 = String(st2.rows[0]?.objective || '').trim();
      const ep = await maybeGenerateSmallEpisode(client, { row: row2, objective: obj2 });
      if (ep?.episode && Array.isArray(ep.episode.options) && ep.episode.resolved !== true) {
        extra.choices = ep.episode.options
          .slice(0, 3)
          .map((o) => ({ label: o.label || o.verb, cmd: o.cmd || (o.verb === 'patrol' ? 'calm' : o.verb) }));
      }
    } catch {
      // ignore
    }
  } else if (command === 'cultivate') {
    apCost = 20;
    const gain = cultivateYield(row);
    await client.query('UPDATE cities SET farming = farming + $1, rice = rice + ($1 * 30) WHERE id = $2', [
      gain,
      row.city_id
    ]);
    summary = `${row.officer_name}이(가) 현장을 뛰며 보급과 민심을 도왔다. (보급 +${gain})`;
    meritGain = 120;
    fameGain = 1;
    extra = { farmingGain: gain };
  } else if (command === 'train') {
    apCost = 20;
    const gain = trainYield(row);
    summary = `${row.officer_name}이(가) 훈련을 시행해 전력 ${gain} 향상`;
    meritGain = 100;
    fameGain = 1;
    extra = { trainingGain: gain };
  } else if (command === 'recruit') {
    apCost = 25;
    const gain = recruitYield(row, row);
    await client.query('UPDATE cities SET population = GREATEST(10000, population - $1) WHERE id = $2', [
      Math.floor(gain * 0.5),
      row.city_id
    ]);
    summary = `${row.officer_name}이(가) 동료들을 모아 병력을 규합했다. (병력 +${gain})`;
    meritGain = 140;
    fameGain = 1;
    extra = { recruits: gain };
  } else if (command === 'patrol') {
    apCost = 10;
    // Officer-centric: "CALM" is about your presence and reputation, not city management.
    // This grants a short-lived bonus that makes the next recruit/search smoother.
    const st = await getStoryState(client, row.officer_id);
    const flags = st.flags || {};
    const cur = asInt(flags.calm_boost, 0);
    const next = Math.min(3, cur + 1);
    await client.query(
      `INSERT INTO story_states (officer_id, chapter, objective, flags, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, now())
       ON CONFLICT (officer_id) DO UPDATE
       SET flags=$4::jsonb, updated_at=now()`,
      [row.officer_id, st.chapter || 1, st.objective || '', JSON.stringify({ ...flags, calm_boost: next })]
    );
    summary = `${row.officer_name}이(가) 사람들과 마주하며 소문을 잠재웠다. (다음 행동 보정 +${next})`;
    meritGain = 60;
    fameGain = 1;
    extra = { calmBoost: next };
    try {
      const hs = await bumpSuspicion(client, row.officer_id, -10, { last_suspicion_relief: 'calm' });
      if (typeof hs?.suspicion === 'number') extra.suspicion = hs.suspicion;
    } catch {
      // ignore
    }
  } else if (command === 'visit') {
    apCost = 10;
    const input = String(payload.targetOfficerId || payload.targetName || '').trim();
    let target = null;
    if (input) {
      const byId = await client.query(
        `SELECT id, name_kr FROM officers WHERE id=$1 AND city_id=$2 AND id<>$3 LIMIT 1`,
        [input, row.city_id, row.officer_id]
      );
      if (byId.rows.length) target = byId.rows[0];
      if (!target) {
        const byName = await client.query(
          `SELECT id, name_kr FROM officers WHERE city_id=$1 AND id<>$2 AND name_kr ILIKE $3 ORDER BY random() LIMIT 1`,
          [row.city_id, row.officer_id, `%${input}%`]
        );
        if (byName.rows.length) target = byName.rows[0];
      }
      if (!target) throw new Error('방문할 대상을 찾을 수 없습니다.');
    } else {
      const pick = await client.query(
        `SELECT id, name_kr FROM officers WHERE city_id=$1 AND id<>$2 ORDER BY random() LIMIT 1`,
        [row.city_id, row.officer_id]
      );
      if (!pick.rows.length) throw new Error('같은 도시에 방문할 인물이 없습니다.');
      target = pick.rows[0];
    }

    const base = clamp(6 + Math.floor(row.chr / 16) + Math.floor(Math.random() * 6), 5, 18);
    const delta = clamp(Math.round(base * (1 + skillMods.relationship_pct)), 5, 60);
    await bumpRelationship(client, {
      sourceOfficerId: row.officer_id,
      targetOfficerId: target.id,
      relType: 'Acquaintance',
      delta,
      note: 'visit'
    });
    summary = `${row.officer_name}이(가) [${target.name_kr}]를 찾아가 담소를 나누었다. (친밀도 +${delta})`;
    meritGain = 30;
    fameGain = 1 + skillMods.fame_flat;
    extra = { targetOfficerId: target.id, targetName: target.name_kr, delta };
    try {
      const hs = await bumpSuspicion(client, row.officer_id, -6, { last_suspicion_relief: 'visit' });
      if (typeof hs?.suspicion === 'number') extra.suspicion = hs.suspicion;
    } catch {
      // ignore
    }
  } else if (command === 'banquet') {
    apCost = 15;
    const cost = 100;
    if (nextOfficerGold < cost) throw new Error(`금이 부족합니다. (필요: ${cost}, 보유: ${nextOfficerGold})`);
    nextOfficerGold -= cost;

    const picks = await client.query(
      `SELECT id, name_kr FROM officers WHERE city_id=$1 AND id<>$2 ORDER BY random() LIMIT 2`,
      [row.city_id, row.officer_id]
    );
    let gained = 0;
    for (const t of picks.rows) {
      const base = clamp(10 + Math.floor(row.chr / 20) + Math.floor(Math.random() * 6), 8, 20);
      const delta = clamp(Math.round(base * (1 + skillMods.relationship_pct)), 5, 60);
      gained += delta;
      await bumpRelationship(client, {
        sourceOfficerId: row.officer_id,
        targetOfficerId: t.id,
        relType: 'Acquaintance',
        delta,
        note: 'banquet'
      });
    }
    const names = picks.rows.map((r) => r.name_kr).join(', ') || '동료들';
    summary = `${row.officer_name}이(가) 연회를 열어 [${names}]와(과) 의를 다졌다. (금 -${cost}, 친밀도 +${gained})`;
    meritGain = 50;
    fameGain = 2 + skillMods.fame_flat;
    extra = { goldCost: cost, targets: picks.rows, totalDelta: gained, goldAfter: nextOfficerGold };
  } else if (command === 'gift') {
    apCost = 10;
    const cost = 80;
    if (nextOfficerGold < cost) throw new Error(`금이 부족합니다. (필요: ${cost}, 보유: ${nextOfficerGold})`);

    const input = String(payload.targetOfficerId || payload.targetName || '').trim();
    let target = null;
    if (input) {
      const byId = await client.query(
        `SELECT id, name_kr FROM officers WHERE id=$1 AND city_id=$2 AND id<>$3 LIMIT 1`,
        [input, row.city_id, row.officer_id]
      );
      if (byId.rows.length) target = byId.rows[0];
      if (!target) {
        const byName = await client.query(
          `SELECT id, name_kr FROM officers WHERE city_id=$1 AND id<>$2 AND name_kr ILIKE $3 ORDER BY random() LIMIT 1`,
          [row.city_id, row.officer_id, `%${input}%`]
        );
        if (byName.rows.length) target = byName.rows[0];
      }
      if (!target) throw new Error('선물할 대상을 찾을 수 없습니다.');
    } else {
      const pick = await client.query(
        `SELECT id, name_kr FROM officers WHERE city_id=$1 AND id<>$2 ORDER BY random() LIMIT 1`,
        [row.city_id, row.officer_id]
      );
      if (!pick.rows.length) throw new Error('같은 도시에 선물할 인물이 없습니다.');
      target = pick.rows[0];
    }

    nextOfficerGold -= cost;
    const base = clamp(18 + Math.floor(row.chr / 14) + Math.floor(Math.random() * 8), 16, 32);
    const delta = clamp(Math.round(base * (1 + skillMods.relationship_pct)), 12, 90);
    await bumpRelationship(client, {
      sourceOfficerId: row.officer_id,
      targetOfficerId: target.id,
      relType: 'Acquaintance',
      delta,
      note: 'gift'
    });
    summary = `${row.officer_name}이(가) [${target.name_kr}]에게 선물을 건넸다. (금 -${cost}, 친밀도 +${delta})`;
    meritGain = 35;
    fameGain = 1 + skillMods.fame_flat;
    extra = { goldCost: cost, targetOfficerId: target.id, targetName: target.name_kr, delta, goldAfter: nextOfficerGold };
    try {
      const hs = await bumpSuspicion(client, row.officer_id, -8, { last_suspicion_relief: 'gift' });
      if (typeof hs?.suspicion === 'number') extra.suspicion = hs.suspicion;
    } catch {
      // ignore
    }
  } else if (command === 'shop') {
    apCost = 0;
    const items = await listShopItems(client);
    const list = items
      .slice(0, 14)
      .map((it) => `${it.item_id} | ${it.name} | ${asInt(it.price, 0)}G${it.soldOut ? ' | SOLD OUT' : ''}`)
      .join(' / ');
    summary = items.length ? `상점: ${list}${items.length > 14 ? ' ...' : ''}` : '상점: (판매 중인 품목이 없습니다)';
    meritGain = 0;
    extra = { items };
  } else if (command === 'buy') {
    apCost = 0;
    const itemId = String(payload.itemId || payload.id || payload.item || '').trim();
    if (!itemId) throw new Error('구매할 아이템이 필요합니다. 예) buy mount_basic');
    const it = await getItemById(client, itemId);
    if (!it) throw new Error('알 수 없는 아이템입니다.');
    if (!it.is_shop) throw new Error('해당 아이템은 상점에서 구매할 수 없습니다.');
    if (nextOfficerGold < it.price) throw new Error(`금이 부족합니다. (필요: ${it.price}, 보유: ${nextOfficerGold})`);

    const inv0 = parseInventory(row.officer_inventory);
    let inv = inv0;
    nextOfficerGold -= it.price;

    if (it.unique_key) {
      const owned = await client.query(`SELECT owner_officer_id FROM unique_ownership WHERE unique_key=$1 LIMIT 1`, [
        it.unique_key
      ]);
      const owner = owned.rows[0]?.owner_officer_id ? String(owned.rows[0].owner_officer_id) : null;
      if (owner && owner !== String(row.officer_id)) throw new Error('해당 유니크 아이템은 이미 누군가가 보유 중입니다.');
      // Reserve ownership on purchase (global unique).
      if (!owner) {
        await client.query(
          `INSERT INTO unique_ownership (unique_key, item_id, owner_officer_id)
           VALUES ($1,$2,$3)
           ON CONFLICT (unique_key) DO NOTHING`,
          [it.unique_key, it.item_id, row.officer_id]
        );
      }
    }

    if (it.type === 'equipment') {
      if (!it.stackable && hasItem(inv, itemId)) throw new Error('이미 보유 중인 장비입니다.');
      inv = setInventoryCount(inv, itemId, 1); // equipment: ownership flag (qty=1)
      summary = `${row.officer_name}이(가) ${it.name}을(를) 구입했다. (금 -${it.price})`;
      extra = { itemId, name: it.name, price: it.price, inventory: inv, item: it };
    } else if (it.type === 'consumable') {
      const cur = inventoryCount(inv, itemId);
      const next = cur + 1;
      const cap = Math.max(1, asInt(it.max_stack, 99));
      if (next > cap) throw new Error(`최대 보유 수량을 초과했습니다. (최대 ${cap})`);
      inv = setInventoryCount(inv, itemId, next);
      summary = `${row.officer_name}이(가) ${it.name}을(를) 구입했다. (금 -${it.price})`;
      extra = { itemId, name: it.name, price: it.price, inventory: inv, item: it };
    } else if (it.type === 'book') {
      // Apply immediately and do not store multiple copies.
      const kind = String(it.effects?.kind || '');
      if (kind !== 'stat_up') throw new Error('서적 효과가 정의되지 않았습니다.');
      const field = String(it.effects?.stat || '').trim();
      const amount = asInt(it.effects?.amount, 1);
      const cap = asInt(it.effects?.cap, 99);
      const allowed = new Set(['int_stat', 'pol', 'chr', 'war', 'ldr']);
      if (!allowed.has(field)) throw new Error('서적 적용 실패');
      const before = asInt(row[field], 0);
      const after = Math.min(cap, before + Math.max(1, amount));
      await client.query(`UPDATE officers SET ${field} = $1 WHERE id = $2`, [after, row.officer_id]);
      const pretty = field === 'int_stat' ? 'INT' : field.toUpperCase();
      summary = `${row.officer_name}이(가) ${it.name}을(를) 읽어 ${pretty} +${after - before}. (금 -${it.price})`;
      extra = { itemId, name: it.name, price: it.price, stat: field, before, after, item: it };
    } else {
      throw new Error('아이템 타입이 지원되지 않습니다.');
    }

    await client.query(`UPDATE officers SET inventory=$1::jsonb WHERE id=$2`, [JSON.stringify(inv), row.officer_id]);
  } else if (command === 'use') {
    apCost = 0;
    const itemId = String(payload.itemId || payload.id || payload.item || '').trim();
    if (!itemId) throw new Error('사용할 아이템이 필요합니다. 예) use med_small');
    const inv0 = parseInventory(row.officer_inventory);
    const cur = inventoryCount(inv0, itemId);
    if (cur <= 0) throw new Error('해당 아이템이 없습니다.');
    const it = await getItemById(client, itemId);
    if (!it) throw new Error('알 수 없는 아이템입니다.');
    if (it.type !== 'consumable') throw new Error('현재는 소모품만 사용 가능합니다.');

    const kind = String(it.effects?.kind || '').trim();
    const inv = setInventoryCount(inv0, itemId, cur - 1);
    await client.query(`UPDATE officers SET inventory=$1::jsonb WHERE id=$2`, [JSON.stringify(inv), row.officer_id]);

    if (kind === 'rest_bonus_once') {
      const amount = asInt(it.effects?.amount, 0);
      if (amount <= 0) throw new Error('소모품 효과가 올바르지 않습니다.');
      const st = await getStoryState(client, row.officer_id);
      const flags = st.flags || {};
      await client.query(
        `UPDATE story_states SET flags=$2::jsonb, updated_at=now() WHERE officer_id=$1`,
        [row.officer_id, JSON.stringify({ ...flags, rest_bonus_once: amount })]
      );
      summary = `${row.officer_name}이(가) ${it.name}을(를) 사용했다. (다음 rest 회복 +${amount})`;
      meritGain = 0;
      extra = { itemId, used: true, item: it };
    } else {
      summary = `${row.officer_name}이(가) ${it.name}을(를) 사용했다.`;
      meritGain = 0;
      extra = { itemId, used: true, item: it };
    }
  } else if (command === 'inventory') {
    apCost = 0;
    const enriched = await enrichInventory(client, row.officer_inventory);
    const eq = parseEquipment(row.officer_equipment);
    summary = enriched.length
      ? `인벤토리: ${enriched
          .slice(0, 10)
          .map((x) => `${x.item?.name || x.id} x${x.qty}`)
          .join(' / ')}${enriched.length > 10 ? ' ...' : ''}`
      : '인벤토리: (비어있음)';
    meritGain = 0;
    fameGain = 0;
    extra = { items: enriched, raw: parseInventory(row.officer_inventory), equipment: eq };
  } else if (command === 'equip') {
    apCost = 0;
    const itemId = String(payload.itemId || payload.id || payload.item || '').trim();
    if (!itemId) throw new Error('장착할 아이템이 필요합니다. 예) equip weapon_basic');

    const inv0 = parseInventory(row.officer_inventory);
    if (!hasItem(inv0, itemId)) throw new Error('해당 아이템이 인벤토리에 없습니다.');

    const it = await getItemById(client, itemId);
    if (!it) throw new Error('알 수 없는 아이템입니다.');
    if (it.type !== 'equipment') throw new Error('장착 가능한 아이템이 아닙니다.');
    const slot = equipSlotOf(it);
    if (!slot) throw new Error('해당 장비의 슬롯 정보가 없습니다.');

    const eq0 = parseEquipment(row.officer_equipment);
    const prev = getEquippedId(eq0, slot);
    const eq1 = setEquippedId(eq0, slot, itemId);
    await client.query(`UPDATE officers SET equipment=$1::jsonb WHERE id=$2`, [JSON.stringify(eq1), row.officer_id]);

    summary =
      prev && prev !== itemId
        ? `${row.officer_name}이(가) ${it.name}을(를) 장착했다. (${slot}: ${prev} -> ${itemId})`
        : `${row.officer_name}이(가) ${it.name}을(를) 장착했다. (${slot})`;
    meritGain = 0;
    fameGain = 0;
    extra = { equipped: true, slot, itemId, item: it, equipment: eq1 };
  } else if (command === 'unequip') {
    apCost = 0;
    const slot = String(payload.slot || payload.where || payload.target || '').trim().toLowerCase();
    if (!slot) throw new Error('해제할 슬롯이 필요합니다. 예) unequip weapon');
    if (!['weapon', 'mount'].includes(slot)) throw new Error('슬롯은 weapon/mount 만 지원합니다.');

    const eq0 = parseEquipment(row.officer_equipment);
    const prev = getEquippedId(eq0, slot);
    if (!prev) throw new Error('해당 슬롯에 장착된 장비가 없습니다.');
    const eq1 = setEquippedId(eq0, slot, null);
    await client.query(`UPDATE officers SET equipment=$1::jsonb WHERE id=$2`, [JSON.stringify(eq1), row.officer_id]);

    summary = `${row.officer_name}이(가) ${slot} 장착을 해제했다. (${prev})`;
    meritGain = 0;
    fameGain = 0;
    extra = { unequipped: true, slot, prevItemId: prev, equipment: eq1 };
  } else if (command === 'recruit_rumor') {
    apCost = 10;
    const cost = 50;
    if (nextOfficerGold < cost) throw new Error(`금이 부족합니다. (필요: ${cost}, 보유: ${nextOfficerGold})`);
    nextOfficerGold -= cost;
    const st = await getStoryState(client, row.officer_id);
    const flags = st.flags || {};
    const cur = asInt(flags.rumor_boost, 0);
    const next = Math.min(5, cur + 3);
    await client.query(
      `INSERT INTO story_states (officer_id, chapter, objective, flags, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, now())
       ON CONFLICT (officer_id) DO UPDATE
       SET flags=$4::jsonb, updated_at=now()`,
      [row.officer_id, st.chapter || 1, st.objective || '', JSON.stringify({ ...flags, rumor_boost: next })]
    );
    summary = `${row.officer_name}이(가) 소문을 퍼뜨려 인재의 발길을 끌었다. (다음 탐색 보정 ${next}회, 금 -${cost})`;
    meritGain = 10;
    fameGain = 1;
    extra = { rumorBoost: next, goldAfter: nextOfficerGold };
  } else if (command === 'rest') {
    apCost = 0;
    // Easy-mode: allow short rest AP recovery so users don't have to wait real-time.
    // Does not advance global time; has a small daily cap to prevent infinite loops.
    const time = await client.query('SELECT year, month, day FROM game_time WHERE id = 1');
    const now = time.rows[0] || { year: 0, month: 0, day: 0 };
    const dayKey = `${now.year}-${now.month}-${now.day}`;

    const st = await client.query(`SELECT flags FROM story_states WHERE officer_id=$1`, [row.officer_id]);
    const flags = st.rows[0]?.flags || {};
    const prevDay = typeof flags.rest_day === 'string' ? flags.rest_day : '';
    const prevCount = typeof flags.rest_count === 'number' ? flags.rest_count : 0;
    const count = prevDay === dayKey ? prevCount : 0;

    const before = row.ap;
    // After a few rests per day, recovery diminishes (avoid "hard lock" UX).
    let maxRecover = count >= 3 ? 10 : 60;
    // One-shot bonus from medicine.
    const st2 = await getStoryState(client, row.officer_id);
    const bonusOnce = asInt(st2.flags?.rest_bonus_once, 0);
    if (bonusOnce > 0) maxRecover += bonusOnce;
    const recovered = before >= 100 ? 0 : Math.min(100 - before, maxRecover);
    const after = Math.min(100, before + recovered);

    await client.query(
      `INSERT INTO story_states (officer_id, chapter, objective, flags, updated_at)
       VALUES ($1, 1, '', $2::jsonb, now())
       ON CONFLICT (officer_id) DO UPDATE
       SET flags = $2::jsonb, updated_at = now()`,
      [
        row.officer_id,
        JSON.stringify({
          ...flags,
          rest_day: dayKey,
          rest_count: count + 1,
          // consume one-shot bonus
          rest_bonus_once: 0
        })
      ]
    );
    overrideNextAP = after;

    summary =
      recovered > 0
        ? `${row.officer_name}이(가) 잠시 숨을 고르며 기력을 회복했다. (AP +${recovered} => ${after}/100)`
        : `${row.officer_name}이(가) 숨을 고르려 했으나 이미 기력이 가득하다. (AP ${after}/100)`;
    // Rest should not be a merit-farming action.
    meritGain = 0;
    fameGain = 0;
    extra = { recovered, apBefore: before, apAfter: after, restCountToday: count + 1, maxRecover };
  } else if (command === 'socialize') {
    // 장수 중심(MOBA 감각) 핵심: 인맥을 만들고, 그 인맥이 등용/임무에 영향을 준다.
    apCost = 10;
    const pick = await client.query(
      `SELECT id, name_kr, force_id
       FROM officers
       WHERE city_id = $1 AND id <> $2
       ORDER BY random()
       LIMIT 1`,
      [row.city_id, row.officer_id]
    );
    if (!pick.rows.length) throw new Error('같은 도시에 교류할 인물이 없습니다.');
    const t = pick.rows[0];

    const base0 = 8 + Math.floor(row.chr / 10); // 8..17
    const swing = Math.floor(Math.random() * 9); // 0..8
    const base = clamp(base0 + swing - Math.floor(duty / 20), 5, 24);
    const delta = clamp(Math.round(base * (1 + skillMods.relationship_pct)), 5, 60);
    await bumpRelationship(client, {
      sourceOfficerId: row.officer_id,
      targetOfficerId: t.id,
      relType: 'Acquaintance',
      delta,
      note: 'socialize'
    });

    summary = `${row.officer_name}이(가) 주막에서 [${t.name_kr}]와(과) 술잔을 나누며 인맥을 쌓았다. (친밀도 +${delta})`;
    meritGain = 40;
    fameGain = 1 + skillMods.fame_flat;
    extra = { targetOfficerId: t.id, targetName: t.name_kr, delta };
    try {
      const hs = await bumpSuspicion(client, row.officer_id, -10, { last_suspicion_relief: 'socialize' });
      if (typeof hs?.suspicion === 'number') extra.suspicion = hs.suspicion;
    } catch {
      // ignore
    }
  } else if (command === 'pledge') {
    throw new Error('이 게임은 군주/관직 운영이 아닌 “퀘스트+레벨업(장수 1인)” 게임입니다. pledge/임관 시스템은 폐기되었습니다.');
  } else if (command === 'request_governor') {
    throw new Error('이 게임은 군주/관직 운영이 아닌 “퀘스트+레벨업(장수 1인)” 게임입니다. request_governor(태수) 시스템은 폐기되었습니다.');
  } else if (command === 'scout_accept') {
    apCost = 0;
    const arg = String(payload.factionId || payload.forceId || payload.id || '').trim();
    let factionId = arg;
    // Allow "scout_accept <id>" via raw command mapping too (payload empty).
    if (!factionId) {
      const raw = String(payload.raw || '').trim();
      if (raw.startsWith('scout_accept ')) factionId = raw.slice('scout_accept '.length).trim();
    }
    if (!factionId) throw new Error('scout_accept: 대상 진영이 필요합니다.');
    if (factionId === 'neutral' || factionId === 'ronin') throw new Error('scout_accept: 유효한 진영이 아닙니다.');

    // Lookup readable name.
    const f = await client.query(`SELECT name_kr FROM forces WHERE id=$1 LIMIT 1`, [factionId]);
    const fname = String(f.rows[0]?.name_kr || factionId);

    // Stage 1: accept offer but do not switch immediately. Player must "make contact" first.
    const gt = await client.query(`SELECT year, month, day FROM game_time WHERE id=1`);
    const g = gt.rows[0] || { year: 0, month: 0, day: 0 };
    const dayKey = getGameDayKey(g);
    const st = await getStoryState(client, row.officer_id);
    const flags0 = st.flags || {};
    const prevForce = String(row.officer_force_id || 'ronin');
    const nextFlags = {
      ...flags0,
      scout_offer: {
        from: prevForce,
        to: factionId,
        to_name: fname,
        stage: 1,
        accepted_daykey: dayKey
      }
    };
    await client.query(`UPDATE story_states SET flags=$2::jsonb, updated_at=now() WHERE officer_id=$1`, [row.officer_id, JSON.stringify(nextFlags)]);

    // Accepting a secret offer is inherently risky.
    const hs = await bumpSuspicion(client, row.officer_id, 10, { last_scout_to: factionId, last_scout_daykey: dayKey });
    const suspicion = clamp(asInt(hs?.suspicion, 0), 0, 100);

    summary = `${row.officer_name}은(는) ${fname}의 제의를 받아들였다. (다음: 접선 socialize/visit/gift) (의심도 ${suspicion})`;
    meritGain = 80;
    fameGain = 1 + skillMods.fame_flat;
    extra = { factionId, factionName: fname, stage: 1, suspicion };
  } else if (command === 'scout_decline') {
    apCost = 0;
    summary = `${row.officer_name}은(는) 제의를 흘려보냈다.`;
    meritGain = 20;
    fameGain = 0;
    extra = {};
  } else if (command === 'scout_join') {
    apCost = 0;
    const to = String(payload.factionId || payload.forceId || payload.id || '').trim() || String(payload.raw || '').replace(/^scout_join\s+/i, '').trim();
    if (!to) throw new Error('scout_join: 대상 진영이 필요합니다.');
    if (to === 'neutral' || to === 'ronin') throw new Error('scout_join: 유효한 진영이 아닙니다.');

    const st = await getStoryState(client, row.officer_id);
    const flags0 = st.flags || {};
    const sc = flags0.scout_offer && typeof flags0.scout_offer === 'object' ? flags0.scout_offer : null;
    if (!sc || asInt(sc.stage, 0) < 2) throw new Error('아직 접선이 끝나지 않았습니다. 먼저 socialize/visit/gift로 접선하세요.');
    if (String(sc.to || '').trim() !== to) throw new Error('현재 제의 대상과 다릅니다.');

    const f = await client.query(`SELECT name_kr FROM forces WHERE id=$1 LIMIT 1`, [to]);
    const fname = String(f.rows[0]?.name_kr || to);

    const hs0 = parseHiddenStats(row.officer_hidden_stats);
    const prevForce = String(row.officer_force_id || 'ronin');
    const traitor = clamp(asInt(hs0.traitor_count, 0), 0, 9) + (prevForce !== 'ronin' && prevForce !== to ? 1 : 0);
    const past = Array.isArray(hs0.past_forces) ? hs0.past_forces.slice(0, 6) : [];
    const nextPast = prevForce && !past.includes(prevForce) ? past.concat([prevForce]).slice(-6) : past;
    const suspicion = clamp(Math.max(asInt(hs0.suspicion, 0), 25 + traitor * 15), 0, 100);
    const hs = { ...hs0, suspicion, traitor_count: traitor, past_forces: nextPast, last_joined_force: to };

    await client.query(`UPDATE officers SET force_id=$1, loyalty=$2, hidden_stats=$3::jsonb WHERE id=$4`, [to, 60, JSON.stringify(hs), row.officer_id]);
    nextForceId = to;

    const nextFlags = { ...flags0 };
    delete nextFlags.scout_offer;
    await client.query(`UPDATE story_states SET flags=$2::jsonb, updated_at=now() WHERE officer_id=$1`, [row.officer_id, JSON.stringify(nextFlags)]);

    summary = `${row.officer_name}이(가) ${fname}로 넘어갔다. (의심도 ${suspicion})`;
    meritGain = 160;
    fameGain = 3 + skillMods.fame_flat;
    extra = { factionId: to, factionName: fname, suspicion };
  } else if (command === 'scout_backout') {
    apCost = 0;
    const st = await getStoryState(client, row.officer_id);
    const flags0 = st.flags || {};
    const sc = flags0.scout_offer && typeof flags0.scout_offer === 'object' ? flags0.scout_offer : null;
    if (!sc) throw new Error('현재 진행 중인 스카우트 제의가 없습니다.');
    const to = String(sc.to || '').trim();
    const name = String(sc.to_name || to);
    const nextFlags = { ...flags0 };
    delete nextFlags.scout_offer;
    await client.query(`UPDATE story_states SET flags=$2::jsonb, updated_at=now() WHERE officer_id=$1`, [row.officer_id, JSON.stringify(nextFlags)]);
    const hs = await bumpSuspicion(client, row.officer_id, 6, { last_scout_abort: to });
    summary = `${row.officer_name}은(는) ${name} 제의에서 발을 뺐다. (의심도 ${asInt(hs?.suspicion, 0)})`;
    meritGain = 40;
    fameGain = 0;
    extra = { factionId: to };
  } else if (command === 'breakout') {
    apCost = 0;
    const hs0 = parseHiddenStats(row.officer_hidden_stats);
    const suspicion = clamp(asInt(hs0.suspicion, 0), 0, 100);
    const gt = await client.query(`SELECT year, month, day FROM game_time WHERE id=1`);
    const g = gt.rows[0] || { year: 0, month: 0, day: 0 };
    const dayKey = getGameDayKey(g);
    const r = seededRng(sha256Hex(`${row.officer_id}|${dayKey}|breakout`).slice(0, 8));
    const pow = row.war * 1.2 + row.int_stat * 0.8 + row.ldr * 0.4 + asInt(skillMods.battle_attack_flat, 0) * 3;
    const diff = 130 + suspicion * 1.2;
    const chance = clamp((pow - diff) / 120 + 0.25, 0.08, 0.78);
    const ok = r() < chance;
    if (ok) {
      await client.query(`UPDATE officers SET custody_status='free', custody_reason='', custody_since_daykey='', fame=GREATEST(0, fame-1), hidden_stats=$2::jsonb WHERE id=$1`, [
        row.officer_id,
        JSON.stringify({ ...hs0, suspicion: Math.max(0, suspicion - 20), held_days: 0, last_breakout_daykey: dayKey })
      ]);
      summary = `${row.officer_name}이(가) 틈을 타 구금을 벗어났다. (명성 -1)`;
      meritGain = 60;
      fameGain = 0;
      extra = { escaped: true, chance, suspicionAfter: Math.max(0, suspicion - 20) };
    } else {
      await client.query(`UPDATE officers SET hidden_stats=$2::jsonb WHERE id=$1`, [
        row.officer_id,
        JSON.stringify({ ...hs0, suspicion: Math.min(100, suspicion + 10), last_breakout_daykey: dayKey })
      ]);
      summary = `${row.officer_name}의 탈출 시도는 막혔다. (의심도 +10)`;
      meritGain = 0;
      fameGain = 0;
      extra = { escaped: false, chance, suspicionAfter: Math.min(100, suspicion + 10) };
    }
  } else if (command === 'skirmish') {
    apCost = 25;
    const gt = await client.query(`SELECT year, month, day FROM game_time WHERE id=1`);
    const g = gt.rows[0] || { year: 0, month: 0, day: 0 };
    const dayKey = getGameDayKey(g);

    const hs0 = parseHiddenStats(row.officer_hidden_stats);
    const last = String(hs0.last_skirmish_daykey || '');
    if (last === dayKey) throw new Error('오늘은 이미 충분히 싸웠습니다. (end_turn로 다음 날)');

    // Pick an opposing captain in the same city (prefer other factions, fallback any).
    const opp = await client.query(
      `SELECT id, name_kr, force_id, war, int_stat, pol, chr, ldr, level, equipment, inventory, equipped_skills
       FROM officers
       WHERE city_id=$1 AND id<>$2
       ORDER BY
         CASE WHEN force_id <> $3 THEN 1 ELSE 0 END DESC,
         war DESC
       LIMIT 1`,
      [row.city_id, row.officer_id, row.officer_force_id]
    );
    if (!opp.rows.length) throw new Error('같은 도시에 상대가 없습니다.');
    const enemyCaptain = opp.rows[0];

    // Build squads (up to 3 units each): leader + up to 2 followers.
    const myFollowers = await client.query(
      `SELECT id, name_kr, force_id, war, int_stat, pol, chr, ldr, level, equipment, inventory, equipped_skills
       FROM officers
       WHERE leader_officer_id=$1
       ORDER BY war DESC, ldr DESC
       LIMIT 2`,
      [row.officer_id]
    );
    const enemyFollowers = await client.query(
      `SELECT id, name_kr, force_id, war, int_stat, pol, chr, ldr, level, equipment, inventory, equipped_skills
       FROM officers
       WHERE leader_officer_id=$1
       ORDER BY war DESC, ldr DESC
       LIMIT 2`,
      [enemyCaptain.id]
    );

    const r = seededRng(sha256Hex(`${row.officer_id}|${enemyCaptain.id}|${dayKey}|skirmishv2`).slice(0, 8));

    async function buildUnit(off) {
      const sm = equippedSkillMods({ officer_equipped_skills: off.equipped_skills });
      const wb = await weaponBonusForOfficer(client, { inventory: off.inventory, equipment: off.equipment });
      const hp = unitHp({ ldr: off.ldr, level: off.level || 1 });
      return {
        id: String(off.id),
        name: String(off.name_kr),
        forceId: String(off.force_id || 'ronin'),
        war: asInt(off.war, 0),
        ldr: asInt(off.ldr, 0),
        level: asInt(off.level, 1),
        weaponId: wb.weaponId,
        weaponBonus: wb.bonus,
        skillBonus: asInt(sm.battle_attack_flat, 0),
        hp,
        hpMax: hp
      };
    }

    const mySquad = [await buildUnit({ ...row, id: row.officer_id, name_kr: row.officer_name, force_id: row.officer_force_id, level: row.officer_level, inventory: row.officer_inventory, equipment: row.officer_equipment, equipped_skills: row.officer_equipped_skills }), ...await Promise.all((myFollowers.rows || []).map(buildUnit))].slice(0, 3);
    const enemySquad = [await buildUnit(enemyCaptain), ...await Promise.all((enemyFollowers.rows || []).map(buildUnit))].slice(0, 3);

    const alive = (arr) => arr.filter((u) => u.hp > 0);
    const pickAlive = (arr) => {
      const a = alive(arr);
      if (!a.length) return null;
      return a[Math.floor(r() * a.length)] || a[0];
    };

    const log = [];
    const maxRounds = 10;
    for (let round = 1; round <= maxRounds; round += 1) {
      if (!alive(mySquad).length || !alive(enemySquad).length) break;
      log.push(`[R${round}]`);

      // Initiative: shuffle order each round deterministically.
      const order = alive(mySquad).map((u) => ({ side: 'me', u })).concat(alive(enemySquad).map((u) => ({ side: 'enemy', u })));
      order.sort((a, b) => sha256Hex(`${dayKey}|${round}|${a.u.id}`).localeCompare(sha256Hex(`${dayKey}|${round}|${b.u.id}`)));
      for (const t of order) {
        if (t.u.hp <= 0) continue;
        const target = t.side === 'me' ? pickAlive(enemySquad) : pickAlive(mySquad);
        if (!target) break;
        const dmg = unitDamage({ war: t.u.war, weaponBonus: t.u.weaponBonus, skillBonus: t.u.skillBonus, rand: r });
        target.hp = Math.max(0, target.hp - dmg);
        log.push(`${t.u.name} -> ${target.name} ${dmg}dmg (${target.hp}/${target.hpMax})`);
      }
    }

    const meAlive = alive(mySquad);
    const enAlive = alive(enemySquad);
    const win = meAlive.length > 0 && enAlive.length === 0;

    const goldDelta = win ? 140 + Math.floor(r() * 160) : -Math.min(90, Math.max(25, 25 + Math.floor(r() * 70)));
    nextOfficerGold = Math.max(0, asInt(row.officer_gold, 0) + goldDelta);

    const hs = { ...hs0, last_skirmish_daykey: dayKey };
    await client.query(`UPDATE officers SET hidden_stats=$2::jsonb WHERE id=$1`, [row.officer_id, JSON.stringify(hs)]);

    // Suspicion: if you fight "inside" a faction, it raises eyebrows.
    try {
      const sameFaction = String(row.officer_force_id || 'ronin') !== 'ronin' && String(enemyCaptain.force_id || 'ronin') === String(row.officer_force_id || '');
      if (sameFaction) await bumpSuspicion(client, row.officer_id, 6, { last_skirmish: 'in_faction' });
      else if (String(row.officer_force_id || 'ronin') !== 'ronin') await bumpSuspicion(client, row.officer_id, -2, { last_skirmish: 'external' });
    } catch {
      // ignore
    }

    if (win) {
      summary = `${row.officer_name}의 소규모 전투(스쿼드)가 승리했다. (+${goldDelta}G)`;
      meritGain = 260;
      fameGain = 4 + skillMods.fame_flat;
      extra = {
        result: 'win',
        enemy: { id: enemyCaptain.id, name: enemyCaptain.name_kr, forceId: enemyCaptain.force_id },
        goldDelta,
        squads: { me: mySquad.map((u) => ({ id: u.id, name: u.name })), enemy: enemySquad.map((u) => ({ id: u.id, name: u.name })) },
        combatLog: log.slice(0, 28)
      };
      const dropRoll = r();
      if (dropRoll < 0.40) extra.drop = { itemId: 'med_small', qty: 1 };
    } else {
      summary = `${row.officer_name}의 소규모 전투(스쿼드)가 패배했다. (${goldDelta}G)`;
      meritGain = 90;
      fameGain = 0;
      extra = {
        result: 'lose',
        enemy: { id: enemyCaptain.id, name: enemyCaptain.name_kr, forceId: enemyCaptain.force_id },
        goldDelta,
        squads: { me: mySquad.map((u) => ({ id: u.id, name: u.name })), enemy: enemySquad.map((u) => ({ id: u.id, name: u.name })) },
        combatLog: log.slice(0, 28)
      };
    }
  } else if (command === 'travel') {
    const input = String(payload.toCityId || payload.toCityName || '').trim();
    if (!input) throw new Error('payload.toCityId or payload.toCityName is required');

    const resolved = await resolveCityIdByIdOrName(client, input);
    if (!resolved) throw new Error('도시를 찾을 수 없습니다.');
    if (resolved.id === row.city_id) throw new Error('이미 해당 도시에 있습니다.');

    const edge = await client.query(`SELECT distance, terrain FROM edges WHERE from_city_id = $1 AND to_city_id = $2`, [
      row.city_id,
      resolved.id
    ]);
    if (!edge.rows.length) throw new Error('이동 경로가 없습니다(인접 도시만 이동 가능).');

    apCost = travelCost(edge.rows[0].distance);
    const inv = parseInventory(row.officer_inventory);
    const eq = parseEquipment(row.officer_equipment);
    const mountId = getEquippedId(eq, 'mount') || (hasItem(inv, 'mount_basic') ? 'mount_basic' : null);
    if (mountId) {
      const it = await getItemById(client, mountId);
      apCost = applyTravelDiscountFromItem(apCost, it);
    }
    if (skillMods.travel_discount_pct > 0) {
      apCost = Math.max(4, Math.round(apCost * (1 - skillMods.travel_discount_pct)));
    }
    nextOfficerCityId = resolved.id;
    summary = `${row.officer_name}이(가) ${resolved.name_kr}(으)로 이동했다. (AP -${apCost})`;
    meritGain = 30;
    fameGain = 1 + skillMods.fame_flat;
    extra = { toCityId: resolved.id, toCityName: resolved.name_kr, distance: edge.rows[0].distance, terrain: edge.rows[0].terrain };
    // Move party followers with the leader (no extra AP cost).
    await client.query(`UPDATE officers SET city_id=$1 WHERE leader_officer_id=$2`, [resolved.id, row.officer_id]);
  } else if (command === 'search') {
    apCost = 20;
    const inv = parseInventory(row.officer_inventory);
    // Rumor boost: improves chance to meet a ronin for a few searches.
    const st = await getStoryState(client, row.officer_id);
    const rb = asInt(st.flags?.rumor_boost, 0);
    const rumorBoost = rb > 0 ? 0.18 : 0;
    const p = Math.min(0.95, searchFindChance(row.int_stat, row.chr) + rumorBoost);
    const forceRonin = payload.forceRonin === true || rb > 0;
    const roll = forceRonin ? 0 : Math.random();
    if (rb > 0) {
      await client.query(
        `UPDATE story_states SET flags = jsonb_set(flags, '{rumor_boost}', to_jsonb(GREATEST(0, (flags->>'rumor_boost')::int - 1)), true), updated_at = now()
         WHERE officer_id = $1`,
        [row.officer_id]
      );
    }
    if (roll < p) {
      const spawnRonin = forceRonin || Math.random() < 0.45;
      if (spawnRonin) {
        const newIdRes = await client.query(`SELECT 'ron_' || substr(md5(random()::text), 1, 10) AS id`);
        const newId = newIdRes.rows[0].id;
        const war = 50 + Math.floor(Math.random() * 45);
        const intStat = 40 + Math.floor(Math.random() * 50);
        const pol = 35 + Math.floor(Math.random() * 55);
        const chr = 35 + Math.floor(Math.random() * 55);
        const ldr = 40 + Math.floor(Math.random() * 50);
        const loyalty = 40 + Math.floor(Math.random() * 45);
        const compatibility = Math.floor(Math.random() * 150);
        const roninName = `재야${newId.slice(-4)}`;
        const personalities = ['대담', '냉정', '소심', '저돌', '신중'];
        const hidden = {
          ambition: Math.floor(Math.random() * 101),
          duty: Math.floor(Math.random() * 101),
          affinity: compatibility
        };
        await client.query(
          `INSERT INTO officers (id, name_kr, war, int_stat, pol, chr, ldr, force_id, city_id, rank, loyalty, compatibility, personality, hidden_stats, gold)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'ronin',$8,9,$9,$10,$11,$12::jsonb,$13)
           ON CONFLICT (id) DO NOTHING`,
          [newId, roninName, war, intStat, pol, chr, ldr, row.city_id, loyalty, compatibility, personalities[Math.floor(Math.random() * personalities.length)], JSON.stringify(hidden), 250 + Math.floor(Math.random() * 450)]
        );
        summary = `${row.officer_name}이(가) 주막에서 재야 장수 ${roninName}의 소문을 들었다.`;
        meritGain = 90;
        fameGain = 1;
        extra = { found: 'ronin', officerId: newId, name: roninName, p, roll, rumorBoostActive: rb > 0 };
      } else {
        const gold0 = 200 + Math.floor(Math.random() * 800);
        const gold = Math.max(0, Math.round(gold0 * (1 + skillMods.search_gold_pct)));
        nextOfficerGold += gold;
        summary = `${row.officer_name}이(가) 탐색에 성공해 금 ${gold}을(를) 손에 넣었다.`;
        meritGain = 80;
        fameGain = 1 + skillMods.fame_flat;
        extra = { found: 'gold', gold, p, roll, rumorBoostActive: rb > 0 };
      }
    } else {
      summary = `${row.officer_name}이(가) 탐색했으나 성과가 없었다.`;
      meritGain = 30;
      fameGain = 1 + skillMods.fame_flat;
      extra = { found: 'none', p, roll, rumorBoostActive: rb > 0 };
    }
  } else if (command === 'spy') {
    apCost = 25;
    const input = String(payload.toCityId || payload.toCityName || '').trim();
    if (!input) throw new Error('payload.toCityId or payload.toCityName is required');

    const resolved = await resolveCityIdByIdOrName(client, input);
    if (!resolved) throw new Error('도시를 찾을 수 없습니다.');
    if (resolved.id === row.city_id) throw new Error('현재 도시는 정찰 대상이 아닙니다.');

    const edge = await client.query(`SELECT distance, terrain FROM edges WHERE from_city_id = $1 AND to_city_id = $2`, [
      row.city_id,
      resolved.id
    ]);
    if (!edge.rows.length) throw new Error('정찰은 현재 인접 도시만 가능합니다.');

    const acc = clamp(spyAccuracy(row.int_stat) + skillMods.spy_accuracy_flat, 0, 100);
    const city = await client.query(
      `SELECT id, name_kr, owner_force_id, gold, rice, population, commerce, farming, defense
       FROM cities WHERE id = $1`,
      [resolved.id]
    );
    const c = city.rows[0];
    const intel = {
      cityId: c.id,
      name: c.name_kr,
      owner_force_id:
        Math.random() < acc ? c.owner_force_id : ['wei', 'shu', 'wu', 'neutral'][Math.floor(Math.random() * 4)],
      gold: noisyValue(c.gold, acc),
      rice: noisyValue(c.rice, acc),
      population: noisyValue(c.population, acc),
      commerce: noisyValue(c.commerce, acc),
      farming: noisyValue(c.farming, acc),
      defense: noisyValue(c.defense, acc),
      accuracy: acc
    };
    summary = `${row.officer_name}이(가) ${c.name_kr}의 정찰 보고를 받았다.`;
    meritGain = 70;
    fameGain = 2 + skillMods.fame_flat;
    extra = { intel };
  } else if (command === 'employ') {
    apCost = 30;
    const targetId = String(payload.targetOfficerId || '');
    const targetName = String(payload.targetName || '');
    if (!targetId && !targetName) throw new Error('payload.targetOfficerId or payload.targetName is required');

    let resolvedTargetId = targetId;
    if (!resolvedTargetId && targetName) {
      const t2 = await client.query(
        `SELECT id FROM officers WHERE city_id=$1 AND force_id='ronin' AND name_kr ILIKE $2 ORDER BY war DESC LIMIT 1`,
        [row.city_id, `%${targetName}%`]
      );
      if (!t2.rows.length) throw new Error('같은 도시에서 해당 이름의 재야 장수를 찾을 수 없습니다.');
      resolvedTargetId = t2.rows[0].id;
    }

    const t = await client.query(
      `SELECT id, name_kr, loyalty, compatibility, force_id, city_id
            , leader_officer_id
       FROM officers
       WHERE id = $1
       FOR UPDATE`,
      [resolvedTargetId]
    );
    if (!t.rows.length) throw new Error('대상을 찾을 수 없습니다.');
    const target = t.rows[0];
    if (target.city_id !== row.city_id) throw new Error('같은 도시에 있어야 등용할 수 있습니다.');
    if (target.force_id !== 'ronin') throw new Error('현재는 재야 장수만 등용 가능합니다.');
    if (target.leader_officer_id) throw new Error('이미 다른 장수와 함께 움직이고 있습니다.');
    const isPlayer = await client.query(`SELECT 1 FROM players WHERE officer_id=$1 LIMIT 1`, [target.id]);
    if (isPlayer.rows.length) throw new Error('플레이어가 선택한 장수는 등용할 수 없습니다.');

    const rel = await client.query(
      `SELECT affinity_score
       FROM relationships
       WHERE source_officer_id=$1 AND target_officer_id=$2 AND rel_type='Acquaintance'`,
      [row.officer_id, target.id]
    );
    const affinityScore = rel.rows[0]?.affinity_score ?? 0;

    const delta = Math.abs(((row.officer_compatibility || 75) - (target.compatibility || 75) + 150) % 150);
    const compatAbs = Math.min(delta, 150 - delta);
    // Relationships and hidden traits influence employ chance.
    const targetHidden = await client.query(`SELECT hidden_stats FROM officers WHERE id=$1`, [target.id]);
    const tHidden = targetHidden.rows[0]?.hidden_stats || {};
    const tDuty = getHiddenStat(tHidden, 'duty', 50);
    const relBonus = clamp(Math.floor(affinityScore / 5), 0, 15);
    const dutyPenalty = clamp(Math.floor(tDuty / 12), 0, 8);
    const ambitionBonus = clamp(Math.floor(ambition / 25), 0, 4); // ambitious recruiters get a slight edge

    let chance = employChance(row.chr, target.loyalty, compatAbs);
    // CALM bonus: improves the odds for the next employ/search and is then consumed.
    const st = await getStoryState(client, row.officer_id);
    const calmBoost = asInt(st.flags?.calm_boost, 0);
    const calmBonus = clamp(calmBoost * 5, 0, 15);
    chance = clamp(chance + relBonus + ambitionBonus + calmBonus - dutyPenalty, 5, 95);
    const roll = Math.floor(Math.random() * 100) + 1;

    if (roll <= chance) {
      if (row.officer_force_id === 'ronin') {
        // Ronin play: recruit into your party instead of "hiring into a faction".
        await client.query(
          `UPDATE officers
           SET force_id = 'ronin', loyalty = 65, leader_officer_id = $1
           WHERE id = $2`,
          [row.officer_id, target.id]
        );
      } else {
        await client.query(`UPDATE officers SET force_id = $1, loyalty = 70, leader_officer_id = NULL WHERE id = $2`, [
          row.officer_force_id,
          target.id
        ]);
      }
      summary = `${row.officer_name}의 제안을 받아들여, ${target.name_kr}이(가) 함께 하기로 했다.`;
      meritGain = 200;
      fameGain = 2;
      await bumpRelationship(client, {
        sourceOfficerId: row.officer_id,
        targetOfficerId: target.id,
        relType: 'Acquaintance',
        delta: 12,
        note: 'employ:success'
      });
      extra = { targetId: target.id, success: true, chance, roll, affinityScore, relBonus, dutyPenalty, ambitionBonus, calmBonus };
    } else {
      summary = `${target.name_kr}이(가) 고개를 저었다. (지금은 함께하지 않겠다)`;
      meritGain = 60;
      fameGain = 1;
      await bumpRelationship(client, {
        sourceOfficerId: row.officer_id,
        targetOfficerId: target.id,
        relType: 'Acquaintance',
        delta: 5,
        note: 'employ:fail'
      });
      extra = { targetId: target.id, success: false, chance, roll, affinityScore, relBonus, dutyPenalty, ambitionBonus, calmBonus };
    }

    // Consume one CALM stack after an employ attempt.
    if (calmBoost > 0) {
      await client.query(
        `UPDATE story_states
         SET flags = jsonb_set(flags, '{calm_boost}', to_jsonb(GREATEST(0, (flags->>'calm_boost')::int - 1)), true),
             updated_at = now()
         WHERE officer_id = $1`,
        [row.officer_id]
      );
    }
  } else if (command === 'story') {
    apCost = 0;
    const st = await getStoryState(client, row.officer_id);
    const step = asInt(st.flags?.story_step, 0);
    const arc190 = asInt(st.flags?.arc190_stage, 0);
    const computed = computeStoryObjective({
      forceId: row.officer_force_id,
      role: row.officer_role,
      merit: row.merit,
      rank: row.rank,
      ambition,
      roninStep: step,
      arc190Stage: arc190
    });

    const ending = st.flags?.arc190_ending || null;
    const objective =
      arc190 >= 4
        ? ending && ending.endingName
          ? `챕터 종료: 연합은 해산했다. 열전 결말: [${ending.endingName}] (story로 확인)`
          : '챕터 종료: 연합은 해산했다. story로 열전을 확인하고, 다음 장(군웅할거)으로 넘어갈 준비를 하세요.'
        : computed.objective;
    // Allow story() to reveal unique rumors without requiring the player to "stumble" into them.
    let stFlagsNext = { ...(st.flags || {}), story_step: step, arc_id: st.flags?.arc_id || '190_anti_dong_zhuo' };
    try {
      const fameNow = asInt(row.fame, 0);
      const meritNow = asInt(row.merit, 0);
      for (const q of UNIQUE_QUEST_DEFS) {
        const cur = uqGet(stFlagsNext, q.key);
        if (cur.done || cur.active) continue;
        const needFame = asInt(q.unlock?.fame, 0);
        const needMerit = asInt(q.unlock?.merit, 0);
        const needArc = asInt(q.unlock?.arc190Stage, 0);
        if (fameNow < needFame) continue;
        if (meritNow < needMerit) continue;
        if (arc190 < needArc) continue;
        if (await isUniqueTaken(client, q.uniqueKey)) continue;
        stFlagsNext = uqSet(stFlagsNext, q.key, { stage: 1, active: true, done: false });
        await client.query(
          `INSERT INTO biography_logs (officer_id, event_type, event_data)
           VALUES ($1,$2,$3)`,
          [row.officer_id, 'quest', { summary: `유니크 소문: ${q.title} (진행 시작)`, questKey: q.key, stage: 1 }]
        );
      }
    } catch {
      // ignore
    }

    await client.query(
      `INSERT INTO story_states (officer_id, chapter, objective, flags, updated_at)
       VALUES ($1,$2,$3,$4::jsonb, now())
       ON CONFLICT (officer_id) DO UPDATE
       SET chapter=$2, objective=$3, flags=$4::jsonb, updated_at=now()`,
      [row.officer_id, computed.chapter, objective, JSON.stringify(stFlagsNext)]
    );
    // Lightweight progress board (easy & officer-centric)
    const tasks = [];
    if (row.officer_force_id === 'ronin') {
      tasks.push({ id: 'meet', text: '인맥 만들기 (socialize/visit)', done: step >= 1 });
      tasks.push({ id: 'setup', text: '기반 다지기 (calm/search)', done: step >= 2 });
      tasks.push({ id: 'move', text: '이동으로 기회 찾기 (travel)', done: step >= 3 });
      tasks.push({ id: 'choice', text: '동료 만들기 (employ)', done: step >= 4 });
    }
    // Unique quest board (only show active/done; keeps UI clean).
    for (const q of UNIQUE_QUEST_DEFS) {
      const qs = uqGet(stFlagsNext, q.key);
      if (!qs.active && !qs.done) continue;
      const stage = qs.done ? 3 : Math.max(1, Math.min(3, qs.stage));
      const label = qs.done
        ? `유니크: ${q.title} (완료)`
        : `유니크: ${q.title} (${stage}/3) ${q.stages.find((s) => s.stage === stage)?.text || ''}`;
      tasks.push({ id: `uq_${q.key}`, text: label, done: qs.done === true });
    }
    tasks.push({ id: 'arc190_1', text: '190 소문: 완 도착', done: arc190 >= 1 });
    tasks.push({ id: 'arc190_2', text: '190 소문: 낙양 정찰', done: arc190 >= 2 });
    tasks.push({ id: 'arc190_3', text: '190 소문: 낙양 도착', done: arc190 >= 3 });
    tasks.push({ id: 'arc190_4', text: '190 챕터: 연합 해산', done: arc190 >= 4 });

    // UI can render these as "story choice" buttons (easy mode).
    const choices = [];
    const addChoice = (label, cmd) => choices.push({ label, cmd });
    // Always include at least one safe action.
    addChoice('턴 종료(end_turn)', 'end_turn');
    addChoice('추천(next)', 'next');
    addChoice('자동(auto_day)', 'auto_day');

    if (arc190 < 1) addChoice('이동: 완(travel)', 'travel wan');
    else if (arc190 === 1) addChoice('정찰: 낙양(spy)', 'spy luo_yang');
    else if (arc190 === 2) addChoice('이동: 낙양(travel)', 'travel luo_yang');
    else if (arc190 === 3) addChoice('턴 종료(연합 해산)', 'end_turn');

    // Personal-growth helpers (officer-centric; avoids "lord game" words).
    if (row.ap >= 10) addChoice('인맥(socialize)', 'socialize');
    if (row.ap >= 10) addChoice('방문(visit)', 'visit');
    if (row.ap >= 20) addChoice('탐색(search)', 'search');
    if (row.ap >= 20) addChoice('수련(train)', 'train');
    if (row.ap >= 10) addChoice('진정(calm)', 'calm');
    addChoice('상점(shop)', 'shop');
    addChoice('인벤(inventory)', 'inventory');

    // Unique quest quick actions (buttons) to keep it easy.
    for (const q of UNIQUE_QUEST_DEFS) {
      const qs = uqGet(stFlagsNext, q.key);
      if (!qs.active || qs.done) continue;
      if (qs.stage === 1) addChoice(`유니크: ${q.title} 이동`, `travel ${q.cityId}`);
      if (qs.stage === 2) {
        // If the quest supports multiple "investigation" verbs, expose both.
        const cmds = (q.stages || []).find((s) => s.stage === 2)?.on?.cmdAny;
        if (Array.isArray(cmds) && cmds.length) {
          cmds.slice(0, 2).forEach((c) => addChoice(`유니크: ${q.title} 단서`, String(c)));
        } else {
          addChoice(`유니크: ${q.title} 단서`, 'search');
        }
      }
      if (qs.stage === 3) {
        addChoice(`유니크: ${q.title} 거래`, `deal ${q.key}`);
        addChoice(`유니크: ${q.title} 결투`, `duel ${q.key}`);
        // Relationship gate: only show if best affinity is high enough.
        try {
          const best = await bestAffinityInCity(client, { sourceOfficerId: row.officer_id, cityId: row.city_id });
          if (best.best >= 60) addChoice(`유니크: ${q.title} 인맥`, `favor ${q.key}`);
        } catch {
          // ignore
        }
      }
    }

    // Small episodes: created from story/end_turn and saved in flags. Here we only surface pending choices for UI.
    try {
      // Ensure there's an episode for today if none exists yet (story is a safe place to generate it).
      const gen = await maybeGenerateSmallEpisode(client, { row, objective });
      const flags0 = gen?.flags && typeof gen.flags === 'object' ? gen.flags : (await getStoryState(client, row.officer_id)).flags || {};
      const pending =
        (gen?.episode && typeof gen.episode === 'object' ? gen.episode : null) ||
        (flags0.pending_episode && typeof flags0.pending_episode === 'object' ? flags0.pending_episode : null);
      if (pending && Array.isArray(pending.options)) {
        const hook = String(pending.hook || '').slice(0, 120);
        const resolved = pending.resolved === true;
        addChoice(resolved ? `오늘의 에피소드 완료: ${hook}` : `에피소드: ${hook}`, 'story');
        if (!resolved) {
          pending.options
            .slice(0, 3)
            .forEach((o) => addChoice(`선택: ${o.label || o.verb}`, o.cmd || (o.verb === 'patrol' ? 'calm' : o.verb)));
        }
      }
    } catch {
      // ignore
    }

    summary = `${row.officer_name}의 목표: ${objective}`;
    meritGain = 0;
    fameGain = 0;
    extra = { chapter: computed.chapter, objective, step, arc190Stage: arc190, tasks, ending, choices };
  } else if (command === 'deal') {
    apCost = 0;
    const questKey = String(payload.questKey || payload.key || payload.item || '').trim() || String(payload?.id || '').trim();
    const key = questKey || String(payload?.quest || '').trim() || '';
    const q = UNIQUE_QUEST_DEFS.find((x) => x.key === key);
    if (!q) throw new Error('알 수 없는 거래입니다. 예) deal red_hare');

    const st = await getStoryState(client, row.officer_id);
    const flags0 = st.flags || {};
    const qs = uqGet(flags0, q.key);
    if (!qs.active || qs.done) throw new Error('해당 유니크는 현재 진행 중이 아닙니다. (story로 확인)');
    if (qs.stage < 3) throw new Error('아직 거래 단계가 아닙니다. (story로 확인)');

    const loc = await client.query(`SELECT city_id FROM officers WHERE id=$1`, [row.officer_id]);
    const cityIdNow = String(loc.rows[0]?.city_id || '');
    if (cityIdNow !== q.cityId) throw new Error('거래는 단서가 있는 도시에서만 가능합니다. (story를 확인)');

    const cost = asInt(q.costGold, 0);
    if (cost <= 0) throw new Error('거래 비용이 정의되지 않았습니다.');
    if (nextOfficerGold < cost) throw new Error(`금이 부족합니다. (필요: ${cost}, 보유: ${nextOfficerGold})`);
    nextOfficerGold -= cost;

    const r = await grantUniqueEquipmentOnce(client, {
      officerId: row.officer_id,
      flags: flags0,
      rewardKey: `uq_reward_${q.key}`,
      itemId: q.itemId,
      reason: q.title
    });
    const flags1 = r?.flags || flags0;
    const nextFlags = uqSet(flags1, q.key, { stage: 4, active: false, done: true });
    await client.query(`UPDATE story_states SET flags=$2::jsonb, updated_at=now() WHERE officer_id=$1`, [
      row.officer_id,
      JSON.stringify(nextFlags)
    ]);
    summary = `${row.officer_name}이(가) ${q.title}을(를) 확보했다. (금 -${cost})`;
    meritGain = 120;
    fameGain = 4;
    extra = { questKey: q.key, itemId: q.itemId, costGold: cost, equipment: r?.equipment || null };
  } else if (command === 'favor') {
    apCost = 10;
    const questKey = String(payload.questKey || payload.key || payload.item || '').trim();
    const q = UNIQUE_QUEST_DEFS.find((x) => x.key === questKey);
    if (!q) throw new Error('알 수 없는 부탁입니다. 예) favor red_hare');

    const st = await getStoryState(client, row.officer_id);
    const flags0 = st.flags || {};
    const qs = uqGet(flags0, q.key);
    if (!qs.active || qs.done) throw new Error('해당 유니크는 현재 진행 중이 아닙니다. (story로 확인)');
    if (qs.stage < 3) throw new Error('아직 확보 단계가 아닙니다. (story로 확인)');
    const loc = await client.query(`SELECT city_id FROM officers WHERE id=$1`, [row.officer_id]);
    const cityIdNow = String(loc.rows[0]?.city_id || '');
    if (cityIdNow !== q.cityId) throw new Error('단서가 있는 도시에서만 부탁을 시도할 수 있습니다.');

    const best = await bestAffinityInCity(client, { sourceOfficerId: row.officer_id, cityId: cityIdNow });
    if (best.best < 60 || !best.target) throw new Error('도시 내 인맥(친밀도)이 부족합니다. (socialize/visit/gift로 올려주세요)');

    // Spend relationship capital: reduce affinity to prevent spamming.
    await bumpRelationship(client, {
      sourceOfficerId: row.officer_id,
      targetOfficerId: best.target.id,
      relType: 'Acquaintance',
      delta: -20,
      note: `favor:${q.key}`
    });

    const r = await grantUniqueEquipmentOnce(client, {
      officerId: row.officer_id,
      flags: flags0,
      rewardKey: `uq_reward_${q.key}`,
      itemId: q.itemId,
      reason: `${q.title} (인맥)`
    });
    const flags1 = r?.flags || flags0;
    const nextFlags = uqSet(flags1, q.key, { stage: 4, active: false, done: true });
    await client.query(`UPDATE story_states SET flags=$2::jsonb, updated_at=now() WHERE officer_id=$1`, [
      row.officer_id,
      JSON.stringify(nextFlags)
    ]);

    summary = `${row.officer_name}이(가) [${best.target.name_kr}]의 소개로 ${q.title}을(를) 확보했다.`;
    meritGain = 140;
    fameGain = 5;
    extra = { questKey: q.key, itemId: q.itemId, via: 'favor', contact: best.target, equipment: r?.equipment || null };
  } else if (command === 'duel') {
    apCost = 25;
    const questKey = String(payload.questKey || payload.key || payload.item || '').trim();
    const q = UNIQUE_QUEST_DEFS.find((x) => x.key === questKey);
    if (!q) throw new Error('알 수 없는 결투입니다. 예) duel red_hare');

    const st = await getStoryState(client, row.officer_id);
    const flags0 = st.flags || {};
    const qs = uqGet(flags0, q.key);
    if (!qs.active || qs.done) throw new Error('해당 유니크는 현재 진행 중이 아닙니다. (story로 확인)');
    if (qs.stage < 3) throw new Error('아직 확보 단계가 아닙니다. (story로 확인)');
    const loc = await client.query(`SELECT city_id FROM officers WHERE id=$1`, [row.officer_id]);
    const cityIdNow = String(loc.rows[0]?.city_id || '');
    if (cityIdNow !== q.cityId) throw new Error('단서가 있는 도시에서만 결투를 시도할 수 있습니다.');

    // Cooldown: 1 attempt per in-game day per unique.
    const gt = await client.query(`SELECT year, month, day FROM game_time WHERE id = 1`);
    const g = gt.rows[0] || { year: 0, month: 0, day: 0 };
    const dayKey = `${g.year}.${g.month}.${g.day}`;
    const duelFlags = flags0.unique_duels && typeof flags0.unique_duels === 'object' ? flags0.unique_duels : {};
    const last = duelFlags[q.key] && typeof duelFlags[q.key] === 'string' ? duelFlags[q.key] : '';
    if (last === dayKey) throw new Error('오늘은 이미 결투를 시도했습니다. (end_turn/auto_day로 다음 날)');

    const war = asInt(row.war, 0);
    const ldr = asInt(row.ldr, 0);
    const fame = asInt(row.fame, 0);
    const merit0 = asInt(row.merit, 0);
    const base = (war + ldr) / 220; // ~0.45..0.8 for strong officers
    const plus = fame / 220 + merit0 / 8000; // small progression bonus
    const chance = clamp(base + plus, 0.25, 0.82);
    const roll = parseInt(sha256Hex(`duel|${row.officer_id}|${dayKey}|${q.key}`).slice(0, 8), 16) / 0xffffffff;
    const win = roll < chance;

    const flags1 = { ...flags0, unique_duels: { ...duelFlags, [q.key]: dayKey } };
    await client.query(`UPDATE story_states SET flags=$2::jsonb, updated_at=now() WHERE officer_id=$1`, [
      row.officer_id,
      JSON.stringify(flags1)
    ]);

    if (!win) {
      summary = `${row.officer_name}이(가) 결투에 나섰으나 빈틈을 찾지 못했다. (성공 확률 ${(chance * 100).toFixed(0)}%)`;
      meritGain = 60;
      fameGain = 1;
      extra = { questKey: q.key, win: false, chance, roll };
    } else {
      const r = await grantUniqueEquipmentOnce(client, {
        officerId: row.officer_id,
        flags: flags1,
        rewardKey: `uq_reward_${q.key}`,
        itemId: q.itemId,
        reason: `${q.title} (결투)`
      });
      const flags2 = r?.flags || flags1;
      const nextFlags = uqSet(flags2, q.key, { stage: 4, active: false, done: true });
      await client.query(`UPDATE story_states SET flags=$2::jsonb, updated_at=now() WHERE officer_id=$1`, [
        row.officer_id,
        JSON.stringify(nextFlags)
      ]);
      summary = `${row.officer_name}이(가) 결투에서 승리해 ${q.title}을(를) 손에 넣었다.`;
      meritGain = 220;
      fameGain = 7;
      extra = { questKey: q.key, win: true, chance, roll, itemId: q.itemId, equipment: r?.equipment || null };
    }
  } else if (command === 'portrait_set') {
    apCost = 0;
    const prompt = String(payload?.prompt || '').trim();
    if (!prompt) throw new Error('portrait_set: prompt가 비었습니다.');
    // Allow longer, model-friendly prompts. Keep a sane upper bound to prevent abuse.
    if (prompt.length > 2000) throw new Error('portrait_set: prompt가 너무 깁니다. (최대 2000자)');
    await client.query(`UPDATE officers SET portrait_prompt=$1 WHERE id=$2`, [prompt, row.officer_id]);
    summary = '초상 프롬프트를 저장했습니다. (나중에 초상 생성에 사용)';
    meritGain = 0;
    fameGain = 0;
    extra = { prompt };
  } else {
    throw new Error(`지원하지 않는 커맨드: ${command}`);
  }

  // Progression: add XP for most actions, level up, and award skill points.
  const noXp = new Set([
    'next',
    'end_turn',
    'story',
    'shop',
    'inventory',
    'skills',
    'skill_unlock',
    'skill_equip',
    'skill_unequip',
    'portrait_set'
  ]);
  const xpGain =
    noXp.has(command) ? 0 : Math.max(0, Math.floor(asInt(meritGain, 0) / 20) + asInt(fameGain, 0) + (apCost > 0 ? 2 : 0));
  let nextLevel = asInt(row.officer_level, 1);
  let nextXP = asInt(row.officer_xp, 0) + xpGain;
  let nextSkillPoints = asInt(row.officer_skill_points, 0);
  let leveled = false;
  while (nextLevel < 30) {
    const need = xpNeededForLevel(nextLevel + 1);
    if (nextXP < need) break;
    nextXP -= need;
    nextLevel += 1;
    nextSkillPoints += 1;
    leveled = true;
  }
  if (leveled) {
    extra = { ...(extra || {}), level_up: { level: nextLevel, skill_points: nextSkillPoints, xp: nextXP } };
  }

  let nextAP = consumeAP(row, apCost);
  if (overrideNextAP != null) nextAP = overrideNextAP;
  const nextMerit = updateMerit(row.merit, meritGain);
  const nextRank = nextRankByMerit(nextMerit);
  const nextFame = clamp(asInt(row.fame, 0) + asInt(fameGain, 0), 0, 999999);

  await client.query(
    'UPDATE officers SET ap=$1, merit=$2, rank=$3, fame=$4, status=$5, city_id=$6, gold=$7, level=$8, xp=$9, skill_points=$10 WHERE id=$11',
    [nextAP, nextMerit, nextRank, nextFame, command, nextOfficerCityId, nextOfficerGold, nextLevel, nextXP, nextSkillPoints, row.officer_id]
  );

  // Update story progression after the command (keeps game easy and guided).
  if (command !== 'story') {
    const st = await updateStoryAfterCommand(client, {
      officerId: row.officer_id,
      command,
      payload,
      extra,
      forceId: nextForceId,
      role: nextRole,
      merit: nextMerit,
      rank: nextRank,
      prevRank: row.rank,
      ambition
    });
    if (st?.reward) {
      extra = { ...(extra || {}), reward: st.reward };
    }
  }

  // Fame can be mutated by story milestones (grantFameOnce). Reflect latest DB value in the response.
  const fameRow = await client.query(`SELECT fame FROM officers WHERE id=$1`, [row.officer_id]);
  const finalFame = asInt(fameRow.rows[0]?.fame, nextFame);

  const response = {
    ok: true,
    summary,
    officer: {
      id: row.officer_id,
      name: row.officer_name,
      ap: nextAP,
      merit: nextMerit,
      fame: finalFame,
      rank: nextRank,
      cityId: nextOfficerCityId,
      level: nextLevel,
      xp: nextXP,
      skill_points: nextSkillPoints
    },
    extra: { ...(extra || {}), xpGain }
  };

  const bio = await client.query(
    `INSERT INTO biography_logs (officer_id, event_type, event_data)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [row.officer_id, command, { summary, payload }]
  );
  const bioLogId = bio.rows[0]?.id || null;

  if (options.logResult && key) {
    await client.query(
      `INSERT INTO command_logs (idempotency_key, player_id, command_name, payload, result)
       VALUES ($1, $2, $3, $4, $5)`,
      [key, playerId, command, payload, response]
    );
  }

  if (options.narrate) {
    const target =
      extra?.targetName ||
      extra?.toCityName ||
      (Array.isArray(extra?.targets) ? extra.targets.map((t) => t?.name_kr).filter(Boolean).join(', ') : null) ||
      null;
    await biographyQueue.add('narrate', {
      bioLogId,
      officerId: row.officer_id,
      actor: row.officer_name,
      actorRole: row.officer_role || 'officer',
      target,
      command,
      summary
    });
  }
  if (options.emit) {
    io.to(`officer:${row.officer_id}`).emit('game-event', response);
  }
  return response;
}

async function tickGameDay() {
  return withTx(async (client) => {
    await client.query('UPDATE game_time SET day = day + 1, updated_at = now() WHERE id = 1');

    const now = await client.query('SELECT year, month, day FROM game_time WHERE id = 1 FOR UPDATE');
    let { year, month, day } = now.rows[0];

    // New day: restore AP for all officers (easy-mode friendly).
    await client.query('UPDATE officers SET ap = 100');

    if (day > 30) {
      day = 1;
      month += 1;
      await client.query('UPDATE cities SET gold = gold + commerce * 10, rice = rice + farming * 20');
    }

    if (month > 12) {
      month = 1;
      year += 1;
    }

    await client.query('UPDATE game_time SET year = $1, month = $2, day = $3, updated_at = now() WHERE id = 1', [
      year,
      month,
      day
    ]);
    return { year, month, day };
  });
}

app.post('/api/game/command', async (req, res) => {
  const key = req.header('Idempotency-Key') || null;
  const { playerId, command, payload = {} } = req.body || {};
  if (!playerId || !command) return res.status(400).json({ error: 'playerId and command are required' });

  try {
    const result = await withTx(async (client) =>
      runGameCommandInTx(client, { playerId, command, payload, key }, {})
    );
    res.json(result);
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message || 'command failed' });
  }
});

function normalizeChatText(text) {
  const s = String(text || '').trim();
  if (!s) return '';
  // Strip leading slash commands (/status -> status)
  if (s.startsWith('/')) return s.slice(1).trim();
  return s;
}

function chatToCommand(text) {
  const s = normalizeChatText(text);
  if (!s) return { command: 'next', payload: {} };

  // Direct verb form: "travel 허창"
  const parts = s.split(/\s+/).filter(Boolean);
  const verb = (parts[0] || '').toLowerCase();
  const arg = parts.slice(1).join(' ').trim();

  const direct = new Set([
    'status',
    'next',
    'end_turn',
    'story',
    'rest',
    'train',
    'search',
    'socialize',
    'visit',
    'gift',
    'banquet',
    'employ',
    'travel',
    'spy',
    'city',
    'auto_day',
    'calm',
    'work',
    'shop',
    'buy',
    'use',
    'inventory',
    'equip',
    'unequip',
    'deal',
    'duel',
    'favor',
    'skirmish',
    'breakout',
    'scout_accept',
    'scout_decline',
    'scout_join',
    'scout_backout',
    'skills',
    'skill_unlock',
    'skill_equip',
    'skill_unequip'
  ]);
  if (direct.has(verb)) {
    if (verb === 'travel') return { command: 'travel', payload: { toCityId: arg, toCityName: arg } };
    if (verb === 'spy') return { command: 'spy', payload: { toCityId: arg, toCityName: arg } };
    if (verb === 'city') return { command: `city ${arg}`.trim(), payload: {} }; // handled by UI only; keep fallback below
    if (verb === 'employ') return { command: 'employ', payload: { targetOfficerId: arg, targetName: arg } };
    if (verb === 'visit') return { command: 'visit', payload: { targetOfficerId: arg, targetName: arg } };
    if (verb === 'gift') return { command: 'gift', payload: { targetOfficerId: arg, targetName: arg } };
    if (verb === 'auto_day') return { command: 'auto_day', payload: {} };
    if (verb === 'end_turn') return { command: 'end_turn', payload: {} };
    if (verb === 'buy') return { command: 'buy', payload: { itemId: arg } };
    if (verb === 'use') return { command: 'use', payload: { itemId: arg } };
    if (verb === 'equip') return { command: 'equip', payload: { itemId: arg } };
    if (verb === 'unequip') return { command: 'unequip', payload: { slot: arg } };
    if (verb === 'deal') return { command: 'deal', payload: { questKey: arg } };
    if (verb === 'duel') return { command: 'duel', payload: { questKey: arg } };
    if (verb === 'favor') return { command: 'favor', payload: { questKey: arg } };
    if (verb === 'skirmish') return { command: 'skirmish', payload: {} };
    if (verb === 'breakout') return { command: 'breakout', payload: {} };
    if (verb === 'scout_accept') return { command: 'scout_accept', payload: { factionId: arg } };
    if (verb === 'scout_decline') return { command: 'scout_decline', payload: { factionId: arg } };
    if (verb === 'scout_join') return { command: 'scout_join', payload: { factionId: arg } };
    if (verb === 'scout_backout') return { command: 'scout_backout', payload: { factionId: arg } };
    if (verb === 'skills') return { command: 'skills', payload: {} };
    if (verb === 'skill_unlock') return { command: 'skill_unlock', payload: { skillId: arg } };
    if (verb === 'skill_equip') {
      const parts2 = arg.split(/\s+/).filter(Boolean);
      const slot = (parts2[0] || '').trim();
      const id = parts2.slice(1).join(' ').trim();
      return { command: 'skill_equip', payload: { slot, skillId: id } };
    }
    if (verb === 'skill_unequip') return { command: 'skill_unequip', payload: { slot: arg } };
    return { command: verb, payload: {} };
  }

  // Natural language heuristics (Korean)
  if (/(다음|추천|뭐\s*하지)/.test(s)) return { command: 'next', payload: {} };
  if (/(스토리|임무|목표)/.test(s)) return { command: 'story', payload: {} };
  if (/(상태|스탯|내\s*정보|내정보)/.test(s)) return { command: 'status', payload: {} };
  if (/(스킬|빌드|skill|룬)/i.test(s)) return { command: 'skills', payload: {} };
  if (/(턴\s*종료|오늘\s*끝|하루\s*넘겨|날짜\s*진행)/.test(s)) return { command: 'end_turn', payload: {} };
  if (/(결투|대련|난투|투기장|오토\s*전투|skirmish)/i.test(s)) return { command: 'skirmish', payload: {} };
  if (/(탈출|도망|breakout)/i.test(s)) return { command: 'breakout', payload: {} };
  if (/(휴식|쉬자|회복)/.test(s)) return { command: 'rest', payload: {} };
  if (/(훈련|수련|단련)/.test(s)) return { command: 'train', payload: {} };
  if (/(탐색|수색|둘러|찾아)/.test(s)) return { command: 'search', payload: {} };
  if (/(교류|사교|주막|술|인맥)/.test(s)) return { command: 'socialize', payload: {} };
  if (/(진정|소요|소문\s*잡|calm)/i.test(s)) return { command: 'calm', payload: {} };
  if (/(보급|현장|지원|work)/i.test(s)) return { command: 'work', payload: {} };
  if (/(연회|잔치|banquet)/i.test(s)) return { command: 'banquet', payload: {} };
  if (/(임관|세력\s*가입|입단|관직|태수|도독|군주)/.test(s)) return { command: 'story', payload: {} };

  const employMatch = s.match(/(?:인재\s*등용|등용|영입|모셔)\s+(.+)$/);
  if (employMatch && employMatch[1]) return { command: 'employ', payload: { targetOfficerId: employMatch[1].trim(), targetName: employMatch[1].trim() } };

  const travelMatch = s.match(/(?:이동|가자|가서|여행|출발)\s+(.+)$/);
  if (travelMatch && travelMatch[1]) {
    const t = travelMatch[1].trim();
    return { command: 'travel', payload: { toCityId: t, toCityName: t } };
  }

  const spyMatch = s.match(/(?:정찰|첩보|살펴)\s+(.+)$/);
  if (spyMatch && spyMatch[1]) {
    const t = spyMatch[1].trim();
    return { command: 'spy', payload: { toCityId: t, toCityName: t } };
  }

  return { command: 'next', payload: {} };
}

function friendlyChatError(errMsg, attemptedCommand) {
  const msg = String(errMsg || 'unknown error');
  const cmd = String(attemptedCommand || '');
  if (msg.includes('AP가 부족'))
    return `AP가 부족합니다. end_turn/auto_day로 다음 날로 넘기는 것이 가장 확실합니다. (rest는 같은 날에 제한이 있습니다) (${msg})`;
  if (cmd === 'employ' || /등용/.test(cmd)) {
    if (msg.includes('같은 도시에') || msg.includes('대상을 찾을 수')) {
      return `등용은 "같은 도시에 있는 재야 장수"에게만 가능합니다. 먼저 socialize/visit로 인맥을 만들고, 필요하면 travel로 도시를 옮긴 뒤 employ 하세요. (사유: ${msg})`;
    }
  }
  if (cmd === 'travel' && msg.includes('도시명이 모호')) return `도시명이 모호합니다. 더 정확히 입력해 주세요. (사유: ${msg})`;
  return `실패: ${msg}\n도움말: end_turn(턴 종료), next(추천), story(목표), status(상태)`;
}

app.post('/api/game/chat', async (req, res) => {
  const { telegramUserId, text, username = null, officerId = null } = req.body || {};
  if (!telegramUserId || !text) return res.status(400).json({ ok: false, error: 'telegramUserId and text are required' });

  try {
    const result = await withTx(async (client) => {
      // Serialize per Telegram user to avoid deadlocks when multiple messages arrive at once.
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`, [String(telegramUserId)]);

      const existing = await client.query('SELECT * FROM players WHERE telegram_user_id = $1', [String(telegramUserId)]);
      let player = existing.rows[0] || null;
      if (!player) {
        // Create a player for this Telegram user (prefer officer selection if provided).
        const body = {
          username: username || `tg_${String(telegramUserId).slice(-6)}`,
          telegramUserId: String(telegramUserId),
          officerId: officerId || null
        };
        // Reuse the same bootstrap implementation.
        const inserted = await (async () => {
          const { username: u, telegramUserId: tgid, officerId: oid } = body;
          const r = await client.query('SELECT * FROM players WHERE telegram_user_id = $1', [tgid]);
          if (r.rows.length) return r.rows[0];

          // Call the same logic: officer selection if provided, else anonymous ronin.
          let pickedOfficerId = null;
          const wantId = typeof oid === 'string' ? oid.trim() : '';
          if (wantId) {
            const q = await client.query(`SELECT id FROM officers WHERE id=$1 LIMIT 1`, [wantId]);
            if (!q.rows.length) throw new Error('선택한 장수를 찾을 수 없습니다.');
            pickedOfficerId = q.rows[0].id;
            const taken = await client.query(`SELECT 1 FROM players WHERE officer_id=$1 LIMIT 1`, [pickedOfficerId]);
            if (taken.rows.length) throw new Error('이미 다른 플레이어가 선택한 장수입니다. 다른 장수를 선택하세요.');
          } else {
            const personalities = ['대담', '냉정', '소심', '저돌', '신중'];
            const hidden = { ambition: Math.floor(Math.random() * 101), duty: Math.floor(Math.random() * 101), affinity: Math.floor(Math.random() * 150) };
            const officer = await client.query(
              `INSERT INTO officers (id, name_kr, war, int_stat, pol, chr, ldr, force_id, city_id, rank, personality, hidden_stats, gold, is_playable, is_historical)
               VALUES ('off_' || substr(md5(random()::text), 1, 8), $1, 72, 68, 70, 73, 71, 'ronin', 'xiang_yang', 9, $2, $3::jsonb, 500, FALSE, FALSE)
               RETURNING id`,
              [u, personalities[Math.floor(Math.random() * personalities.length)], JSON.stringify(hidden)]
            );
            pickedOfficerId = officer.rows[0].id;
          }

          const ins = await client.query(
            `INSERT INTO players (telegram_user_id, username, officer_id)
             VALUES ($1, $2, $3)
             RETURNING *`,
            [tgid, u, pickedOfficerId]
          );
          return ins.rows[0];
        })();
        player = inserted;
      }

      const mapped = chatToCommand(text);
      // Reject "city" for now because it is a GET endpoint in this project.
      if (String(mapped.command || '').startsWith('city')) {
        return { ok: true, playerId: player.id, reply: '도시 정보는 현재 웹 UI에서 확인 가능합니다. (map_nearby -> 도시 클릭)' };
      }

      try {
        const cmdResult = await runGameCommandInTx(
          client,
          { playerId: player.id, command: mapped.command, payload: mapped.payload || {}, key: null },
          { idempotency: false }
        );
        return { ok: true, playerId: player.id, reply: cmdResult.summary, data: cmdResult };
      } catch (err) {
        const em = err?.message ? String(err.message) : String(err);
        return { ok: true, playerId: player.id, reply: friendlyChatError(em, mapped.command), error: em };
      }
    });

    res.json(result);
  } catch (err) {
    res.status(400).json({ ok: false, error: err?.message ? String(err.message) : String(err) });
  }
});

app.post('/api/game/tick/day', async (_req, res) => {
  const result = await tickGameDay();
  res.json({ ok: true, gameTime: result });
});

app.post('/api/battle/start', async (req, res) => {
  const { playerId } = req.body || {};
  if (!playerId) return res.status(400).json({ error: 'playerId is required' });

  try {
    const result = await withTx(async (client) => {
      const p = await client.query(
        `SELECT p.id AS player_id, o.id AS officer_id, o.name_kr, o.war, o.ap
         FROM players p JOIN officers o ON o.id = p.officer_id
         WHERE p.id = $1
         FOR UPDATE`,
        [playerId]
      );
      if (!p.rows.length) throw new Error('플레이어를 찾을 수 없습니다.');
      const row = p.rows[0];
      if (row.ap < 10) throw new Error('전투 시작 AP(10)가 부족합니다.');

      const existing = await client.query(
        `SELECT id FROM battles WHERE player_id = $1 AND status = 'ongoing' LIMIT 1`,
        [playerId]
      );
      if (existing.rows.length) {
        return { battleId: existing.rows[0].id, reused: true };
      }

      const mapRows = generateBattleMap();
      const battleIdRes = await client.query(`SELECT 'bat_' || substr(md5(random()::text),1,12) AS id`);
      const battleId = battleIdRes.rows[0].id;

      await client.query(
        `INSERT INTO battles (
          id, player_id, officer_id, enemy_name, player_hp, enemy_hp,
          player_x, player_y, enemy_x, enemy_y, map_json, last_log
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          battleId,
          playerId,
          row.officer_id,
          '황건 잔당',
          120,
          120,
          1,
          1,
          BATTLE_SIZE.width - 2,
          BATTLE_SIZE.height - 2,
          JSON.stringify(mapRows),
          '전투가 시작되었다.'
        ]
      );

      await client.query(
        `UPDATE officers SET ap = ap - 10, status = 'battle' WHERE id = $1`,
        [row.officer_id]
      );

      return { battleId, reused: false };
    });

    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message || 'battle start failed' });
  }
});

app.get('/api/battle/:battleId/state', async (req, res) => {
  const { battleId } = req.params;
  const q = await pool.query(`SELECT * FROM battles WHERE id = $1`, [battleId]);
  if (!q.rows.length) return res.status(404).json({ error: 'battle not found' });
  const b = q.rows[0];
  const mapRows = Array.isArray(b.map_json) ? b.map_json : b.map_json;
  const rendered = renderBattleMap(
    mapRows,
    { x: b.player_x, y: b.player_y },
    { x: b.enemy_x, y: b.enemy_y }
  );
  res.json({
    ok: true,
    battle: {
      id: b.id,
      status: b.status,
      turn: b.turn_count,
      playerHp: b.player_hp,
      enemyHp: b.enemy_hp,
      lastLog: b.last_log,
      map: rendered
    }
  });
});

app.post('/api/battle/:battleId/action', async (req, res) => {
  const { battleId } = req.params;
  const { action, direction } = req.body || {};
  if (!action) return res.status(400).json({ error: 'action is required' });

  try {
    const result = await withTx(async (client) => {
      const bq = await client.query(`SELECT * FROM battles WHERE id = $1 FOR UPDATE`, [battleId]);
      if (!bq.rows.length) throw new Error('battle not found');
      const b = bq.rows[0];
      if (b.status !== 'ongoing') throw new Error(`이미 종료된 전투입니다: ${b.status}`);

      const oq = await client.query(`SELECT id, name_kr, war FROM officers WHERE id = $1`, [b.officer_id]);
      if (!oq.rows.length) throw new Error('officer not found');
      const officer = oq.rows[0];

      const mapRows = Array.isArray(b.map_json) ? b.map_json : b.map_json;
      let playerPos = { x: b.player_x, y: b.player_y };
      let enemyPos = { x: b.enemy_x, y: b.enemy_y };
      let playerHp = b.player_hp;
      let enemyHp = b.enemy_hp;
      let status = b.status;
      let log = '';

      if (action === 'move') {
        const d = String(direction || '').toLowerCase();
        if (!['n', 's', 'e', 'w'].includes(d)) throw new Error('direction must be n/s/e/w');
        const moved = tryMove(mapRows, playerPos, d);
        playerPos = moved;
        log = `${officer.name_kr}이(가) ${d.toUpperCase()} 방향으로 이동했다.`;
      } else if (action === 'attack') {
        if (isAdjacent(playerPos, enemyPos)) {
          const eqRow = await client.query(`SELECT inventory, equipment, equipped_skills FROM officers WHERE id=$1`, [b.officer_id]);
          const wb = await getWeaponBonusFlat(client, eqRow.rows[0]?.equipment, eqRow.rows[0]?.inventory);
          const sm = equippedSkillMods({ officer_equipped_skills: eqRow.rows[0]?.equipped_skills });
          const dmg = calcPlayerDamage(officer.war, wb.bonus + asInt(sm.battle_attack_flat, 0));
          enemyHp = Math.max(0, enemyHp - dmg);
          log = `${officer.name_kr}의 공격! 적에게 ${dmg} 피해.${wb.bonus ? ` (장비 +${wb.bonus})` : ''}${sm.battle_attack_flat ? ` (스킬 +${sm.battle_attack_flat})` : ''}`;
        } else {
          log = '공격 사거리가 닿지 않는다.';
        }
      } else if (action === 'wait') {
        log = `${officer.name_kr}은(는) 숨을 고르며 진형을 유지했다.`;
      } else {
        throw new Error(`지원하지 않는 전투 액션: ${action}`);
      }

      if (enemyHp <= 0) {
        status = 'victory';
        log += ' 적 장수가 쓰러졌다. 승리!';
        await client.query(`UPDATE officers SET merit = merit + 300, status = 'idle' WHERE id = $1`, [
          b.officer_id
        ]);
      } else {
        enemyPos = enemyStep(mapRows, enemyPos, playerPos);
        if (isAdjacent(playerPos, enemyPos)) {
          const enemyDmg = calcEnemyDamage();
          playerHp = Math.max(0, playerHp - enemyDmg);
          log += ` 적의 반격으로 ${enemyDmg} 피해를 입었다.`;
        }
        if (playerHp <= 0) {
          status = 'defeat';
          log += ' 아군이 붕괴했다. 패배...';
          await client.query(`UPDATE officers SET status = 'idle' WHERE id = $1`, [b.officer_id]);
        }
      }

      await client.query(
        `UPDATE battles
         SET player_hp = $1, enemy_hp = $2,
             player_x = $3, player_y = $4,
             enemy_x = $5, enemy_y = $6,
             turn_count = turn_count + 1,
             status = $7, last_log = $8, updated_at = now()
         WHERE id = $9`,
        [
          playerHp,
          enemyHp,
          playerPos.x,
          playerPos.y,
          enemyPos.x,
          enemyPos.y,
          status,
          log,
          battleId
        ]
      );

      const rendered = renderBattleMap(mapRows, playerPos, enemyPos);
      return { battleId, status, turn: b.turn_count + 1, playerHp, enemyHp, log, map: rendered };
    });
    res.json({ ok: true, battle: result });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message || 'battle action failed' });
  }
});

function makeEmptyGrid(w, h, fill = null) {
  const W = Math.max(1, Math.min(32, asInt(w, 7)));
  const H = Math.max(1, Math.min(32, asInt(h, 4)));
  return Array.from({ length: H }, () => Array.from({ length: W }, () => fill));
}

function randomSeed64String() {
  // Store as base-10 string to avoid bigint/pg edge cases across runtimes.
  const b = crypto.randomBytes(8);
  const hex = b.toString('hex');
  const n = BigInt(`0x${hex}`);
  return n.toString(10);
}

function rngHex8FromParts(...parts) {
  return sha256Hex(parts.map((p) => String(p ?? '')).join('|')).slice(0, 8);
}

function getAutobattlerRoster() {
  // Reuse playable officers as the MVP roster (exactly 12 in world190.js).
  const roster = (seedOfficers || []).filter((o) => o && o.is_playable);
  const costs = {
    // Cost tiers (MVP): create basic shop pacing.
    lu_bu: 3,
    cao_cao: 3,
    guan_yu: 2,
    zhao_yun: 2,
    yuan_shao: 2,
    xun_yu: 2,
    xiahou_dun: 2,
    xiahou_yuan: 2,
    liu_bei: 2,
    sun_jian: 2,
    zhang_fei: 1,
    diaochan: 2
  };
  return roster.map((o) => ({
    unitId: o.id,
    name: o.name_kr,
    cost: asInt(costs[o.id] ?? 1, 1),
    tags: [String(o.force_id || '').trim(), 'officer'].filter(Boolean)
  }));
}

function generateShopSlots({ matchSeed, round, rollsUsed, count = 5 }) {
  const roster = getAutobattlerRoster();
  const rand = seededRng(rngHex8FromParts('shop', matchSeed, round, rollsUsed));
  const pool = roster.map((u) => {
    // Early rounds bias toward cheaper units.
    const r = Math.max(1, asInt(round, 1));
    const base = u.cost === 1 ? 1.8 : u.cost === 2 ? 1.1 : 0.55;
    const curve = r <= 3 ? 1.0 : r <= 6 ? 0.9 : 0.8;
    return { ...u, weight: base * curve };
  });
  const picks = pickWeightedUnique(pool, Math.max(1, Math.min(9, asInt(count, 5))), rand);
  return picks.map((p) => ({ unitId: p.unitId, name: p.name, cost: p.cost, tags: p.tags }));
}

const STORY_EVENT_DEFS = [
  {
    id: 'black_market',
    title: '암시장 상인',
    body: '낡은 천막 아래, 상인이 귓속말을 건넨다. "오늘은 운이 좋군."',
    weight: 1.2,
    choices: [
      { id: 'skip', label: '지나친다', effects: {} },
      { id: 'reroll_discount', label: '정보를 산다 (G -2, 이번 라운드 리롤 -1)', effects: { gold: -2, reroll_cost_delta: -1 } },
      { id: 'gold_cache', label: '숨은 금고 (G +4)', effects: { gold: 4 } }
    ]
  },
  {
    id: 'recruit_notice',
    title: '등용 공고',
    body: '관청 게시판에 등용 공고가 붙었다. 인재가 몰릴지도 모른다.',
    weight: 1.0,
    choices: [
      { id: 'skip', label: '무시한다', effects: {} },
      { id: 'shop_plus', label: '사람을 푼다 (G -2, 이번 라운드 상점 +1)', effects: { gold: -2, shop_slots_delta: 1 } },
      { id: 'gold_small', label: '일당을 받는다 (G +2)', effects: { gold: 2 } }
    ]
  },
  {
    id: 'field_rumor',
    title: '전장의 소문',
    body: '병사들이 수군댄다. 상대의 약점이 보인다는 말도 있다.',
    weight: 0.9,
    choices: [
      { id: 'skip', label: '듣지 않는다', effects: {} },
      { id: 'gold_trade', label: '뇌물을 건넨다 (G -3, 이번 라운드 리롤 -1)', effects: { gold: -3, reroll_cost_delta: -1 } },
      { id: 'gold_gain', label: '전리품을 챙긴다 (G +3)', effects: { gold: 3 } }
    ]
  }
];

function pickStoryEvent({ matchSeed, matchId, round, seat }) {
  const rand = seededRng(rngHex8FromParts('story', matchSeed, matchId, round, seat));
  const pool = STORY_EVENT_DEFS.map((e) => ({ ...e, weight: Number(e.weight || 1) }));
  const picked = pickWeightedUnique(pool, 1, rand)[0] || STORY_EVENT_DEFS[0];
  const choices = Array.isArray(picked.choices) ? picked.choices.slice(0, 3) : [{ id: 'skip', label: '지나친다', effects: {} }];
  return { event_id: picked.id, title: picked.title, body: picked.body, choices };
}

function effectsForRound(effects, round) {
  const e = effects && typeof effects === 'object' ? effects : {};
  const r = asInt(e.round, 0);
  if (r !== asInt(round, 0)) return { round: asInt(round, 0), reroll_cost_delta: 0, shop_slots_delta: 0 };
  return {
    round: r,
    reroll_cost_delta: asInt(e.reroll_cost_delta, 0),
    shop_slots_delta: asInt(e.shop_slots_delta, 0)
  };
}

async function ensureStoryEventForSeat(client, { matchId, matchSeed, seat, round }) {
  const r = await client.query(
    `SELECT status FROM match_story_events WHERE match_id=$1 AND seat=$2 AND round=$3`,
    [matchId, seat, round]
  );
  if (r.rows.length) return;
  const ev = pickStoryEvent({ matchSeed, matchId, round, seat });
  await client.query(
    `INSERT INTO match_story_events (match_id, seat, round, status, event_id, title, body, choices)
     VALUES ($1, $2, $3, 'pending', $4, $5, $6, $7::jsonb)`,
    [matchId, seat, round, ev.event_id, ev.title, ev.body, JSON.stringify(ev.choices)]
  );
}

async function assertNoPendingStory(client, { matchId, seat, round }) {
  const q = await client.query(
    `SELECT status FROM match_story_events WHERE match_id=$1 AND seat=$2 AND round=$3 AND status='pending'`,
    [matchId, seat, round]
  );
  if (q.rows.length) throw new Error('스토리 선택이 남아 있습니다. (먼저 story card 선택)');
}

async function applyStoryChoiceTx(client, { matchId, matchSeed, seat, round, choiceId, auto = false }) {
  const evq = await client.query(
    `SELECT status, event_id, title, body, choices
     FROM match_story_events
     WHERE match_id=$1 AND seat=$2 AND round=$3
     FOR UPDATE`,
    [matchId, seat, round]
  );
  if (!evq.rows.length) throw new Error('story event not found');
  const ev = evq.rows[0];
  if (String(ev.status || '') !== 'pending') return { ok: true, already: true };
  const choices = Array.isArray(ev.choices) ? ev.choices : [];
  const cid = String(choiceId || '').trim();
  const hit = choices.find((c) => c && String(c.id || '').trim() === cid) || null;
  if (!hit) throw new Error('invalid choice');
  const eff = hit.effects && typeof hit.effects === 'object' ? hit.effects : {};

  const pr = await client.query(`SELECT gold, effects FROM match_players WHERE match_id=$1 AND seat=$2 FOR UPDATE`, [matchId, seat]);
  if (!pr.rows.length) throw new Error('match player not found');
  const gold0 = asInt(pr.rows[0].gold, 0);
  const goldDelta = asInt(eff.gold, 0);
  if (goldDelta < 0 && gold0 < Math.abs(goldDelta)) {
    if (auto) {
      // Auto choice fallback: treat as skip if unaffordable.
      return applyStoryChoiceTx(client, { matchId, matchSeed, seat, round, choiceId: 'skip', auto: true });
    }
    throw new Error('gold is not enough for this choice');
  }

  const prevEff = effectsForRound(pr.rows[0].effects, round);
  const nextEff = {
    round,
    reroll_cost_delta: prevEff.reroll_cost_delta + asInt(eff.reroll_cost_delta, 0),
    shop_slots_delta: prevEff.shop_slots_delta + asInt(eff.shop_slots_delta, 0)
  };

  if (goldDelta !== 0) {
    await client.query(`UPDATE match_players SET gold=GREATEST(0, gold+$3), updated_at=now() WHERE match_id=$1 AND seat=$2`, [matchId, seat, goldDelta]);
  }
  await client.query(`UPDATE match_players SET effects=$3::jsonb, updated_at=now() WHERE match_id=$1 AND seat=$2`, [matchId, seat, JSON.stringify(nextEff)]);

  // If shop slots change, regenerate the shop immediately for this round (and unlock).
  if (asInt(eff.shop_slots_delta, 0) !== 0) {
    const s0 = await client.query(`SELECT rolls_used FROM match_shops WHERE match_id=$1 AND seat=$2 FOR UPDATE`, [matchId, seat]);
    const rollsUsed = asInt(s0.rows[0]?.rolls_used, 0);
    const count = 5 + asInt(nextEff.shop_slots_delta, 0);
    const slots = generateShopSlots({ matchSeed: matchSeed, round, rollsUsed, count });
    await client.query(
      `UPDATE match_shops SET locked=false, slots=$3::jsonb, updated_at=now() WHERE match_id=$1 AND seat=$2`,
      [matchId, seat, JSON.stringify(slots)]
    );
  }

  await client.query(
    `UPDATE match_story_events
     SET status='resolved', picked_choice_id=$4, resolved_at=now()
     WHERE match_id=$1 AND seat=$2 AND round=$3`,
    [matchId, seat, round, cid]
  );

  return { ok: true, choiceId: cid, effects: nextEff, goldDelta };
}

function unitStatsFromOfficerId(officerId) {
  const id = String(officerId || '').trim();
  const o = (seedOfficers || []).find((x) => x && x.id === id) || null;
  if (!o) {
    return { unitId: id || 'unknown', name: id || 'unknown', cost: 1, tags: ['ronin', 'officer'], hp: 320, atk: 18, def: 4, aspd: 1.0, range: 1 };
  }
  const war = asInt(o.war, 50);
  const ldr = asInt(o.ldr, 50);
  const intl = asInt(o.int_stat, 50);
  const pol = asInt(o.pol, 50);
  const chr = asInt(o.chr, 50);
  const roster = getAutobattlerRoster();
  const base = roster.find((u) => u.unitId === id);
  const cost = asInt(base?.cost ?? 1, 1);
  const tags = Array.isArray(base?.tags) ? base.tags : [String(o.force_id || 'ronin'), 'officer'];
  const hp = Math.floor(220 + war * 4.2 + ldr * 2.2);
  const atk = Math.floor(10 + war * 0.65 + ldr * 0.10);
  const def = Math.floor(3 + ldr * 0.08 + pol * 0.04);
  const aspd = clamp(0.65 + chr / 220, 0.65, 1.65);
  const range = intl >= 90 ? 3 : intl >= 75 ? 2 : 1;
  return { unitId: id, name: o.name_kr, cost, tags, hp, atk, def, aspd, range };
}

function seatLocalToGlobalPos(seat, x, y) {
  // Global battlefield is 7x8:
  // - seat1 occupies y=0..3
  // - seat2 occupies y=4..7, with local y=0 treated as "front" (closest to enemy)
  const s = asInt(seat, 1);
  const xx = asInt(x, 0);
  const yy = asInt(y, 0);
  if (s === 1) return { x: xx, y: yy };
  return { x: xx, y: 4 + yy };
}

function simulateAutobattleRound({ matchId, matchSeed, round, p1, p2 }) {
  // Deterministic sim for MVP: basic attack + move on 7x8 grid.
  const rand = seededRng(rngHex8FromParts('fight', matchSeed, matchId, round));
  const tickMs = 100;
  const maxTicks = 650; // ~65s hard stop
  const timeline = [];

  function pushEvt(t, evt) {
    timeline.push({ t, ...evt });
  }

  function mkTeam(player, seat) {
    const board = normalizeBoard(player.board_state);
    const units = (board.units || [])
      .filter((u) => u && typeof u.x === 'number' && typeof u.y === 'number' && u.unitId)
      .slice(0, 16)
      .map((u, idx) => {
        const base = unitStatsFromOfficerId(u.unitId);
        const gx = clamp(asInt(u.x, 0), 0, 6);
        const gyLocal = clamp(asInt(u.y, 0), 0, 3);
        const g = seatLocalToGlobalPos(seat, gx, gyLocal);
        const id = String(u.instanceId || `inst_${seat}_${idx}`).trim() || `inst_${seat}_${idx}`;
        return {
          id,
          seat,
          unitId: base.unitId,
          name: base.name,
          cost: base.cost,
          tags: base.tags,
          x: g.x,
          y: g.y,
          hp: base.hp,
          hpMax: base.hp,
          atk: base.atk,
          def: base.def,
          aspd: base.aspd,
          range: base.range,
          cd: 0
        };
      });
    return units;
  }

  const units = mkTeam(p1, 1).concat(mkTeam(p2, 2));
  const alive = () => units.filter((u) => u.hp > 0);
  const teamAlive = (seat) => units.some((u) => u.hp > 0 && u.seat === seat);

  function manhattan(a, b) {
    return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  }

  function pickTarget(u) {
    const enemies = units.filter((e) => e.hp > 0 && e.seat !== u.seat);
    if (!enemies.length) return null;
    enemies.sort((a, b) => manhattan(u, a) - manhattan(u, b) || a.hp - b.hp || (a.id < b.id ? -1 : 1));
    return enemies[0];
  }

  function stepToward(u, t) {
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
    candidates.push({ x: u.x, y: u.y }); // fallback
    for (const c of candidates) {
      if (c.x < 0 || c.x > 6) continue;
      if (c.y < 0 || c.y > 7) continue;
      // Allow overlap for MVP (no collision); keeps sim simple.
      return c;
    }
    return { x: u.x, y: u.y };
  }

  let winnerSeat = null;
  for (let tick = 0; tick < maxTicks; tick += 1) {
    const t = tick * tickMs;
    if (!teamAlive(1) || !teamAlive(2)) break;

    // Shuffle order deterministically to reduce bias.
    const order = alive().slice().sort((a, b) => (a.id < b.id ? -1 : 1));
    for (let i = order.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rand() * (i + 1));
      const tmp = order[i];
      order[i] = order[j];
      order[j] = tmp;
    }

    for (const u of order) {
      if (u.hp <= 0) continue;
      const target = pickTarget(u);
      if (!target) continue;

      u.cd = Math.max(0, u.cd - tickMs / 1000);
      const dist = manhattan(u, target);
      if (dist > u.range) {
        const next = stepToward(u, target);
        if (next.x !== u.x || next.y !== u.y) {
          const from = { x: u.x, y: u.y };
          u.x = next.x;
          u.y = next.y;
          pushEvt(t, { type: 'move', src: u.id, seat: u.seat, from, to: { x: u.x, y: u.y } });
        }
        continue;
      }

      if (u.cd > 0) continue;
      const raw = Math.floor(u.atk + rand() * 6);
      const dmg = Math.max(1, raw - Math.floor(target.def));
      target.hp = Math.max(0, target.hp - dmg);
      u.cd = 1 / Math.max(0.35, u.aspd);
      pushEvt(t, { type: 'attack', src: u.id, dst: target.id, seat: u.seat, amount: dmg, dstHp: target.hp });
      if (target.hp <= 0) pushEvt(t, { type: 'death', src: target.id, seat: target.seat });
    }
  }

  const a1 = units.filter((u) => u.hp > 0 && u.seat === 1);
  const a2 = units.filter((u) => u.hp > 0 && u.seat === 2);
  if (a1.length && !a2.length) winnerSeat = 1;
  else if (a2.length && !a1.length) winnerSeat = 2;
  else {
    // Timeout: compare remaining hp sum.
    const s1 = a1.reduce((acc, u) => acc + u.hp, 0);
    const s2 = a2.reduce((acc, u) => acc + u.hp, 0);
    winnerSeat = s1 === s2 ? (rand() < 0.5 ? 1 : 2) : s1 > s2 ? 1 : 2;
  }

  function armyPower(list) {
    return list.reduce((acc, u) => acc + Math.max(1, asInt(u.cost, 1)) * 2, 0);
  }
  const dmgToLoser = 5 + Math.floor(armyPower(winnerSeat === 1 ? a1 : a2) / 4);

  const summary = {
    winnerSeat,
    dmgToLoser,
    survivors: {
      seat1: a1.map((u) => ({ unitId: u.unitId, hp: u.hp })),
      seat2: a2.map((u) => ({ unitId: u.unitId, hp: u.hp }))
    }
  };

  return { timeline, summary };
}

// ─────────────────────────────────────────────────────────────────────────────
// Auto-battler MVP (1v1, 7x4) endpoints (dev-grade: create + state)
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Proto Battle (4x3) endpoints (stateless) - for early fun/good-read tests.
// ─────────────────────────────────────────────────────────────────────────────

app.get('/api/proto/battle/roster', (req, res) => {
  res.json({ ok: true, roster: PROTO_ROSTER_4X3 });
});

app.post('/api/proto/battle/simulate', (req, res) => {
  try {
    const seed = String(req.body?.seed || '').trim() || String(Date.now());
    const p1Units = Array.isArray(req.body?.p1Units) ? req.body.p1Units : [];
    const p2Units = Array.isArray(req.body?.p2Units) ? req.body.p2Units : [];
    const sim = simulateProtoBattle4x3({ seed, p1Units, p2Units });
    res.json({ ok: true, ...sim });
  } catch (err) {
    res.status(400).json({ ok: false, error: err?.message ? String(err.message) : String(err) });
  }
});

app.post('/api/match/create', async (req, res) => {
  try {
    const playerId = String(req.body?.playerId || '').trim();
    const mode = '1v1';
    if (!playerId) return res.status(400).json({ ok: false, error: 'playerId is required' });

    const result = await withTx(async (client) => {
      const pr = await client.query(`SELECT id, officer_id FROM players WHERE id = $1`, [playerId]);
      if (!pr.rows.length) throw new Error('player not found');
      const myOfficerId = String(pr.rows[0].officer_id || '').trim();
      if (!myOfficerId) throw new Error('player has no officer');

      const seed = randomSeed64String();
      const idr = await client.query(`SELECT 'mat_' || substr(md5(random()::text),1,12) AS id`);
      const matchId = String(idr.rows[0].id);
      const round = 1;

      // Seat2 is a bot for MVP; keep it simple but pick a playable officer.
      const bot = await client.query(
        `SELECT id, name_kr
         FROM officers
         WHERE is_playable = true
         ORDER BY random()
         LIMIT 1`
      );
      const botOfficerId = String(bot.rows[0]?.id || 'player_default');
      const botOfficerName = String(bot.rows[0]?.name_kr || 'BOT');

      await client.query(`INSERT INTO matches (id, mode, status, seed) VALUES ($1, $2, $3, $4)`, [
        matchId,
        mode,
        'ongoing',
        seed
      ]);

      const board = { w: 7, h: 4, cells: makeEmptyGrid(7, 4, null), units: [] };
      const bench = { slots: [], cap: 8 };
      const effects = {};

      await client.query(
        `INSERT INTO match_players (match_id, seat, player_id, officer_id, hp, gold, level, xp, board_state, bench_state, effects)
         VALUES ($1, 1, $2, $3, 100, 5, 1, 0, $4::jsonb, $5::jsonb, $6::jsonb)`,
        [matchId, playerId, myOfficerId, JSON.stringify(board), JSON.stringify(bench), JSON.stringify(effects)]
      );
      await client.query(
        `INSERT INTO match_players (match_id, seat, player_id, officer_id, hp, gold, level, xp, board_state, bench_state, effects)
         VALUES ($1, 2, NULL, $2, 100, 5, 1, 0, $3::jsonb, $4::jsonb, $5::jsonb)`,
        [matchId, botOfficerId, JSON.stringify(board), JSON.stringify(bench), JSON.stringify(effects)]
      );

      await client.query(
        `INSERT INTO match_rounds (match_id, round, phase, started_at, ends_at, resolved, result_json)
         VALUES ($1, 1, 'prep', now(), now() + interval '35 seconds', false, '{}'::jsonb)
         ON CONFLICT (match_id, round) DO NOTHING`,
        [matchId]
      );

      const slots1 = generateShopSlots({ matchSeed: seed, round, rollsUsed: 0, count: 5 });
      await client.query(
        `INSERT INTO match_shops (match_id, seat, round, locked, rolls_used, slots)
         VALUES ($1, 1, $2, false, 0, $3::jsonb)
         ON CONFLICT (match_id, seat) DO UPDATE SET round=$2, locked=false, rolls_used=0, slots=$3::jsonb, updated_at=now()`,
        [matchId, round, JSON.stringify(slots1)]
      );
      const slots2 = generateShopSlots({ matchSeed: seed, round, rollsUsed: 0, count: 5 });
      await client.query(
        `INSERT INTO match_shops (match_id, seat, round, locked, rolls_used, slots)
         VALUES ($1, 2, $2, false, 0, $3::jsonb)
         ON CONFLICT (match_id, seat) DO UPDATE SET round=$2, locked=false, rolls_used=0, slots=$3::jsonb, updated_at=now()`,
        [matchId, round, JSON.stringify(slots2)]
      );

      await ensureStoryEventForSeat(client, { matchId, matchSeed: seed, seat: 1, round });
      await ensureStoryEventForSeat(client, { matchId, matchSeed: seed, seat: 2, round });

      return {
        matchId,
        mode,
        seed,
        me: { seat: 1, playerId, officerId: myOfficerId, hp: 100, gold: 5, level: 1, xp: 0 },
        opponent: { seat: 2, playerId: null, officerId: botOfficerId, name: botOfficerName, hp: 100, gold: 5, level: 1, xp: 0 }
      };
    });

    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ ok: false, error: err?.message ? String(err.message) : String(err) });
  }
});

app.get('/api/match/:matchId/state', async (req, res) => {
  try {
    const matchId = String(req.params?.matchId || '').trim();
    const playerId = String(req.query?.playerId || '').trim();
    if (!matchId) return res.status(400).json({ ok: false, error: 'matchId is required' });
    if (!playerId) return res.status(400).json({ ok: false, error: 'playerId is required' });

    const out = await withTx(async (client) => {
      const mq = await client.query(`SELECT id, mode, status, seed, created_at, updated_at FROM matches WHERE id = $1`, [matchId]);
      if (!mq.rows.length) throw new Error('match not found');
      const m = mq.rows[0];

      const pq = await client.query(
        `SELECT seat, player_id, officer_id, hp, gold, level, xp, board_state, bench_state, effects
         FROM match_players
         WHERE match_id = $1
         ORDER BY seat ASC`,
        [matchId]
      );
      if (!pq.rows.length) throw new Error('match has no players');

      const meRow = pq.rows.find((r) => String(r.player_id || '') === playerId);
      if (!meRow) throw new Error('player is not in this match');
      const oppRow = pq.rows.find((r) => asInt(r.seat, 0) !== asInt(meRow.seat, 0)) || null;

      const sq = await client.query(
        `SELECT seat, round, locked, rolls_used, slots
         FROM match_shops
         WHERE match_id = $1`,
        [matchId]
      );
      const myShop = sq.rows.find((r) => asInt(r.seat, 0) === asInt(meRow.seat, 0)) || null;
      const oppShop = oppRow ? sq.rows.find((r) => asInt(r.seat, 0) === asInt(oppRow.seat, 0)) || null : null;

      const rq = await client.query(
        `SELECT round, phase, started_at, ends_at, resolved, result_json
         FROM match_rounds
         WHERE match_id = $1
         ORDER BY round DESC
         LIMIT 1`,
        [matchId]
      );
      const round = rq.rows[0] || null;
      const curRound = round ? asInt(round.round, 1) : 1;

      const eq = await client.query(
        `SELECT seat, status, event_id, title, body, choices
         FROM match_story_events
         WHERE match_id=$1 AND round=$2 AND status='pending'`,
        [matchId, curRound]
      );
      const myEv = eq.rows.find((r) => asInt(r.seat, 0) === asInt(meRow.seat, 0)) || null;
      const oppEv = oppRow ? eq.rows.find((r) => asInt(r.seat, 0) === asInt(oppRow.seat, 0)) || null : null;

      return {
        match: {
          id: m.id,
          mode: m.mode,
          status: m.status,
          seed: String(m.seed),
          created_at: m.created_at,
          updated_at: m.updated_at
        },
        round: round
          ? {
              round: asInt(round.round, 1),
              phase: String(round.phase || 'prep'),
              started_at: round.started_at,
              ends_at: round.ends_at,
              resolved: Boolean(round.resolved),
              result: round.result_json || {}
            }
          : null,
        me: {
          seat: asInt(meRow.seat, 1),
          playerId: meRow.player_id,
          officerId: meRow.officer_id,
          hp: asInt(meRow.hp, 0),
          gold: asInt(meRow.gold, 0),
          level: asInt(meRow.level, 1),
          xp: asInt(meRow.xp, 0),
          board: meRow.board_state || {},
          bench: meRow.bench_state || {},
          effects: meRow.effects || {},
          storyEvent: myEv
            ? { eventId: myEv.event_id, title: myEv.title, body: myEv.body, choices: Array.isArray(myEv.choices) ? myEv.choices : [] }
            : null,
          shop: myShop
            ? {
                round: asInt(myShop.round, 1),
                locked: Boolean(myShop.locked),
                rollsUsed: asInt(myShop.rolls_used, 0),
                slots: Array.isArray(myShop.slots) ? myShop.slots : []
              }
            : null
        },
        opponent: oppRow
          ? {
              seat: asInt(oppRow.seat, 2),
              playerId: oppRow.player_id,
              officerId: oppRow.officer_id,
              hp: asInt(oppRow.hp, 0),
              gold: asInt(oppRow.gold, 0),
              level: asInt(oppRow.level, 1),
              xp: asInt(oppRow.xp, 0),
              board: oppRow.board_state || {},
              bench: oppRow.bench_state || {},
              effects: oppRow.effects || {},
              storyEvent: oppEv ? { eventId: oppEv.event_id, title: oppEv.title, body: oppEv.body } : null,
              shop: oppShop
                ? {
                    round: asInt(oppShop.round, 1),
                    locked: Boolean(oppShop.locked),
                    rollsUsed: asInt(oppShop.rolls_used, 0),
                    slots: Array.isArray(oppShop.slots) ? oppShop.slots : []
                  }
                : null
            }
          : null
      };
    });

    res.json({ ok: true, ...out });
  } catch (err) {
    res.status(400).json({ ok: false, error: err?.message ? String(err.message) : String(err) });
  }
});

function normalizeBench(bench) {
  const b = bench && typeof bench === 'object' ? bench : {};
  const cap = asInt(b.cap ?? 8, 8);
  const units = Array.isArray(b.units) ? b.units : Array.isArray(b.slots) ? b.slots.filter(Boolean) : [];
  return { cap: clamp(cap, 0, 99), units };
}

function normalizeBoard(board) {
  const bb = board && typeof board === 'object' ? board : {};
  const w = clamp(asInt(bb.w ?? 7, 7), 1, 16);
  const h = clamp(asInt(bb.h ?? 4, 4), 1, 16);
  const units = Array.isArray(bb.units) ? bb.units : [];
  return { w, h, units };
}

function findUnitInList(list, instanceId) {
  const id = String(instanceId || '').trim();
  if (!id) return null;
  return (list || []).find((u) => u && String(u.instanceId || '').trim() === id) || null;
}

app.post('/api/match/:matchId/shop/reroll', async (req, res) => {
  try {
    const matchId = String(req.params?.matchId || '').trim();
    const playerId = String(req.body?.playerId || '').trim();
    if (!matchId) return res.status(400).json({ ok: false, error: 'matchId is required' });
    if (!playerId) return res.status(400).json({ ok: false, error: 'playerId is required' });

    const out = await withTx(async (client) => {
      const mq = await client.query(`SELECT id, seed, status FROM matches WHERE id=$1 FOR UPDATE`, [matchId]);
      if (!mq.rows.length) throw new Error('match not found');
      if (String(mq.rows[0].status || '') !== 'ongoing') throw new Error('match is not ongoing');
      const seed = String(mq.rows[0].seed || '').trim();

      const rp = await client.query(
        `SELECT round, phase FROM match_rounds WHERE match_id=$1 ORDER BY round DESC LIMIT 1`,
        [matchId]
      );
      const round = asInt(rp.rows[0]?.round, 1);
      const phase = String(rp.rows[0]?.phase || 'prep');
      if (phase !== 'prep') throw new Error(`cannot reroll during phase=${phase}`);

      const pr = await client.query(
        `SELECT seat, gold, effects FROM match_players WHERE match_id=$1 AND player_id=$2 FOR UPDATE`,
        [matchId, playerId]
      );
      if (!pr.rows.length) throw new Error('player is not in this match');
      const seat = asInt(pr.rows[0].seat, 1);
      const gold0 = asInt(pr.rows[0].gold, 0);
      await assertNoPendingStory(client, { matchId, seat, round });

      const sr = await client.query(
        `SELECT round, locked, rolls_used FROM match_shops WHERE match_id=$1 AND seat=$2 FOR UPDATE`,
        [matchId, seat]
      );
      if (!sr.rows.length) throw new Error('shop not initialized');
      if (Boolean(sr.rows[0].locked)) throw new Error('shop is locked');

      const eff = effectsForRound(pr.rows[0].effects, round);
      const cost = Math.max(0, 2 + asInt(eff.reroll_cost_delta, 0));
      if (gold0 < cost) throw new Error(`not enough gold (need ${cost})`);
      const rollsUsed = asInt(sr.rows[0].rolls_used, 0) + 1;
      const count = 5 + asInt(eff.shop_slots_delta, 0);
      const slots = generateShopSlots({ matchSeed: seed, round, rollsUsed, count });

      await client.query(`UPDATE match_players SET gold=gold-$3, updated_at=now() WHERE match_id=$1 AND seat=$2`, [
        matchId,
        seat,
        cost
      ]);
      await client.query(
        `UPDATE match_shops SET round=$3, rolls_used=$4, slots=$5::jsonb, updated_at=now() WHERE match_id=$1 AND seat=$2`,
        [matchId, seat, round, rollsUsed, JSON.stringify(slots)]
      );

      return { seat, goldCost: cost, rollsUsed, slots };
    });

    res.json({ ok: true, ...out });
  } catch (err) {
    res.status(400).json({ ok: false, error: err?.message ? String(err.message) : String(err) });
  }
});

app.post('/api/match/:matchId/shop/lock', async (req, res) => {
  try {
    const matchId = String(req.params?.matchId || '').trim();
    const playerId = String(req.body?.playerId || '').trim();
    const locked = Boolean(req.body?.locked);
    if (!matchId) return res.status(400).json({ ok: false, error: 'matchId is required' });
    if (!playerId) return res.status(400).json({ ok: false, error: 'playerId is required' });

    const out = await withTx(async (client) => {
      const pr = await client.query(
        `SELECT seat FROM match_players WHERE match_id=$1 AND player_id=$2 FOR UPDATE`,
        [matchId, playerId]
      );
      if (!pr.rows.length) throw new Error('player is not in this match');
      const seat = asInt(pr.rows[0].seat, 1);
      const rp = await client.query(`SELECT round, phase FROM match_rounds WHERE match_id=$1 ORDER BY round DESC LIMIT 1`, [matchId]);
      const round = asInt(rp.rows[0]?.round, 1);
      await assertNoPendingStory(client, { matchId, seat, round });
      await client.query(`UPDATE match_shops SET locked=$3, updated_at=now() WHERE match_id=$1 AND seat=$2`, [
        matchId,
        seat,
        locked
      ]);
      return { seat, locked };
    });

    res.json({ ok: true, ...out });
  } catch (err) {
    res.status(400).json({ ok: false, error: err?.message ? String(err.message) : String(err) });
  }
});

app.post('/api/match/:matchId/shop/buy', async (req, res) => {
  try {
    const matchId = String(req.params?.matchId || '').trim();
    const playerId = String(req.body?.playerId || '').trim();
    const slotIndex = asInt(req.body?.slotIndex, -1);
    if (!matchId) return res.status(400).json({ ok: false, error: 'matchId is required' });
    if (!playerId) return res.status(400).json({ ok: false, error: 'playerId is required' });
    if (slotIndex < 0) return res.status(400).json({ ok: false, error: 'slotIndex is required' });

    const out = await withTx(async (client) => {
      const mq = await client.query(`SELECT seed, status FROM matches WHERE id=$1 FOR UPDATE`, [matchId]);
      if (!mq.rows.length) throw new Error('match not found');
      if (String(mq.rows[0].status || '') !== 'ongoing') throw new Error('match is not ongoing');

      const rp = await client.query(
        `SELECT round, phase FROM match_rounds WHERE match_id=$1 ORDER BY round DESC LIMIT 1`,
        [matchId]
      );
      const phase = String(rp.rows[0]?.phase || 'prep');
      if (phase !== 'prep') throw new Error(`cannot buy during phase=${phase}`);

      const pr = await client.query(
        `SELECT seat, gold, bench_state FROM match_players WHERE match_id=$1 AND player_id=$2 FOR UPDATE`,
        [matchId, playerId]
      );
      if (!pr.rows.length) throw new Error('player is not in this match');
      const seat = asInt(pr.rows[0].seat, 1);
      await assertNoPendingStory(client, { matchId, seat, round });
      const gold0 = asInt(pr.rows[0].gold, 0);
      const bench0 = normalizeBench(pr.rows[0].bench_state);
      if (bench0.units.length >= bench0.cap) throw new Error('bench is full');

      const sr = await client.query(
        `SELECT slots, rolls_used, round FROM match_shops WHERE match_id=$1 AND seat=$2 FOR UPDATE`,
        [matchId, seat]
      );
      if (!sr.rows.length) throw new Error('shop not initialized');
      const slots = Array.isArray(sr.rows[0].slots) ? sr.rows[0].slots.slice() : [];
      if (slotIndex >= slots.length) throw new Error('invalid slotIndex');
      const offer = slots[slotIndex];
      if (!offer || !offer.unitId) throw new Error('empty slot');
      const cost = asInt(offer.cost, 1);
      if (gold0 < cost) throw new Error(`not enough gold (need ${cost})`);

      const instanceId = `u_${sha256Hex(`${matchId}|${seat}|${Date.now()}|${Math.random()}`).slice(0, 10)}`;
      const unit = { instanceId, unitId: String(offer.unitId), star: 1 };
      const bench1 = { ...bench0, units: bench0.units.concat([unit]) };
      slots[slotIndex] = null;

      await client.query(
        `UPDATE match_players
         SET gold=gold-$3, bench_state=$4::jsonb, updated_at=now()
         WHERE match_id=$1 AND seat=$2`,
        [matchId, seat, cost, JSON.stringify(bench1)]
      );
      await client.query(
        `UPDATE match_shops SET slots=$3::jsonb, updated_at=now() WHERE match_id=$1 AND seat=$2`,
        [matchId, seat, JSON.stringify(slots)]
      );

      return { seat, bought: unit, goldCost: cost, bench: bench1, slots };
    });

    res.json({ ok: true, ...out });
  } catch (err) {
    res.status(400).json({ ok: false, error: err?.message ? String(err.message) : String(err) });
  }
});

app.post('/api/match/:matchId/board/place', async (req, res) => {
  try {
    const matchId = String(req.params?.matchId || '').trim();
    const playerId = String(req.body?.playerId || '').trim();
    const instanceId = String(req.body?.unitInstanceId || '').trim();
    const x = asInt(req.body?.x, -1);
    const y = asInt(req.body?.y, -1);
    if (!matchId) return res.status(400).json({ ok: false, error: 'matchId is required' });
    if (!playerId) return res.status(400).json({ ok: false, error: 'playerId is required' });
    if (!instanceId) return res.status(400).json({ ok: false, error: 'unitInstanceId is required' });
    if (x < 0 || y < 0) return res.status(400).json({ ok: false, error: 'x,y are required' });

    const out = await withTx(async (client) => {
      const rp = await client.query(
        `SELECT round, phase FROM match_rounds WHERE match_id=$1 ORDER BY round DESC LIMIT 1`,
        [matchId]
      );
      const phase = String(rp.rows[0]?.phase || 'prep');
      if (phase !== 'prep') throw new Error(`cannot place during phase=${phase}`);

      const pr = await client.query(
        `SELECT seat, board_state, bench_state FROM match_players WHERE match_id=$1 AND player_id=$2 FOR UPDATE`,
        [matchId, playerId]
      );
      if (!pr.rows.length) throw new Error('player is not in this match');
      const seat = asInt(pr.rows[0].seat, 1);
      const rp2 = await client.query(`SELECT round FROM match_rounds WHERE match_id=$1 ORDER BY round DESC LIMIT 1`, [matchId]);
      const round2 = asInt(rp2.rows[0]?.round, 1);
      await assertNoPendingStory(client, { matchId, seat, round: round2 });
      const board0 = normalizeBoard(pr.rows[0].board_state);
      const bench0 = normalizeBench(pr.rows[0].bench_state);

      if (x >= board0.w || y >= board0.h) throw new Error('out of bounds');
      if (board0.units.some((u) => u && asInt(u.x, -999) === x && asInt(u.y, -999) === y)) throw new Error('cell occupied');

      const u = findUnitInList(bench0.units, instanceId);
      if (!u) throw new Error('unit not found in bench');

      const bench1 = { ...bench0, units: bench0.units.filter((it) => String(it?.instanceId || '') !== instanceId) };
      const placed = { ...u, x, y };
      const board1 = { ...board0, units: board0.units.concat([placed]) };

      await client.query(
        `UPDATE match_players SET board_state=$3::jsonb, bench_state=$4::jsonb, updated_at=now() WHERE match_id=$1 AND seat=$2`,
        [matchId, seat, JSON.stringify(board1), JSON.stringify(bench1)]
      );

      return { seat, placed, board: board1, bench: bench1 };
    });

    res.json({ ok: true, ...out });
  } catch (err) {
    res.status(400).json({ ok: false, error: err?.message ? String(err.message) : String(err) });
  }
});

app.post('/api/match/:matchId/board/remove', async (req, res) => {
  try {
    const matchId = String(req.params?.matchId || '').trim();
    const playerId = String(req.body?.playerId || '').trim();
    const instanceId = String(req.body?.unitInstanceId || '').trim();
    if (!matchId) return res.status(400).json({ ok: false, error: 'matchId is required' });
    if (!playerId) return res.status(400).json({ ok: false, error: 'playerId is required' });
    if (!instanceId) return res.status(400).json({ ok: false, error: 'unitInstanceId is required' });

    const out = await withTx(async (client) => {
      const rp = await client.query(
        `SELECT round, phase FROM match_rounds WHERE match_id=$1 ORDER BY round DESC LIMIT 1`,
        [matchId]
      );
      const phase = String(rp.rows[0]?.phase || 'prep');
      if (phase !== 'prep') throw new Error(`cannot remove during phase=${phase}`);

      const pr = await client.query(
        `SELECT seat, board_state, bench_state FROM match_players WHERE match_id=$1 AND player_id=$2 FOR UPDATE`,
        [matchId, playerId]
      );
      if (!pr.rows.length) throw new Error('player is not in this match');
      const seat = asInt(pr.rows[0].seat, 1);
      const rp2 = await client.query(`SELECT round FROM match_rounds WHERE match_id=$1 ORDER BY round DESC LIMIT 1`, [matchId]);
      const round2 = asInt(rp2.rows[0]?.round, 1);
      await assertNoPendingStory(client, { matchId, seat, round: round2 });
      const board0 = normalizeBoard(pr.rows[0].board_state);
      const bench0 = normalizeBench(pr.rows[0].bench_state);
      if (bench0.units.length >= bench0.cap) throw new Error('bench is full');

      const hit = findUnitInList(board0.units, instanceId);
      if (!hit) throw new Error('unit not found on board');

      const board1 = { ...board0, units: board0.units.filter((u) => String(u?.instanceId || '') !== instanceId) };
      const bench1 = { ...bench0, units: bench0.units.concat([{ instanceId: hit.instanceId, unitId: hit.unitId, star: hit.star ?? 1 }]) };

      await client.query(
        `UPDATE match_players SET board_state=$3::jsonb, bench_state=$4::jsonb, updated_at=now() WHERE match_id=$1 AND seat=$2`,
        [matchId, seat, JSON.stringify(board1), JSON.stringify(bench1)]
      );
      return { seat, removed: hit, board: board1, bench: bench1 };
    });

    res.json({ ok: true, ...out });
  } catch (err) {
    res.status(400).json({ ok: false, error: err?.message ? String(err.message) : String(err) });
  }
});

app.get('/api/match/:matchId/replay/:round', async (req, res) => {
  try {
    const matchId = String(req.params?.matchId || '').trim();
    const round = asInt(req.params?.round, 0);
    const playerId = String(req.query?.playerId || '').trim();
    if (!matchId) return res.status(400).json({ ok: false, error: 'matchId is required' });
    if (!playerId) return res.status(400).json({ ok: false, error: 'playerId is required' });
    if (round <= 0) return res.status(400).json({ ok: false, error: 'round must be >= 1' });

    const out = await withTx(async (client) => {
      const pr = await client.query(`SELECT seat FROM match_players WHERE match_id=$1 AND player_id=$2`, [matchId, playerId]);
      if (!pr.rows.length) throw new Error('player is not in this match');
      const rr = await client.query(`SELECT timeline, summary, created_at FROM match_replays WHERE match_id=$1 AND round=$2`, [matchId, round]);
      if (!rr.rows.length) throw new Error('replay not found');
      const r = rr.rows[0];
      return { round, created_at: r.created_at, timeline: Array.isArray(r.timeline) ? r.timeline : [], summary: r.summary || {} };
    });

    res.json({ ok: true, ...out });
  } catch (err) {
    res.status(400).json({ ok: false, error: err?.message ? String(err.message) : String(err) });
  }
});

app.post('/api/match/:matchId/story/choice', async (req, res) => {
  try {
    const matchId = String(req.params?.matchId || '').trim();
    const playerId = String(req.body?.playerId || '').trim();
    const choiceId = String(req.body?.choiceId || '').trim();
    if (!matchId) return res.status(400).json({ ok: false, error: 'matchId is required' });
    if (!playerId) return res.status(400).json({ ok: false, error: 'playerId is required' });
    if (!choiceId) return res.status(400).json({ ok: false, error: 'choiceId is required' });

    const out = await withTx(async (client) => {
      const m = await client.query(`SELECT seed, status FROM matches WHERE id=$1 FOR UPDATE`, [matchId]);
      if (!m.rows.length) throw new Error('match not found');
      if (String(m.rows[0].status || '') !== 'ongoing') throw new Error('match is not ongoing');
      const seed = String(m.rows[0].seed || '').trim();

      const rr = await client.query(`SELECT round, phase FROM match_rounds WHERE match_id=$1 ORDER BY round DESC LIMIT 1`, [matchId]);
      const round = asInt(rr.rows[0]?.round, 1);
      const phase = String(rr.rows[0]?.phase || 'prep');
      if (phase !== 'prep') throw new Error(`cannot choose during phase=${phase}`);

      const pr = await client.query(`SELECT seat FROM match_players WHERE match_id=$1 AND player_id=$2 FOR UPDATE`, [matchId, playerId]);
      if (!pr.rows.length) throw new Error('player is not in this match');
      const seat = asInt(pr.rows[0].seat, 1);

      const r = await applyStoryChoiceTx(client, { matchId, matchSeed: seed, seat, round, choiceId, auto: false });
      return { seat, round, ...r };
    });

    res.json({ ok: true, ...out });
  } catch (err) {
    res.status(400).json({ ok: false, error: err?.message ? String(err.message) : String(err) });
  }
});

async function autobattlerTickOnce() {
  const now = new Date();
  const due = await pool.query(
    `SELECT mr.match_id, mr.round, mr.phase
     FROM match_rounds mr
     JOIN matches m ON m.id = mr.match_id
     WHERE m.status = 'ongoing'
       AND mr.ends_at IS NOT NULL
       AND mr.ends_at <= $1
     ORDER BY mr.ends_at ASC
     LIMIT 12`,
    [now]
  );
  if (!due.rows.length) return { advanced: 0 };

  let advanced = 0;
  for (const row of due.rows) {
    const matchId = String(row.match_id);
    await withTx(async (client) => {
      const mr = await client.query(
        `SELECT match_id, round, phase, ends_at, resolved, result_json
         FROM match_rounds
         WHERE match_id=$1 AND round=$2
         FOR UPDATE`,
        [matchId, asInt(row.round, 1)]
      );
      if (!mr.rows.length) return;
      const cur = mr.rows[0];
      if (cur.ends_at && new Date(cur.ends_at).getTime() > Date.now()) return;

      const matchRow = await client.query(`SELECT id, seed, status FROM matches WHERE id=$1 FOR UPDATE`, [matchId]);
      if (!matchRow.rows.length) return;
      if (String(matchRow.rows[0].status || '') !== 'ongoing') return;
      const seed = String(matchRow.rows[0].seed || '').trim();

      const roundNum = asInt(cur.round, 1);
      const phase = String(cur.phase || 'prep');

      const pAll = await client.query(
        `SELECT seat, player_id, hp, gold, level, xp, board_state, bench_state, effects
         FROM match_players
         WHERE match_id=$1
         ORDER BY seat ASC
         FOR UPDATE`,
        [matchId]
      );
      if (pAll.rows.length < 2) return;
      const p1 = pAll.rows.find((p) => asInt(p.seat, 0) === 1);
      const p2 = pAll.rows.find((p) => asInt(p.seat, 0) === 2);
      if (!p1 || !p2) return;

      const prepSeconds = 35;
      const fightSeconds = 25;
      const resultSeconds = 8;

      if (phase === 'prep') {
        // Ensure story events exist for this round.
        await ensureStoryEventForSeat(client, { matchId, matchSeed: seed, seat: 1, round: roundNum });
        await ensureStoryEventForSeat(client, { matchId, matchSeed: seed, seat: 2, round: roundNum });

        // Auto-resolve any pending story to keep the match flowing (default: skip).
        const pend = await client.query(
          `SELECT seat, choices FROM match_story_events WHERE match_id=$1 AND round=$2 AND status='pending' FOR UPDATE`,
          [matchId, roundNum]
        );
        for (const e of pend.rows) {
          const choices = Array.isArray(e.choices) ? e.choices : [];
          const hasSkip = choices.some((c) => c && String(c.id || '') === 'skip');
          const pick = hasSkip ? 'skip' : String(choices[0]?.id || 'skip');
          await applyStoryChoiceTx(client, { matchId, matchSeed: seed, seat: asInt(e.seat, 1), round: roundNum, choiceId: pick, auto: true });
        }

        // Bot: make sure it has something to fight with.
        const sr = await client.query(`SELECT slots FROM match_shops WHERE match_id=$1 AND seat=2 FOR UPDATE`, [matchId]);
        const slots = Array.isArray(sr.rows[0]?.slots) ? sr.rows[0].slots : [];
        const offer = slots.find((s) => s && s.unitId) || null;

        const p2r = await client.query(`SELECT board_state, bench_state FROM match_players WHERE match_id=$1 AND seat=2 FOR UPDATE`, [matchId]);
        const b0 = normalizeBench(p2r.rows[0]?.bench_state);
        const bd0 = normalizeBoard(p2r.rows[0]?.board_state);

        if (!bd0.units.length && !b0.units.length && offer) {
          const inst = `u_${sha256Hex(`${matchId}|bot|${roundNum}|${offer.unitId}`).slice(0, 10)}`;
          b0.units.push({ instanceId: inst, unitId: offer.unitId, star: 1 });
        }
        if (b0.units.length) {
          const u = b0.units.shift();
          bd0.units.push({ ...u, x: 3, y: 0 });
        }
        await client.query(`UPDATE match_players SET board_state=$3::jsonb, bench_state=$4::jsonb, updated_at=now() WHERE match_id=$1 AND seat=2`, [
          matchId,
          2,
          JSON.stringify(bd0),
          JSON.stringify(b0)
        ]);

        const sim = simulateAutobattleRound({ matchId, matchSeed: seed, round: roundNum, p1, p2 });
        await client.query(
          `INSERT INTO match_replays (match_id, round, timeline, summary)
           VALUES ($1, $2, $3::jsonb, $4::jsonb)
           ON CONFLICT (match_id, round) DO UPDATE SET timeline=$3::jsonb, summary=$4::jsonb, created_at=now()`,
          [matchId, roundNum, JSON.stringify(sim.timeline), JSON.stringify(sim.summary)]
        );
        await client.query(
          `UPDATE match_rounds
           SET phase='fight', ends_at=now()+interval '${fightSeconds} seconds', result_json=$3::jsonb
           WHERE match_id=$1 AND round=$2`,
          [matchId, roundNum, JSON.stringify({ ...(cur.result_json || {}), sim: sim.summary })]
        );
        advanced += 1;
        return;
      }

      if (phase === 'fight') {
        await client.query(
          `UPDATE match_rounds
           SET phase='result', ends_at=now()+interval '${resultSeconds} seconds'
           WHERE match_id=$1 AND round=$2`,
          [matchId, roundNum]
        );
        advanced += 1;
        return;
      }

      if (phase === 'result') {
        const resJson = cur.result_json || {};
        const sim = resJson.sim || null;
        if (!sim || !sim.winnerSeat) throw new Error('missing sim result');
        const winnerSeat = asInt(sim.winnerSeat, 1);
        const loserSeat = winnerSeat === 1 ? 2 : 1;
        const dmg = asInt(sim.dmgToLoser, 5);

        const winGold = 3;
        const loseGold = 1;
        const baseIncome = 5;

        await client.query(
          `UPDATE match_players
           SET hp = GREATEST(0, hp - $3),
               gold = gold + $4,
               updated_at=now()
           WHERE match_id=$1 AND seat=$2`,
          [matchId, loserSeat, dmg, loseGold + baseIncome]
        );
        await client.query(
          `UPDATE match_players
           SET gold = gold + $3,
               updated_at=now()
           WHERE match_id=$1 AND seat=$2`,
          [matchId, winnerSeat, winGold + baseIncome]
        );

        const hpq = await client.query(`SELECT seat, hp FROM match_players WHERE match_id=$1 ORDER BY seat`, [matchId]);
        const dead = hpq.rows.find((p) => asInt(p.hp, 1) <= 0) || null;
        if (dead) await client.query(`UPDATE matches SET status='finished', updated_at=now() WHERE id=$1`, [matchId]);

        await client.query(`UPDATE match_rounds SET resolved=true, updated_at=now() WHERE match_id=$1 AND round=$2`, [matchId, roundNum]);

        if (!dead) {
          const nextRound = roundNum + 1;
          // Reset per-round effects at the start of the new round.
          await client.query(`UPDATE match_players SET effects='{}'::jsonb, updated_at=now() WHERE match_id=$1`, [matchId]);
          await client.query(
            `INSERT INTO match_rounds (match_id, round, phase, started_at, ends_at, resolved, result_json)
             VALUES ($1, $2, 'prep', now(), now()+interval '${prepSeconds} seconds', false, '{}'::jsonb)
             ON CONFLICT (match_id, round) DO UPDATE SET phase='prep', started_at=now(), ends_at=now()+interval '${prepSeconds} seconds', resolved=false, result_json='{}'::jsonb`,
            [matchId, nextRound]
          );
          const shopRows = await client.query(`SELECT seat, locked, slots FROM match_shops WHERE match_id=$1 FOR UPDATE`, [matchId]);
          for (const s of shopRows.rows) {
            const seat = asInt(s.seat, 1);
            const locked = Boolean(s.locked);
            const nextSlots = locked ? (Array.isArray(s.slots) ? s.slots : []) : generateShopSlots({ matchSeed: seed, round: nextRound, rollsUsed: 0, count: 5 });
            await client.query(
              `UPDATE match_shops
               SET round=$3, locked=false, rolls_used=0, slots=$4::jsonb, updated_at=now()
               WHERE match_id=$1 AND seat=$2`,
              [matchId, seat, nextRound, JSON.stringify(nextSlots)]
            );
          }

          await ensureStoryEventForSeat(client, { matchId, matchSeed: seed, seat: 1, round: nextRound });
          await ensureStoryEventForSeat(client, { matchId, matchSeed: seed, seat: 2, round: nextRound });
        }

        advanced += 1;
        return;
      }
    });
  }
  return { advanced };
}

const port = Number(process.env.PORT || 3000);
ensureBattleSchema()
  .then(() => ensureMatchSchema())
  .then(() => ensureWorldSchema())
  .then(() => ensureGameTimeSchema())
  .then(() => ensureOfficerRoleSchema())
  .then(() => ensureStorySchema())
  .then(() => ensureDeepDataSchema())
  .then(() => ensure190Schema())
  .then(() => ensureSeedWorld190())
  .then(() => ensurePlayableOfficerSeeds())
  .then(() => {
    server.listen(port, () => {
      console.log(`api listening on ${port}`);

      const daySecondsRaw = process.env.GAME_DAY_SECONDS;
      const daySeconds = daySecondsRaw == null ? 3600 : Number(daySecondsRaw);
      if (!Number.isFinite(daySeconds) || daySeconds < 0) {
        console.warn(`invalid GAME_DAY_SECONDS=${daySecondsRaw} (ticker disabled)`);
        return;
      }
      if (daySeconds === 0) {
        console.log('game day ticker disabled (GAME_DAY_SECONDS=0)');
        return;
      }

      const ms = Math.max(10_000, Math.floor(daySeconds * 1000));
      console.log(`game day ticker enabled: every ${daySeconds}s`);

      const timer = setInterval(async () => {
        try {
          const t = await tickGameDay();
          console.log(`tick day -> ${t.year}-${t.month}-${t.day}`);
        } catch (err) {
          console.error('tick day failed', err);
        }
      }, ms);
      if (typeof timer.unref === 'function') timer.unref();

      const matchTick = setInterval(async () => {
        try {
          await autobattlerTickOnce();
        } catch (err) {
          if (process.env.LOG_MATCH_TICK === '1') console.error('match tick failed', err);
        }
      }, 1000);
      if (typeof matchTick.unref === 'function') matchTick.unref();
    });
  })
  .catch((err) => {
    console.error('schema init failed', err);
    process.exit(1);
  });
