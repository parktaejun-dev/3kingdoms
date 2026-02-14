import React from 'react';
import { createRoot } from 'react-dom/client';
import { Terminal } from 'xterm';
import { io } from 'socket.io-client';
import 'xterm/css/xterm.css';
import './ui.css';

function uuid() {
  // crypto.randomUUID() requires a secure context (https/localhost). This service is plain http.
  try {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID();
  } catch {
    // ignore
  }
  try {
    if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function') {
      const b = new Uint8Array(16);
      globalThis.crypto.getRandomValues(b);
      b[6] = (b[6] & 0x0f) | 0x40;
      b[8] = (b[8] & 0x3f) | 0x80;
      const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
  } catch {
    // ignore
  }
  const s4 = () => Math.floor((1 + Math.random()) * 0x10000).toString(16).slice(1);
  return `${s4()}${s4()}-${s4()}-${s4()}-${s4()}-${s4()}${s4()}${s4()}`;
}

function isUuid(v) {
  const s = String(v || '').trim();
  // Accept RFC 4122 variants. We don't enforce v4 only.
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
}

function safeLocalStorageGet(key, fallback = '') {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}

function safeLocalStorageSet(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
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

function PixelPortrait({ seedText = '', size = 64, className = 'portrait portrait-pixel' }) {
  const ref = React.useRef(null);
  React.useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const W = Math.max(16, Math.min(256, Number(size || 64)));
    const H = W;
    canvas.width = W;
    canvas.height = H;
    ctx.imageSmoothingEnabled = false;

    const rnd = mulberry32(hashSeed(seedText));
    const bg = '#02050c';
    const ink = '#a6ffb7';
    const dim = 'rgba(166,255,183,0.45)';
    const amber = '#ffd38d';

    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // Frame glow
    ctx.fillStyle = 'rgba(0,255,102,0.08)';
    for (let i = 0; i < 4; i += 1) ctx.fillRect(i, i, W - i * 2, 1);

    // Simple pixel face generator (not a real likeness).
    const skin = rnd() < 0.5 ? '#d2b48c' : '#caa27a';
    const hair = rnd() < 0.5 ? '#1b1f2a' : '#10141d';
    const armor = rnd() < 0.5 ? '#2b3344' : '#1f2a3a';

    const cx = Math.floor(W / 2);
    const cy = Math.floor(H * 0.44);
    const faceW = 20 + Math.floor(rnd() * 6);
    const faceH = 22 + Math.floor(rnd() * 6);

    // Helmet / hair
    ctx.fillStyle = hair;
    ctx.fillRect(cx - faceW / 2 - 2, cy - faceH / 2 - 10, faceW + 4, 12);
    ctx.fillStyle = dim;
    ctx.fillRect(cx - faceW / 2 - 2, cy - faceH / 2 - 10, faceW + 4, 1);

    // Face
    ctx.fillStyle = skin;
    ctx.fillRect(cx - faceW / 2, cy - faceH / 2, faceW, faceH);

    // Eyes
    ctx.fillStyle = '#0b0e16';
    const eyeY = cy - 3;
    const eyeX1 = cx - 6;
    const eyeX2 = cx + 4;
    ctx.fillRect(eyeX1, eyeY, 3, 2);
    ctx.fillRect(eyeX2, eyeY, 3, 2);
    ctx.fillStyle = ink;
    ctx.fillRect(eyeX1 + 1, eyeY, 1, 1);
    ctx.fillRect(eyeX2 + 1, eyeY, 1, 1);

    // Brows
    ctx.fillStyle = hair;
    ctx.fillRect(eyeX1 - 1, eyeY - 2, 5, 1);
    ctx.fillRect(eyeX2 - 1, eyeY - 2, 5, 1);

    // Mouth / scar
    ctx.fillStyle = '#0b0e16';
    ctx.fillRect(cx - 3, cy + 6, 6, 1);
    if (rnd() < 0.55) {
      ctx.fillStyle = 'rgba(255,90,90,0.5)';
      ctx.fillRect(cx + 5, cy - 1, 1, 6);
    }

    // Armor
    ctx.fillStyle = armor;
    const armorY = Math.floor(H * 0.66);
    ctx.fillRect(Math.floor(W * 0.16), armorY, Math.floor(W * 0.68), H - armorY - 2);
    ctx.fillStyle = 'rgba(0,255,102,0.10)';
    ctx.fillRect(Math.floor(W * 0.16), armorY, Math.floor(W * 0.68), 2);

    // Sigil
    ctx.fillStyle = amber;
    ctx.fillRect(cx - 2, armorY + 8, 4, 4);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(cx - 1, armorY + 9, 2, 2);
  }, [seedText]);

  return React.createElement('canvas', { ref, className, 'aria-label': 'portrait' });
}

function RadarMini({ stats }) {
  const ref = React.useRef(null);
  React.useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const W = 220;
    const H = 200;
    canvas.width = W * 2;
    canvas.height = H * 2;
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    ctx.scale(2, 2);

    const labels = ['LDR', 'WAR', 'INT', 'POL', 'CHR'];
    const values = labels.map((k) => {
      const v = Number(stats?.[k] ?? 0);
      return Math.max(0, Math.min(120, Number.isFinite(v) ? v : 0));
    });

    ctx.clearRect(0, 0, W, H);

    const cx = 110;
    const cy = 100;
    const rMax = 78;

    const grid = ['rgba(143,255,205,0.10)', 'rgba(143,255,205,0.08)'];
    for (let ring = 1; ring <= 4; ring += 1) {
      const r = (rMax * ring) / 4;
      ctx.beginPath();
      for (let i = 0; i < 5; i += 1) {
        const a = (-Math.PI / 2) + (i * (2 * Math.PI)) / 5;
        const x = cx + Math.cos(a) * r;
        const y = cy + Math.sin(a) * r;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.strokeStyle = grid[ring % 2];
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // Spokes + labels
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';
    ctx.fillStyle = 'rgba(231,255,242,0.70)';
    for (let i = 0; i < 5; i += 1) {
      const a = (-Math.PI / 2) + (i * (2 * Math.PI)) / 5;
      const x2 = cx + Math.cos(a) * rMax;
      const y2 = cy + Math.sin(a) * rMax;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(x2, y2);
      ctx.strokeStyle = 'rgba(143,255,205,0.10)';
      ctx.stroke();

      const lx = cx + Math.cos(a) * (rMax + 14);
      const ly = cy + Math.sin(a) * (rMax + 14);
      const t = labels[i];
      ctx.fillText(t, lx - (t.length * 3), ly + 4);
    }

    // Polygon
    ctx.beginPath();
    for (let i = 0; i < 5; i += 1) {
      const a = (-Math.PI / 2) + (i * (2 * Math.PI)) / 5;
      const r = (values[i] / 120) * rMax;
      const x = cx + Math.cos(a) * r;
      const y = cy + Math.sin(a) * r;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fillStyle = 'rgba(54,243,177,0.16)';
    ctx.strokeStyle = 'rgba(54,243,177,0.45)';
    ctx.lineWidth = 2;
    ctx.fill();
    ctx.stroke();
  }, [stats]);

  return React.createElement('canvas', { ref, className: 'radar', 'aria-label': 'stats radar' });
}

function App() {
  const termRef = React.useRef(null);
  const terminal = React.useRef(null);
  const socketRef = React.useRef(null);
  const logRef = React.useRef(null);
  const promptInputRef = React.useRef(null);
  const debug = React.useMemo(() => {
    try {
      const qs = new URLSearchParams(window.location.search);
      return String(qs.get('debug') || '').trim() === '1';
    } catch {
      return false;
    }
  }, []);

  const [mode, setMode] = React.useState(() => {
    try {
      const qs = new URLSearchParams(window.location.search);
      const m = String(qs.get('mode') || '').trim();
      if (m === 'ui' || m === 'terminal' || m === 'dashboard') {
        safeLocalStorageSet('uiMode', m);
        return m;
      }
    } catch {
      // ignore
    }
    return safeLocalStorageGet('uiMode', 'ui') || 'ui';
  });

  // Older builds stored non-UUID ids (e.g. "player1"). Server now uses UUID keys, so migrate by clearing.
  const [playerId, setPlayerId] = React.useState(() => {
    const v = safeLocalStorageGet('playerId', '');
    return isUuid(v) ? v : '';
  });
  const [battleId, setBattleId] = React.useState(() => safeLocalStorageGet('battleId', ''));
  const [matchId, setMatchId] = React.useState(() => safeLocalStorageGet('matchId', ''));
  const [matchState, setMatchState] = React.useState(null);
  const [matchReplay, setMatchReplay] = React.useState(null);
  const [matchSelectedUnitId, setMatchSelectedUnitId] = React.useState('');
  const [matchBusy, setMatchBusy] = React.useState(false);
  // Stateless battle prototype (4x3) - used to validate "is combat fun" independent of 7x4 readability.
  const [protoRoster, setProtoRoster] = React.useState([]);
  const [protoSeed, setProtoSeed] = React.useState(() => String(Date.now()));
  const [protoSelected, setProtoSelected] = React.useState('xuchu');
  const [protoGrid, setProtoGrid] = React.useState(() => Array(24).fill(null)); // 4x6 global board (enemy 3 rows + player 3 rows)
  const [protoSim, setProtoSim] = React.useState(null);
  const [protoBusy, setProtoBusy] = React.useState(false);
  const [protoPlay, setProtoPlay] = React.useState({ on: false, t: 0, units: {}, idx: 0 });

  const [me, setMe] = React.useState(null);
  const [party, setParty] = React.useState({ count: 0 });
  const [gameTime, setGameTime] = React.useState(null);
  const [actions, setActions] = React.useState([]);
  const [nearby, setNearby] = React.useState([]);
  const [feed, setFeed] = React.useState([]);
  const [inputValue, setInputValue] = React.useState('');
  const [storyChoices, setStoryChoices] = React.useState([]);
  const [portraitPrompt, setPortraitPrompt] = React.useState('');
  const [portraitStyle, setPortraitStyle] = React.useState('drama'); // drama | realistic | ink | pixel
  const [portraitFocus, setPortraitFocus] = React.useState('face'); // face | bust
  const [portraitAnchors, setPortraitAnchors] = React.useState([]);
  const [localNotes, setLocalNotes] = React.useState([]);
  const [showPortraitModal, setShowPortraitModal] = React.useState(false);

  const [uiError, setUiError] = React.useState('');
  const [lastPointer, setLastPointer] = React.useState('');
  const [lastAction, setLastAction] = React.useState('');
  const [mainTab, setMainTab] = React.useState('map'); // map | region | bio
  const [mapPick, setMapPick] = React.useState(null); // { cityId, name }
  const [dashTab, setDashTab] = React.useState('play'); // design | play | db | arch
  const [showMapOverlay, setShowMapOverlay] = React.useState(false);
  const [showShopOverlay, setShowShopOverlay] = React.useState(false);
  const [shopItems, setShopItems] = React.useState([]);
  const [showInventoryOverlay, setShowInventoryOverlay] = React.useState(false);
  const [inventoryItems, setInventoryItems] = React.useState([]);
  const [inventoryTab, setInventoryTab] = React.useState('equipment'); // equipment | consumable | all
  const [showChronicleOverlay, setShowChronicleOverlay] = React.useState(false);
  const [chronicle, setChronicle] = React.useState(null);
  const [showEmployOverlay, setShowEmployOverlay] = React.useState(false);
  const [employCandidates, setEmployCandidates] = React.useState([]);
  const [showOfficerPicker, setShowOfficerPicker] = React.useState(() => {
    const v = safeLocalStorageGet('playerId', '');
    return !isUuid(v);
  });
  const [pickerQuery, setPickerQuery] = React.useState('');
  const [pickerItems, setPickerItems] = React.useState([]);
  const [pickerLoading, setPickerLoading] = React.useState(false);
  const [pickerUsername, setPickerUsername] = React.useState('');
  const composingRef = React.useRef(false);
  const portraitSuggestOnceRef = React.useRef(false);

  function pushSystem(msg) {
    const note = {
      id: uuid(),
      created_at: new Date().toISOString(),
      msg: String(msg || ''),
      expires_at: Date.now() + 9000
    };
    setLocalNotes((prev) => prev.concat([note]).slice(-8));
  }

  React.useEffect(() => {
    if (!localNotes.length) return;
    const t = setInterval(() => {
      const now = Date.now();
      setLocalNotes((prev) => prev.filter((n) => n.expires_at > now));
    }, 800);
    return () => clearInterval(t);
  }, [localNotes.length]);

  React.useEffect(() => {
    // Load roster for the 4x3 stateless battle prototype.
    fetch('/api/proto/battle/roster', { cache: 'no-store' })
      .then((r) => r.json().catch(() => null))
      .then((data) => {
        if (data && data.ok && Array.isArray(data.roster)) setProtoRoster(data.roster);
      })
      .catch(() => null);
  }, []);

  function protoCellToLocal(idx) {
    const x = idx % 4;
    const y = Math.floor(idx / 4);
    const seat = y < 3 ? 2 : 1; // top 3 rows = enemy
    const localY = seat === 1 ? y - 3 : y;
    return { x, y, seat, localY };
  }

  function protoSetCell(idx, unitId) {
    setProtoGrid((prev) => {
      const next = prev.slice();
      next[idx] = unitId || null;
      return next;
    });
  }

  function protoUnitsFromGrid(seat) {
    const units = [];
    for (let i = 0; i < protoGrid.length; i += 1) {
      const unitId = protoGrid[i];
      if (!unitId) continue;
      const c = protoCellToLocal(i);
      if (c.seat !== seat) continue;
      units.push({ unitId, x: c.x, y: c.localY });
    }
    return units;
  }

  async function protoSimulate() {
    setProtoBusy(true);
    setProtoSim(null);
    setProtoPlay({ on: false, t: 0, units: {}, idx: 0 });
    try {
      const p1Units = protoUnitsFromGrid(1);
      const p2Units = protoUnitsFromGrid(2);
      const resp = await fetch('/api/proto/battle/simulate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ seed: protoSeed, p1Units, p2Units }),
        cache: 'no-store'
      });
      const data = await resp.json().catch(() => null);
      setProtoSim(data && data.ok ? data : { ok: false, error: data?.error || `HTTP ${resp.status}` });
    } catch (err) {
      setProtoSim({ ok: false, error: err?.message ? String(err.message) : String(err) });
    } finally {
      setProtoBusy(false);
    }
  }

  React.useEffect(() => {
    if (!protoSim || !protoSim.ok || !protoPlay.on) return;
    const timeline = Array.isArray(protoSim.timeline) ? protoSim.timeline : [];
    const byTime = timeline.slice().sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
    const tick = 100;
    const timer = setInterval(() => {
      setProtoPlay((prev) => {
        if (!prev.on) return prev;
        const nextT = prev.t + tick;
        const units = { ...prev.units };
        let idx = prev.idx;
        while (idx < byTime.length && (byTime[idx].t ?? 0) <= nextT) {
          const e = byTime[idx];
          if (e.type === 'move' && units[e.src]) {
            units[e.src] = { ...units[e.src], x: e.to?.x ?? units[e.src].x, y: e.to?.y ?? units[e.src].y };
          } else if ((e.type === 'attack' || e.type === 'hit' || e.type === 'dot' || e.type === 'trap_hit') && units[e.dst]) {
            units[e.dst] = { ...units[e.dst], hp: e.dstHp ?? units[e.dst].hp };
          } else if (e.type === 'death' && units[e.src]) {
            units[e.src] = { ...units[e.src], hp: 0 };
          } else if (e.type === 'knockback' && units[e.dst]) {
            units[e.dst] = { ...units[e.dst], x: e.to?.x ?? units[e.dst].x, y: e.to?.y ?? units[e.dst].y };
          } else if (e.type === 'skill' && (e.skill === 'execute' || e.skill === 'charge') && units[e.src]) {
            units[e.src] = { ...units[e.src], x: e.to?.x ?? units[e.src].x, y: e.to?.y ?? units[e.src].y };
          }
          idx += 1;
        }
        const done = idx >= byTime.length;
        return done ? { on: false, t: nextT, units, idx } : { ...prev, t: nextT, units, idx };
      });
    }, tick);
    return () => clearInterval(timer);
  }, [protoSim, protoPlay.on]);

  async function execGameCommand(command, payload = {}) {
    if (!playerId) return { ok: false, error: '먼저 bootstrap 실행' };
    try {
      const resp = await fetch('/api/game/command', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'Idempotency-Key': uuid() },
        body: JSON.stringify({ playerId, command, payload }),
        cache: 'no-store'
      });
      const data = await resp.json().catch(() => null);
      if (!resp.ok) {
        return data || { ok: false, error: `HTTP ${resp.status}` };
      }
      return data || { ok: false, error: 'invalid response' };
    } catch (err) {
      return { ok: false, error: err?.message ? String(err.message) : String(err) };
    }
  }

  function invQty(itemId) {
    const inv = me?.inventory;
    if (!Array.isArray(inv)) return 0;
    const hit = inv.find((x) => x && x.id === itemId);
    return hit && typeof hit.qty === 'number' ? hit.qty : 0;
  }

  function equipmentObj() {
    const e = me?.equipment;
    return e && typeof e === 'object' ? e : {};
  }

  function equippedId(slot) {
    const e = equipmentObj();
    const s = String(slot || '').trim().toLowerCase();
    const id = e[s];
    return typeof id === 'string' && id.trim() ? id.trim() : '';
  }

  async function openShop() {
    const r = await execGameCommand('shop', {});
    if (!r?.ok) {
      setUiError(`shop 실패: ${r?.error || 'unknown'}`);
      return;
    }
    const items = r?.extra?.items;
    setShopItems(Array.isArray(items) ? items : []);
    setShowShopOverlay(true);
    await refreshUI();
  }

  async function openInventory() {
    const r = await execGameCommand('inventory', {});
    if (!r?.ok) {
      setUiError(`inventory 실패: ${r?.error || 'unknown'}`);
      return;
    }
    const items = r?.extra?.items;
    setInventoryItems(Array.isArray(items) ? items : []);
    setInventoryTab('equipment');
    setShowInventoryOverlay(true);
    await refreshUI();
  }

  async function openChronicle() {
    if (!playerId) {
      setUiError('먼저 bootstrap 실행');
      return;
    }
    try {
      const r = await fetch(`/api/player/${encodeURIComponent(playerId)}/chronicle`, { cache: 'no-store' })
        .then((rr) => rr.json().catch(() => null))
        .catch((err) => ({ ok: false, error: err?.message ? String(err.message) : String(err) }));
      if (!r?.ok) {
        setUiError(`chronicle 실패: ${r?.error || 'unknown'}`);
        return;
      }
      setChronicle(r);
      setShowChronicleOverlay(true);
    } catch (err) {
      setUiError(`chronicle 실패: ${err?.message ? String(err.message) : String(err)}`);
    }
  }

  function feedKind(it) {
    const t = String(it?.event_type || 'log');
    if (t === 'loot') return 'loot';
    if (t === 'reward') return 'reward';
    if (t === 'fame') return 'fame';
    if (t === 'episode' || t === 'episode_resolve') return 'episode';
    return 'default';
  }

  function isSystemFeed(it) {
    const t = String(it?.event_type || '').trim();
    if (!t) return true;
    // Never show technical/system noise in the LOG pane. Player feedback is delivered via toast notes.
    return (
      t === 'system' ||
      t === 'debug' ||
      t === 'ui' ||
      t === 'status' ||
      t === 'map' ||
      t === 'hint' ||
      t === 'tip'
    );
  }

  function feedRenderText(it) {
    const t = String(it?.event_type || '').trim();
    const narration = String(it?.narration || '').trim();
    const summary = String(it?.event_data?.summary || '').trim();

    // For "story events", either they are deterministic (summary-only) or narrative (narration).
    const summaryOnly = new Set(['loot', 'reward', 'fame', 'quest', 'episode_resolve']);
    const alwaysOk = new Set(['episode', 'chapter_end']);

    if (narration) return narration;
    if (summaryOnly.has(t) || alwaysOk.has(t)) return summary || t;

    // For most actions, wait for narration instead of flashing a system-ish placeholder.
    return '';
  }

  function feedTitle(it) {
    const t = String(it?.event_type || 'log');
    const d = it?.event_data || {};
    if (t === 'loot') {
      const name = d.itemName || d.item_id || d.itemId || 'item';
      const qty = typeof d.qty === 'number' ? d.qty : '';
      return `LOOT: ${name}${qty ? ` x${qty}` : ''}`;
    }
    if (t === 'reward') return 'REWARD';
    if (t === 'fame') return 'FAME';
    if (t === 'episode') return 'EPISODE';
    if (t === 'episode_resolve') return 'CHOICE';
    return String(t).toUpperCase();
  }

  async function openEmployCandidates() {
    if (!playerId) {
      setUiError('먼저 bootstrap 실행');
      return;
    }
    const r = await fetch(`/api/player/${encodeURIComponent(playerId)}/employ_candidates`, { cache: 'no-store' })
      .then((rr) => rr.json().catch(() => null))
      .catch((err) => ({ ok: false, error: err?.message ? String(err.message) : String(err) }));
    if (!r?.ok) {
      setUiError(`등용 후보 조회 실패: ${r?.error || 'unknown'}`);
      return;
    }
    setEmployCandidates(Array.isArray(r.items) ? r.items : []);
    setShowEmployOverlay(true);
  }

  async function bootstrapPlayer({ officerId = null, officerName = null, username = null } = {}) {
    try {
      const body = {};
      if (officerId) body.officerId = String(officerId);
      if (officerName) body.officerName = String(officerName);
      if (username) body.username = String(username);
      const resp = await fetch('/api/player/bootstrap', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        cache: 'no-store'
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || !data?.id) return { ok: false, error: data?.error || String(resp.status) };

      safeLocalStorageSet('playerId', data.id);
      setPlayerId(data.id);
      return { ok: true, id: data.id };
    } catch (err) {
      return { ok: false, error: err?.message ? String(err.message) : String(err) };
    }
  }

  async function loadAvailableOfficers(query = '') {
    setPickerLoading(true);
    setUiError('');
    try {
      const q = String(query || '').trim();
      const resp = await fetch(`/api/officers/available?limit=50&q=${encodeURIComponent(q)}`, { cache: 'no-store' });
      const data = await resp.json().catch(() => null);
      if (!resp.ok || !data?.ok) {
        setUiError(`장수 목록 로드 실패: ${data?.error || `HTTP ${resp.status}`}`);
        setPickerItems([]);
        return;
      }
      setPickerItems(Array.isArray(data.items) ? data.items : []);
    } catch (err) {
      setUiError(`장수 목록 로드 실패: ${err?.message ? String(err.message) : String(err)}`);
      setPickerItems([]);
    } finally {
      setPickerLoading(false);
    }
  }

  async function refreshUI() {
    if (!playerId) return;
    try {
      const sResp = await fetch(`/api/player/${playerId}/status`, { cache: 'no-store' });
      const s = await sResp.json().catch(() => null);
      if (s?.player) setMe(s.player);
      if (s?.party) setParty(s.party);
      if (s?.gameTime) setGameTime(s.gameTime);

      const naResp = await fetch(`/api/player/${playerId}/next_actions`, { cache: 'no-store' });
      const na = await naResp.json().catch(() => null);
      if (na?.ok) {
        setActions(na.actions || []);
        setNearby(na.nearby || []);
      }

      const fResp = await fetch(`/api/player/${playerId}/feed?limit=40`, { cache: 'no-store' });
      const f = await fResp.json().catch(() => null);
      if (f?.ok) setFeed(f.items || []);
    } catch (err) {
      // Network errors should not crash the UI loop.
      const msg = err?.message ? String(err.message) : String(err);
      setUiError(`네트워크 오류: ${msg}`);
    }
  }

  function asNum(x, fallback = 0) {
    const n = Number(x);
    return Number.isFinite(n) ? n : fallback;
  }

  async function fetchMatchState({ mid = null } = {}) {
    const id = String(mid || matchId || '').trim();
    if (!playerId || !id) return null;
    try {
      const resp = await fetch(`/api/match/${encodeURIComponent(id)}/state?playerId=${encodeURIComponent(playerId)}`, { cache: 'no-store' });
      const data = await resp.json().catch(() => null);
      if (!resp.ok || !data?.ok) return null;
      setMatchState(data);
      return data;
    } catch {
      return null;
    }
  }

  async function createMatch() {
    if (!playerId) {
      setUiError('먼저 bootstrap 실행');
      return;
    }
    setMatchBusy(true);
    setUiError('');
    try {
      const resp = await fetch('/api/match/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ playerId }),
        cache: 'no-store'
      });
      const data = await resp.json().catch(() => null);
      if (!resp.ok || !data?.ok || !data?.matchId) {
        setUiError(`match create 실패: ${data?.error || `HTTP ${resp.status}`}`);
        return;
      }
      safeLocalStorageSet('matchId', data.matchId);
      setMatchId(data.matchId);
      setMatchReplay(null);
      setMatchSelectedUnitId('');
      pushSystem(`매치 생성: ${String(data.matchId).slice(0, 8)}...`);
      await fetchMatchState({ mid: data.matchId });
    } finally {
      setMatchBusy(false);
    }
  }

  async function matchPost(path, body) {
    if (!playerId || !matchId) return { ok: false, error: 'no match/player' };
    try {
      const resp = await fetch(`/api/match/${encodeURIComponent(matchId)}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ playerId, ...(body || {}) }),
        cache: 'no-store'
      });
      const data = await resp.json().catch(() => null);
      if (!resp.ok || !data?.ok) return data || { ok: false, error: `HTTP ${resp.status}` };
      return data;
    } catch (err) {
      return { ok: false, error: err?.message ? String(err.message) : String(err) };
    }
  }

  async function matchStoryChoice(choiceId) {
    const id = String(choiceId || '').trim();
    if (!id) return;
    setMatchBusy(true);
    const r = await matchPost('/story/choice', { choiceId: id });
    setMatchBusy(false);
    pushSystem(r.ok ? `선택: ${id}` : `선택 실패: ${r.error}`);
    await fetchMatchState();
  }

  async function matchReroll() {
    setMatchBusy(true);
    const r = await matchPost('/shop/reroll', {});
    setMatchBusy(false);
    pushSystem(r.ok ? '리롤 완료' : `리롤 실패: ${r.error}`);
    await fetchMatchState();
  }

  async function matchLock(nextLocked) {
    setMatchBusy(true);
    const r = await matchPost('/shop/lock', { locked: !!nextLocked });
    setMatchBusy(false);
    pushSystem(r.ok ? `상점 잠금: ${r.locked ? 'ON' : 'OFF'}` : `잠금 실패: ${r.error}`);
    await fetchMatchState();
  }

  async function matchBuy(slotIndex) {
    setMatchBusy(true);
    const r = await matchPost('/shop/buy', { slotIndex });
    setMatchBusy(false);
    pushSystem(r.ok ? `구매: ${r?.bought?.unitId || 'unit'} (gold -${r.goldCost || 0})` : `구매 실패: ${r.error}`);
    await fetchMatchState();
  }

  async function matchPlace(x, y) {
    const uid = String(matchSelectedUnitId || '').trim();
    if (!uid) {
      pushSystem('벤치에서 유닛을 먼저 선택하세요.');
      return;
    }
    setMatchBusy(true);
    const r = await matchPost('/board/place', { unitInstanceId: uid, x, y });
    setMatchBusy(false);
    pushSystem(r.ok ? `배치: (${x},${y})` : `배치 실패: ${r.error}`);
    if (r.ok) setMatchSelectedUnitId('');
    await fetchMatchState();
  }

  async function matchRemove(unitInstanceId) {
    const uid = String(unitInstanceId || '').trim();
    if (!uid) return;
    setMatchBusy(true);
    const r = await matchPost('/board/remove', { unitInstanceId: uid });
    setMatchBusy(false);
    pushSystem(r.ok ? '회수: 벤치로 이동' : `회수 실패: ${r.error}`);
    await fetchMatchState();
  }

  async function loadReplay(round) {
    if (!playerId || !matchId) return;
    const r = asNum(round, 0);
    if (r <= 0) return;
    try {
      const resp = await fetch(`/api/match/${encodeURIComponent(matchId)}/replay/${encodeURIComponent(String(r))}?playerId=${encodeURIComponent(playerId)}`, { cache: 'no-store' });
      const data = await resp.json().catch(() => null);
      if (!resp.ok || !data?.ok) {
        pushSystem(`리플레이 실패: ${data?.error || `HTTP ${resp.status}`}`);
        return;
      }
      setMatchReplay(data);
      pushSystem(`리플레이 로드: R${r}`);
    } catch (err) {
      pushSystem(`리플레이 실패: ${err?.message ? String(err.message) : String(err)}`);
    }
  }

  React.useEffect(() => {
    if (mode !== 'ui') return;
    let cancelled = false;

    async function tick() {
      if (cancelled) return;
      if (!playerId) return;
      await refreshUI();
    }

    tick();
    const t = setInterval(tick, 2500);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [mode, playerId]);

  React.useEffect(() => {
    if (mode !== 'ui') return;
    if (!playerId || !matchId) return;
    let cancelled = false;
    async function tick() {
      if (cancelled) return;
      await fetchMatchState();
    }
    tick();
    const t = setInterval(tick, 1000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, playerId, matchId]);

  React.useEffect(() => {
    if (mode !== 'ui') return;
    if (!showOfficerPicker) return;
    // Load once when picker opens.
    loadAvailableOfficers(pickerQuery);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, showOfficerPicker]);

  React.useEffect(() => {
    // Keep portrait prompt in sync when switching officers/players.
    setPortraitPrompt(String(me?.portrait_prompt || ''));
    setPortraitAnchors([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me?.id]);

  async function suggestPortraitPrompt({ style = null, focus = null } = {}) {
    if (!playerId) {
      setUiError('먼저 bootstrap 실행');
      return;
    }
    const st = String(style || portraitStyle || 'realistic');
    const fc = String(focus || portraitFocus || 'face');
    setUiError('');
    try {
      const url = `/api/portraits/suggest?playerId=${encodeURIComponent(playerId)}&style=${encodeURIComponent(st)}&focus=${encodeURIComponent(fc)}`;
      const resp = await fetch(url, { cache: 'no-store' });
      const data = await resp.json().catch(() => null);
      if (!resp.ok || !data?.ok) {
        setUiError(`자동완성 실패: ${data?.error || `HTTP ${resp.status}`}`);
        return;
      }
      setPortraitPrompt(String(data.prompt || ''));
      setPortraitAnchors(Array.isArray(data.anchors) ? data.anchors : []);
      pushSystem(`프롬프트 자동완성(${st}/${fc}) 적용`);
    } catch (err) {
      setUiError(`자동완성 실패: ${err?.message ? String(err.message) : String(err)}`);
    }
  }

  React.useEffect(() => {
    if (!showPortraitModal) {
      portraitSuggestOnceRef.current = false;
      return;
    }
    if (portraitSuggestOnceRef.current) return;
    portraitSuggestOnceRef.current = true;
    if (!playerId) return;
    if (String(portraitPrompt || '').trim()) return;
    suggestPortraitPrompt({ style: portraitStyle, focus: portraitFocus });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showPortraitModal, playerId, me?.id]);

  async function generatePortrait(size = 256) {
    if (!playerId) {
      setUiError('먼저 bootstrap 실행');
      return;
    }
    const p = String(portraitPrompt || '').trim();
    if (!p) {
      setUiError('초상 프롬프트가 비었습니다.');
      return;
    }
    setUiError('');
    pushSystem(`초상 생성 요청(${size})... (CPU라 1~3분 걸릴 수 있음)`);
    try {
      const resp = await fetch('/api/portraits/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ playerId, size, prompt: p }),
        cache: 'no-store'
      });
      const data = await resp.json().catch(() => null);
      if (!resp.ok || !data?.ok) {
        setUiError(`초상 생성 실패: ${data?.error || `HTTP ${resp.status}`}`);
        return;
      }
      await refreshUI();
    } catch (err) {
      setUiError(`초상 생성 실패: ${err?.message ? String(err.message) : String(err)}`);
    }
  }

  async function runCommand(cmd) {
    const raw = String(cmd || '').trim();
    if (!raw) return;
    if (raw === 'ui') {
      safeLocalStorageSet('uiMode', 'ui');
      setMode('ui');
      return;
    }
    if (raw === 'terminal') {
      safeLocalStorageSet('uiMode', 'terminal');
      setMode('terminal');
      return;
    }
    if (raw === 'dashboard') {
      safeLocalStorageSet('uiMode', 'dashboard');
      setMode('dashboard');
      return;
    }

    if (raw === 'bootstrap') {
      const r = await bootstrapPlayer({ username: `장수${Math.floor(Math.random() * 1000)}` });
      if (terminal.current) terminal.current.writeln(r.ok ? `플레이어 생성 완료: ${r.id}` : `오류: ${r.error}`);
      return;
    }

    if (!playerId) {
      if (terminal.current) terminal.current.writeln('먼저 bootstrap 실행');
      return;
    }

    const parts = raw.split(/\s+/).filter(Boolean);
    const verb = parts[0];
    const arg1 = parts.slice(1).join(' ');

    if (verb === 'help') {
      terminal.current.writeln('기본: bootstrap, status, story');
      terminal.current.writeln('쉬운 진행: next -> auto_day');
      terminal.current.writeln('장수 인맥: socialize (주막에서 인맥/등용 보너스)');
      terminal.current.writeln('전략: map_nearby, city <id|이름>, spy <id|이름>, travel <id|이름>');
      terminal.current.writeln('탐색/등용: search, employ <id|이름>');
      terminal.current.writeln('전투: battle_start, battle_state, battle_attack, battle_wait, battle_move_n/s/e/w');
      return;
    }

    if (raw === 'status') {
      const data = await fetch(`/api/player/${playerId}/status`, { cache: 'no-store' }).then((r) => r.json().catch(() => null));
      if (!data?.player) {
        terminal.current.writeln('오류: status 실패');
        return;
      }
      socketRef.current?.emit('join-officer', data.player.id);
      terminal.current.writeln(`장수:${data.player.name_kr} AP:${data.player.ap} 공적:${data.player.merit} 도시:${data.player.city_name}`);
      terminal.current.writeln(`시간: ${data.gameTime.year}년 ${data.gameTime.month}월 ${data.gameTime.day}일`);
      return;
    }

    if (verb === 'next') {
      const data = await fetch(`/api/player/${playerId}/next_actions`, { cache: 'no-store' }).then((r) => r.json().catch(() => null));
      if (!data?.ok) {
        terminal.current.writeln(`오류: ${data?.error || 'next 실패'}`);
        return;
      }
      terminal.current.writeln(`추천(${data.me.name}) AP:${data.me.ap} 도시:${data.me.cityName}`);
      (data.actions || []).forEach((a) => terminal.current.writeln(`- ${a.cmd} :: ${a.why}`));
      return;
    }

    if (raw === 'auto_day') {
      const data = await execGameCommand('auto_day', {});
      terminal.current.writeln(data.ok ? data.summary : `오류: ${data.error}`);
      return;
    }

    if (raw === 'map_nearby') {
      const data = await fetch(`/api/map/nearby?playerId=${encodeURIComponent(playerId)}`, { cache: 'no-store' }).then((r) => r.json().catch(() => null));
      if (!data?.ok) {
        terminal.current.writeln(`오류: ${data?.error || '조회 실패'}`);
        return;
      }
      terminal.current.writeln(`현재 도시: ${data.fromCityId}`);
      (data.nearby || []).forEach((n) => terminal.current.writeln(`- ${n.city_id} (${n.name_kr}) 거리:${n.distance} 지형:${n.terrain} 소유:${n.owner_force_id}`));
      return;
    }

    if (verb === 'city') {
      const target = arg1.trim();
      const data = await fetch(`/api/city/${encodeURIComponent(target)}?playerId=${encodeURIComponent(playerId)}`, { cache: 'no-store' }).then((r) => r.json().catch(() => null));
      if (!data?.ok) {
        terminal.current.writeln(`오류: ${data?.error || '조회 실패'}`);
        return;
      }
      const c = data.city;
      terminal.current.writeln(`도시:${c.id}(${c.name_kr}) 소유:${c.owner_force_id}`);
      terminal.current.writeln(`금:${c.gold} 쌀:${c.rice} 인구:${c.population} 상:${c.commerce} 농:${c.farming} 방:${c.defense}`);
      return;
    }

    if (verb === 'spy') {
      const target = arg1.trim();
      const data = await execGameCommand('spy', { toCityId: target, toCityName: target });
      if (!data.ok) {
        terminal.current.writeln(`오류: ${data.error}`);
        return;
      }
      terminal.current.writeln(data.summary);
      const intel = data.extra?.intel;
      if (intel) {
        terminal.current.writeln(`정찰:${intel.cityId}(${intel.name}) 추정소유:${intel.owner_force_id} 정확도:${intel.accuracy.toFixed(2)}`);
      }
      return;
    }

    if (verb === 'travel') {
      const target = arg1.trim();
      const data = await execGameCommand('travel', { toCityId: target, toCityName: target });
      terminal.current.writeln(data.ok ? data.summary : `오류: ${data.error}`);
      return;
    }

    if (verb === 'pledge' || raw === 'request_governor') {
      terminal.current.writeln('이 게임은 군주/관직 운영이 아닌 “퀘스트+레벨업(장수 1인)” 게임입니다. (해당 커맨드는 폐기됨)');
      return;
    }

    if (raw === 'search') {
      const data = await execGameCommand('search', {});
      terminal.current.writeln(data.ok ? data.summary : `오류: ${data.error}`);
      return;
    }

    if (verb === 'employ') {
      const target = arg1.trim();
      const data = await execGameCommand('employ', { targetOfficerId: target, targetName: target });
      terminal.current.writeln(data.ok ? data.summary : `오류: ${data.error}`);
      return;
    }

    if (raw === 'battle_start') {
      const resp = await fetch('/api/battle/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ playerId }),
        cache: 'no-store'
      });
      const data = await resp.json().catch(() => null);
      if (!data?.ok) {
        terminal.current.writeln(`오류: ${data?.error || 'battle_start 실패'}`);
        return;
      }
      safeLocalStorageSet('battleId', data.battleId);
      setBattleId(data.battleId);
      terminal.current.writeln(`전투 시작: ${data.battleId}`);
      return;
    }

    if (raw === 'battle_state') {
      const id = battleId || safeLocalStorageGet('battleId', '');
      if (!id) {
        terminal.current.writeln('진행 중 전투가 없습니다. battle_start 실행');
        return;
      }
      const data = await fetch(`/api/battle/${id}/state`, { cache: 'no-store' }).then((r) => r.json().catch(() => null));
      if (!data?.ok) {
        terminal.current.writeln(`오류: ${data?.error || 'state 조회 실패'}`);
        return;
      }
      terminal.current.writeln(`전투:${id} 상태:${data.battle.status} 턴:${data.battle.turn} HP ${data.battle.playerHp}/${data.battle.enemyHp}`);
      terminal.current.writeln(data.battle.lastLog);
      (data.battle.map || []).forEach((line) => terminal.current.writeln(line));
      return;
    }

    if (raw === 'battle_attack' || raw === 'battle_wait' || raw.startsWith('battle_move_')) {
      const id = battleId || safeLocalStorageGet('battleId', '');
      if (!id) {
        terminal.current.writeln('진행 중 전투가 없습니다. battle_start 실행');
        return;
      }
      let action = 'wait';
      let direction = null;
      if (raw === 'battle_attack') action = 'attack';
      else if (raw.startsWith('battle_move_')) {
        action = 'move';
        direction = raw.replace('battle_move_', '').slice(0, 1);
      }
      const resp = await fetch(`/api/battle/${id}/action`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, direction }),
        cache: 'no-store'
      });
      const data = await resp.json().catch(() => null);
      if (!data?.ok) {
        terminal.current.writeln(`오류: ${data?.error || 'battle action 실패'}`);
        return;
      }
      terminal.current.writeln(data.battle.log);
      (data.battle.map || []).forEach((line) => terminal.current.writeln(line));
      if (data.battle.status !== 'ongoing') {
        safeLocalStorageSet('battleId', '');
        setBattleId('');
      }
      return;
    }

    const data = await execGameCommand(raw, {});
    terminal.current.writeln(data.ok ? data.summary : `오류: ${data.error}`);
  }

  React.useEffect(() => {
    if (mode !== 'terminal') return;

    const term = new Terminal({
      cols: 100,
      rows: 30,
      theme: { background: '#0b0e1a', foreground: '#f7f3d7', cursor: '#f79f24' }
    });
    term.open(termRef.current);
    term.focus();
    terminal.current = term;

    term.writeln('=== Red Cliff Terminal ===');
    term.writeln('명령: bootstrap, status, story, socialize');
    term.writeln('쉬운 진행: next, auto_day');
    term.writeln('전략: map_nearby, travel <id|이름>, city <id|이름>, spy <id|이름>');
    term.writeln('탐색/등용: search, employ <id|이름>');
    term.writeln('전투: battle_start, battle_state, battle_attack, battle_wait, battle_move_n/s/e/w');

    const socket = io('/');
    socketRef.current = socket;
    socket.on('game-event', (evt) => {
      term.writeln(`\r\n[실시간] ${evt.summary}`);
      renderInput();
    });

    const prompt = '> ';
    let buffer = '';
    let cursor = 0;

    function renderInput() {
      term.write('\r\x1b[2K');
      term.write(prompt + buffer);
      term.write('\r');
      term.write(prompt);
      if (cursor > 0) term.write(`\x1b[${cursor}C`);
    }

    renderInput();

    term.onData((data) => {
      if (!data) return;
      if (data === '\r' || data === '\n') return;
      // Handle text entry (including paste) here. Editing keys are handled in onKey()
      // to avoid double-processing (xterm emits both onKey + onData for normal typing).
      if (data === '\x7f' || data === '\b') return;
      if (data.startsWith('\x1b')) return;
      buffer = buffer.slice(0, cursor) + data + buffer.slice(cursor);
      cursor += data.length;
      renderInput();
    });

    term.onKey(async ({ key, domEvent }) => {
      const k = domEvent.key;
      const ctrl = domEvent.ctrlKey || domEvent.metaKey;

      if (k === 'Enter') {
        domEvent.preventDefault();
        const cmd = buffer.trim();
        buffer = '';
        cursor = 0;
        term.writeln('');
        await runCommand(cmd);
        renderInput();
        return;
      }

      if (k === 'Backspace' || domEvent.keyCode === 8) {
        domEvent.preventDefault();
        if (cursor > 0) {
          buffer = buffer.slice(0, cursor - 1) + buffer.slice(cursor);
          cursor -= 1;
          renderInput();
        }
        return;
      }

      if (k === 'Delete' || domEvent.keyCode === 46) {
        domEvent.preventDefault();
        if (cursor < buffer.length) {
          buffer = buffer.slice(0, cursor) + buffer.slice(cursor + 1);
          renderInput();
        }
        return;
      }

      if (k === 'ArrowLeft') {
        domEvent.preventDefault();
        cursor = Math.max(0, cursor - 1);
        renderInput();
        return;
      }

      if (k === 'ArrowRight') {
        domEvent.preventDefault();
        cursor = Math.min(buffer.length, cursor + 1);
        renderInput();
        return;
      }

      if (k === 'Home') {
        domEvent.preventDefault();
        cursor = 0;
        renderInput();
        return;
      }

      if (k === 'End') {
        domEvent.preventDefault();
        cursor = buffer.length;
        renderInput();
        return;
      }

      if (ctrl) return;
      // Normal printable characters are handled in onData() so paste/IME works and
      // we don't process the same keystroke twice.
    });

    return () => {
      socket.disconnect();
      term.dispose();
    };
  }, [mode, playerId, battleId]);

  function ownerColor(owner) {
    if (owner === 'wei') return '#d84b4b';
    if (owner === 'shu') return '#4bbf73';
    if (owner === 'wu') return '#4b7bd8';
    return '#8b8f99';
  }

  async function uiSend(cmd) {
    const raw = String(cmd || '').trim();
    if (!raw) return;
    setUiError('');
    setLastAction(raw);

    if (raw === 'terminal') {
      safeLocalStorageSet('uiMode', 'terminal');
      setMode('terminal');
      return;
    }
    if (raw === 'bootstrap') {
      setShowOfficerPicker(true);
      await loadAvailableOfficers(pickerQuery);
      return;
    }
    if (raw === 'shop') {
      await openShop();
      return;
    }
    if (raw === 'inventory') {
      await openInventory();
      return;
    }
    if (raw === 'chronicle') {
      await openChronicle();
      return;
    }
    if (!playerId) {
      setUiError('먼저 bootstrap 실행이 필요합니다. (상단 bootstrap 버튼 클릭)');
      pushSystem('먼저 bootstrap 실행');
      return;
    }
    if (raw === 'next') {
      await refreshUI();
      pushSystem('추천 행동 갱신 완료');
      return;
    }
    if (raw === 'story') {
      const r = await execGameCommand('story', {});
      pushSystem(r.ok ? r.summary : `오류: ${r.error}`);
      if (!r.ok) setUiError(`story 실패: ${r.error}`);
      if (r?.ok && Array.isArray(r?.extra?.choices)) setStoryChoices(r.extra.choices);
      return;
    }
    if (raw === 'status') {
      const s = await fetch(`/api/player/${playerId}/status`, { cache: 'no-store' }).then((r) => r.json().catch(() => null));
      if (s?.player) setMe(s.player);
      if (s?.party) setParty(s.party);
      if (s?.gameTime) setGameTime(s.gameTime);
      pushSystem(s?.player ? `상태: ${s.player.name_kr} AP:${s.player.ap} 공적:${s.player.merit} 도시:${s.player.city_name}` : '오류: status 실패');
      return;
    }
    if (raw === 'map_nearby') {
      const m = await fetch(`/api/map/nearby?playerId=${encodeURIComponent(playerId)}`, { cache: 'no-store' }).then((r) => r.json().catch(() => null));
      if (m?.ok) {
        setNearby(m.nearby || []);
        pushSystem(`근거리 지도 갱신: ${String(m.fromCityId || '')}`);
      } else {
        pushSystem(`오류: ${(m?.error || 'map_nearby 실패')}`);
      }
      return;
    }

    try {
      const parts = raw.split(/\s+/).filter(Boolean);
      const verb = parts[0];
      const arg1 = parts.slice(1).join(' ');
      let r = null;
      if (verb === 'travel') r = await execGameCommand('travel', { toCityId: arg1, toCityName: arg1 });
      else if (verb === 'spy') r = await execGameCommand('spy', { toCityId: arg1, toCityName: arg1 });
      else if (verb === 'employ') {
        if (!arg1) {
          await openEmployCandidates();
          return;
        }
        r = await execGameCommand('employ', { targetOfficerId: arg1, targetName: arg1 });
      } else if (verb === 'shop') {
        await openShop();
        return;
      } else if (verb === 'buy') r = await execGameCommand('buy', { itemId: arg1 });
      else if (verb === 'use') r = await execGameCommand('use', { itemId: arg1 });
      else if (verb === 'deal') r = await execGameCommand('deal', { questKey: arg1 });
      else if (verb === 'duel') r = await execGameCommand('duel', { questKey: arg1 });
      else if (verb === 'favor') r = await execGameCommand('favor', { questKey: arg1 });
      else if (verb === 'skirmish') r = await execGameCommand('skirmish', {});
      else if (verb === 'breakout') r = await execGameCommand('breakout', {});
      else if (verb === 'scout_accept') r = await execGameCommand('scout_accept', { factionId: arg1 });
      else if (verb === 'scout_decline') r = await execGameCommand('scout_decline', { factionId: arg1 });
      else if (verb === 'visit') r = await execGameCommand('visit', { targetOfficerId: arg1, targetName: arg1 });
      else if (verb === 'gift') r = await execGameCommand('gift', { targetOfficerId: arg1, targetName: arg1 });
      else if (verb === 'city') {
        const q = String(arg1 || '').trim();
        const c = await fetch(`/api/city/${encodeURIComponent(q)}?playerId=${encodeURIComponent(playerId)}`, { cache: 'no-store' })
          .then((rr) => rr.json().catch(() => null))
          .catch((err) => ({ ok: false, error: err?.message ? String(err.message) : String(err) }));
        if (c?.ok) pushSystem(`도시: ${c.city?.name_kr || q} 금:${c.city?.gold} 쌀:${c.city?.rice} 인구:${c.city?.population} 방:${c.city?.defense}`);
        else {
          pushSystem(`오류: ${(c?.error || 'city 조회 실패')}`);
          setUiError(`city 실패: ${c?.error || 'city 조회 실패'}`);
        }
        return;
      } else r = await execGameCommand(raw, {});

      pushSystem(r.ok ? r.summary : `오류: ${r.error}`);
      if (!r.ok) setUiError(`${raw} 실패: ${r.error}`);
      if (r.ok) await refreshUI();
      if (r?.ok) setStoryChoices([]);
    } catch (err) {
      const msg = err?.message ? String(err.message) : String(err);
      pushSystem(`오류: ${msg}`);
      setUiError(msg);
    }
  }

  function clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
  }

  function bar(value, max, width = 18) {
    const v = typeof value === 'number' ? value : 0;
    const m = typeof max === 'number' && max > 0 ? max : 100;
    const filled = clamp(Math.round((v / m) * width), 0, width);
    return `[${'|'.repeat(filled)}${'.'.repeat(width - filled)}]`;
  }

  function knownCityNameToId(name) {
    const s = String(name || '').trim();
    if (!s) return null;
    if (me?.city_name === s) return me?.city_id || null;
    const hit = (nearby || []).find((c) => c?.name_kr === s);
    return hit?.city_id || null;
  }

  function normalizeCmd(raw) {
    const s = String(raw || '').trim();
    if (!s) return '';
    const lower = s.toLowerCase();
    if (lower === '/s' || lower.startsWith('/status')) return 'status';
    if (lower === '/n' || lower.startsWith('/next')) return 'next';
    if (lower === '/e' || lower.startsWith('/end')) return 'end_turn';
    if (lower === '/a' || lower.startsWith('/auto')) return 'auto_day';
    if (lower === '/m' || lower.startsWith('/map')) return 'map_nearby';
    if (lower.startsWith('/t ')) return `travel ${s.slice(3).trim()}`;
    if (lower.startsWith('/spy ')) return `spy ${s.slice(5).trim()}`;
    if (lower.startsWith('/city ')) return `city ${s.slice(6).trim()}`;
    if (s.startsWith('/')) return s.slice(1); // best-effort: "/battle_start" -> "battle_start"
    return s;
  }

  function tryNaturalLanguageToCommand(text) {
    const s = String(text || '').trim();
    if (!s) return null;
    // Very small heuristic to keep the game easy until full intent parsing is added.
    if (/(다음|추천|뭐\s*하지)/.test(s)) return 'next';
    if (/(턴\s*종료|오늘\s*끝|하루\s*넘겨|날짜\s*진행)/.test(s)) return 'end_turn';
    if (/(자동|넘겨|진행)/.test(s)) return 'auto_day';
    if (/(스토리|임무|목표)/.test(s)) return 'story';
    if (/(상태|스탯|내\s*정보|내정보)/.test(s)) return 'status';
    if (/(휴식|쉬자|회복|잠깐\s*쉬)/.test(s)) return 'rest';
    if (/(훈련|수련|단련)/.test(s)) return 'train';
    if (/(탐색|수색|찾아|둘러)/.test(s)) return 'search';
    if (/(교류|사교|주막|술|인맥|친해|social)/i.test(s)) return 'socialize';
    if (/(상점|샵|아이템|shop)/i.test(s)) return 'shop';
    if (/(인벤|가방|inventory|items)/i.test(s)) return 'inventory';
    if (/(기록|열전|연대기|chronicle)/i.test(s)) return 'chronicle';
    if (/(거래|딜|deal)/i.test(s)) {
      const m = s.match(/(?:거래|딜|deal)\s+(.+)$/i);
      if (m && m[1]) return `deal ${m[1].trim()}`;
      return null;
    }
    if (/(결투|승부|duel)/i.test(s)) {
      const m = s.match(/(?:결투|승부|duel)\s+(.+)$/i);
      if (m && m[1]) return `duel ${m[1].trim()}`;
      return null;
    }
    if (/(인맥|소개|부탁|favor)/i.test(s)) {
      const m = s.match(/(?:인맥|소개|부탁|favor)\s+(.+)$/i);
      if (m && m[1]) return `favor ${m[1].trim()}`;
      return null;
    }
    if (/(소문|rumor)/i.test(s)) return 'recruit_rumor';
    if (/(방문|대화|만나|visit)/i.test(s)) {
      const m = s.match(/(?:방문|대화|만나|visit)\s+(.+)$/i);
      if (m && m[1]) return `visit ${m[1].trim()}`;
      return 'visit';
    }
    if (/(선물|gift)/i.test(s)) {
      const m = s.match(/(?:선물|gift)\s+(.+)$/i);
      if (m && m[1]) return `gift ${m[1].trim()}`;
      return 'gift';
    }
    if (/(연회|잔치|banquet)/i.test(s)) return 'banquet';
    if (/(진정|소요|소문\s*잡|calm)/i.test(s)) return 'calm';
    if (/(보급|일손|현장|지원|work)/i.test(s)) return 'work';
    if (/(인재\s*등용|등용|영입|모셔|recruit\s*officer)/i.test(s)) {
      const m = s.match(/(?:인재\s*등용|등용|영입|모셔)\s+(.+)$/i);
      if (m && m[1]) return `employ ${m[1].trim()}`;
      return 'employ';
    }
    const cityNames = [me?.city_name, ...(nearby || []).map((c) => c?.name_kr)].filter(Boolean);
    const city = cityNames.find((n) => s.includes(n));
    if (city) {
      if (/(정찰|살펴|동태|첩보|잠입)/.test(s)) return `spy ${city}`;
      if (/(가자|이동|가고|가서|출발|행군|여행)/.test(s)) return `travel ${city}`;
      if (/(도시|정보|상태|사정)/.test(s)) return `city ${city}`;
    }
    return null;
  }

  function renderWithKeywords(text) {
    const s = String(text || '');
    const parts = [];
    const re = /\[([^\]]+)\]/g;
    let last = 0;
    let m;
    while ((m = re.exec(s))) {
      if (m.index > last) parts.push({ t: 'text', v: s.slice(last, m.index) });
      parts.push({ t: 'kw', v: m[1] });
      last = m.index + m[0].length;
    }
    if (last < s.length) parts.push({ t: 'text', v: s.slice(last) });

    return parts.map((p, idx) => {
      if (p.t === 'kw') {
        return React.createElement(
          'span',
          {
            key: `kw-${idx}`,
            className: 'kw',
            role: 'button',
            tabIndex: 0,
            onClick: () => {
              const id = knownCityNameToId(p.v);
              if (id) setMapPick({ cityId: id, name: p.v });
              else pushSystem(`키워드: ${p.v}`);
            }
          },
          `[${p.v}]`
        );
      }
      return React.createElement(React.Fragment, { key: `tx-${idx}` }, p.v);
    });
  }

  function TypewriterText({ text, enabled }) {
    const [n, setN] = React.useState(enabled ? 0 : 999999);
    React.useEffect(() => {
      if (!enabled) {
        setN(999999);
        return;
      }
      const full = String(text || '');
      let raf = 0;
      let last = performance.now();
      let count = 0;
      const speed = 42; // chars/sec
      setN(0);
      function tick(now) {
        const dt = (now - last) / 1000;
        last = now;
        count = Math.min(full.length, count + Math.max(1, Math.floor(dt * speed)));
        setN(count);
        if (count < full.length) raf = requestAnimationFrame(tick);
      }
      raf = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(raf);
    }, [enabled, text]);
    const out = String(text || '').slice(0, n);
    return React.createElement('span', null, renderWithKeywords(out));
  }

  function AsciiMap() {
    const w = 46;
    const h = 15;
    const grid = Array.from({ length: h }, () => Array.from({ length: w }, () => ' '));
    const starts = new Map(); // key `${x},${y}` => { cityId, label }

    const pos = {
      xu_chang: { x: 4, y: 2 },
      jian_ye: { x: 28, y: 2 },
      xiang_yang: { x: 15, y: 7 },
      cheng_du: { x: 28, y: 11 }
    };

    function putLabel(cityId, label, x, y) {
      const t = `[${label}]`;
      starts.set(`${x},${y}`, { cityId, label: t });
      for (let i = 0; i < t.length && x + i < w; i++) grid[y][x + i] = t[i];
    }

    function drawLine(ax, ay, bx, by) {
      let x = ax;
      let y = ay;
      while (x !== bx) {
        x += x < bx ? 1 : -1;
        if (grid[y][x] === ' ') grid[y][x] = '-';
      }
      while (y !== by) {
        y += y < by ? 1 : -1;
        if (grid[y][x] === ' ') grid[y][x] = '|';
      }
    }

    const centerId = me?.city_id;
    const all = [];
    if (centerId && pos[centerId]) all.push({ id: centerId, name: me?.city_name || centerId });
    (nearby || []).forEach((n) => all.push({ id: n.city_id, name: n.name_kr }));
    const uniq = new Map();
    all.forEach((c) => {
      if (c?.id && !uniq.has(c.id)) uniq.set(c.id, c);
    });
    const list = Array.from(uniq.values()).filter((c) => pos[c.id]);

    if (centerId && pos[centerId]) {
      const a = pos[centerId];
      list.forEach((c) => {
        if (c.id === centerId) return;
        const b = pos[c.id];
        if (!b) return;
        drawLine(a.x + 2, a.y, b.x + 2, b.y);
      });
    }

    list.forEach((c) => {
      const p = pos[c.id];
      const label = c.name || c.id;
      putLabel(c.id, label, p.x, p.y);
    });

    const lines = [];
    for (let y = 0; y < h; y++) {
      const row = [];
      for (let x = 0; x < w; x++) {
        const key = `${x},${y}`;
        const st = starts.get(key);
        if (st) {
          row.push(
            React.createElement(
              'span',
              {
                key: `c-${key}`,
                className: 'kw',
                role: 'button',
                tabIndex: 0,
                onClick: () => setMapPick({ cityId: st.cityId, name: String(st.label).replace(/^\[|\]$/g, '') })
              },
              st.label
            )
          );
          x += st.label.length - 1;
          continue;
        }
        row.push(React.createElement(React.Fragment, { key: `t-${key}` }, grid[y][x]));
      }
      lines.push(React.createElement('div', { key: `l-${y}` }, row));
    }

    return React.createElement(
      'div',
      null,
      React.createElement('div', { className: 'hint', style: { marginBottom: 8 } }, '지도: 도시를 클릭하면 행동 메뉴가 뜹니다. (Tab으로 중앙 화면 전환)'),
      React.createElement('div', { className: 'ascii text-glow' }, lines),
      mapPick
        ? React.createElement(
            'div',
            { className: 'popover', style: { marginTop: 10 } },
            React.createElement('div', { className: 'text-glow', style: { fontSize: 18, marginBottom: 8 } }, `선택: ${mapPick.name}`),
            React.createElement(
              'div',
              { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
              React.createElement(
                'button',
                { className: 'retro-btn pill', onClick: () => uiSend(`city ${mapPick.cityId}`) },
                '정보(city)'
              ),
              React.createElement(
                'button',
                { className: 'retro-btn pill', onClick: () => uiSend(`spy ${mapPick.cityId}`) },
                '정찰(spy)'
              ),
              React.createElement(
                'button',
                { className: 'retro-btn pill', onClick: () => uiSend(`travel ${mapPick.cityId}`) },
                '이동(travel)'
              ),
              React.createElement(
                'button',
                { className: 'retro-btn pill secondary', onClick: () => setMapPick(null) },
                '닫기'
              )
            )
          )
        : null
    );
  }

  function StatusPane() {
    const ap = typeof me?.ap === 'number' ? me.ap : 0;
    const merit = typeof me?.merit === 'number' ? me.merit : 0;
    const hs = me?.hidden_stats && typeof me.hidden_stats === 'object' ? me.hidden_stats : {};
    const suspicion = typeof hs?.suspicion === 'number' ? hs.suspicion : 0;
    const custody = String(me?.custody_status || 'free');
    return React.createElement(
      'div',
      null,
      React.createElement('div', { style: { fontSize: 20, lineHeight: 1.25 } }, React.createElement('span', { className: 'text-glow' }, me?.name_kr || '장수(미생성)')),
      React.createElement('div', { className: 'hint', style: { marginTop: 6 } }, `신분: ${me?.identity || 'Ronin'}  |  세력: ${me?.force_id || '-'}`),
      React.createElement('div', { className: 'hint' }, `도시: ${me?.city_name || '-'}`),
      custody !== 'free'
        ? React.createElement('div', { className: 'banner', style: { marginTop: 10 } }, `구금 상태: ${custody} (breakout 또는 end_turn)`)
        : null,
      React.createElement('div', { style: { marginTop: 10, fontSize: 18 } }, `의심  ${bar(suspicion, 100)}  ${suspicion}/100`),
      React.createElement('div', { style: { marginTop: 12, fontSize: 18 } }, `AP  ${bar(ap, 100)}  ${ap}/100`),
      React.createElement('div', { style: { marginTop: 6, fontSize: 18 } }, `공적 ${String(merit).padStart(4, ' ')}  |  품관 ${me?.rank ?? '-'}`),
      React.createElement('div', { style: { marginTop: 12 } }, React.createElement('span', { className: 'hint' }, '쉬운 진행: next -> auto_day'))
    );
  }

  function MainPane() {
    const tabBtn = (id, label) =>
      React.createElement(
        'button',
        {
          className: 'tab',
          role: 'tab',
          'aria-selected': mainTab === id ? 'true' : 'false',
          onClick: () => setMainTab(id)
        },
        label
      );

    let content = null;
    if (mainTab === 'map') content = React.createElement(AsciiMap);
    else if (mainTab === 'region') {
      content = React.createElement(
        'div',
        null,
        React.createElement('div', { className: 'hint', style: { marginBottom: 10 } }, '근거리 도시 목록 (클릭으로 이동/정찰):'),
        React.createElement(
          'div',
          { style: { display: 'grid', gap: 8 } },
          (nearby || []).map((c) =>
            React.createElement(
              'div',
              { key: c.city_id, className: 'feed-item' },
              React.createElement('div', { className: 'text-glow' }, `${c.name_kr} (${c.city_id})`),
              React.createElement('div', { className: 'hint', style: { marginTop: 4 } }, `거리:${c.distance}  지형:${c.terrain}  소유:${c.owner_force_id || '-'}`),
              React.createElement(
                'div',
                { style: { marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' } },
                React.createElement('button', { className: 'retro-btn pill', onClick: () => uiSend(`travel ${c.city_id}`) }, '이동'),
                React.createElement('button', { className: 'retro-btn pill', onClick: () => uiSend(`spy ${c.city_id}`) }, '정찰'),
                React.createElement('button', { className: 'retro-btn pill secondary', onClick: () => uiSend(`city ${c.city_id}`) }, '정보')
              )
            )
          )
        )
      );
    } else {
      content = React.createElement(
        'div',
        null,
        React.createElement('div', { className: 'hint', style: { marginBottom: 10 } }, '열전/서사(요약):'),
        React.createElement(
          'div',
          { style: { display: 'grid', gap: 10 } },
          (feed || []).slice(-12).map((it, idx, arr) => {
            const isLatest = it.id === arr[arr.length - 1]?.id;
            const text = it.narration || it.event_data?.summary || it.event_type;
            return React.createElement(
              'div',
              { key: it.id, className: 'feed-item' },
              React.createElement('div', { className: 'feed-time' }, new Date(it.created_at).toLocaleString()),
              React.createElement('div', { className: 'feed-text text-glow' }, React.createElement(TypewriterText, { text, enabled: isLatest }))
            );
          })
        )
      );
    }

    return React.createElement(
      'div',
      { style: { height: '100%', display: 'flex', flexDirection: 'column' } },
      React.createElement(
        'div',
        { className: 'pane-header' },
        React.createElement('div', { className: 'pane-title' }, 'MAIN VIEW'),
        React.createElement('div', { className: 'tabs', role: 'tablist' }, tabBtn('map', '지도'), tabBtn('region', '지역'), tabBtn('bio', '열전'))
      ),
      React.createElement('div', { className: 'pane-body' }, content)
    );
  }

  function LogPane() {
    const items = (feed || [])
      .slice(-80)
      .filter((it) => it && !isSystemFeed(it))
      .map((it) => ({ ...it, _text: feedRenderText(it) }))
      .filter((it) => String(it._text || '').trim())
      .slice(-40);
    return React.createElement(
      'div',
      { style: { height: '100%', display: 'flex', flexDirection: 'column' } },
      React.createElement(
        'div',
        { className: 'pane-header' },
        React.createElement('div', { className: 'pane-title' }, 'LOG & CHAT'),
        React.createElement(
          'div',
          { style: { display: 'flex', gap: 8 } },
          React.createElement('button', { className: 'retro-btn pill secondary', onClick: () => uiSend('story') }, 'story'),
          React.createElement('button', { className: 'retro-btn pill secondary', onClick: () => refreshUI() }, 'refresh')
        )
      ),
      React.createElement(
        'div',
        { className: 'pane-body' },
        items.length
          ? items
              .slice()
              .reverse()
              .map((it) =>
                React.createElement(
                  'div',
                  {
                    key: it.id,
                    className: `feed-item ${feedKind(it)}`,
                    role: it?.event_type === 'loot' ? 'button' : undefined,
                    tabIndex: it?.event_type === 'loot' ? 0 : undefined,
                    onClick: it?.event_type === 'loot' ? () => openInventory() : undefined
                  },
                  React.createElement('div', { className: 'feed-time' }, new Date(it.created_at).toLocaleString()),
                  React.createElement('div', { className: 'feed-text' }, renderWithKeywords(it._text))
                )
              )
          : React.createElement('div', { className: 'hint' }, '로그가 아직 없습니다.')
      )
    );
  }

  React.useEffect(() => {
    if (mode !== 'ui') return;
    const onKey = (e) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        setMainTab((prev) => (prev === 'map' ? 'region' : prev === 'region' ? 'bio' : 'map'));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode]);

  React.useEffect(() => {
    if (dashTab !== 'play') return;
    const el = logRef.current;
    if (!el) return;
    // Keep the latest narrative in view (prototype-like).
    el.scrollTop = el.scrollHeight;
  }, [dashTab, feed]);

  if (mode === 'terminal') {
    return React.createElement(
      'div',
      { style: { padding: 16, background: '#05070f', minHeight: '100vh' } },
      React.createElement(
        'div',
        { style: { marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center', color: '#f7f3d7', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace' } },
        React.createElement('div', null, '터미널 모드'),
        React.createElement(
          'button',
          {
            onClick: () => {
              safeLocalStorageSet('uiMode', 'ui');
              setMode('ui');
            },
            style: { background: 'rgba(255,255,255,0.08)', color: '#f7f3d7', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 10, padding: '6px 10px', cursor: 'pointer' }
          },
          'UI'
        )
      ),
      React.createElement('div', { ref: termRef })
    );
  }

  const slashHints = [
    { k: '/e', v: 'end_turn' },
    { k: '/n', v: 'next' },
    { k: '/a', v: 'auto_day' },
    { k: '/s', v: 'status' },
    { k: '/m', v: 'map_nearby' },
    { k: '/t <도시>', v: 'travel <도시>' },
    { k: '/spy <도시>', v: 'spy <도시>' }
  ];

  function submitInput(raw) {
    const normalized = normalizeCmd(raw);
    const nl = tryNaturalLanguageToCommand(normalized);
    const toSend = nl || normalized;
    setInputValue('');
    setStoryChoices([]);
    uiSend(toSend);
  }

  function seasonByMonth(month) {
    const m = Number(month || 0);
    if (m === 12 || m === 1 || m === 2) return 'Winter';
    if (m >= 3 && m <= 5) return 'Spring';
    if (m >= 6 && m <= 8) return 'Summer';
    if (m >= 9 && m <= 11) return 'Autumn';
    return '-';
  }

  function cmdVerb(cmd) {
    const s = String(cmd || '').trim();
    if (!s) return '';
    return s.split(/\s+/)[0];
  }

  function minApForVerb(verb) {
    if (verb === 'cultivate') return 20;
    if (verb === 'train') return 20;
    if (verb === 'search') return 20;
    if (verb === 'spy') return 25;
    if (verb === 'employ') return 30;
    if (verb === 'socialize') return 10;
    if (verb === 'travel') return 10;
    if (verb === 'battle_start') return 10;
    if (verb === 'skirmish') return 25;
    return 0;
  }

  function cmdLabel(verb, idx) {
    const n = String(idx + 1).padStart(1, ' ');
    const map = {
      cultivate: 'WORK',
      train: 'TRAIN',
      socialize: 'SOCIAL',
      search: 'SEARCH',
      rest: 'REST',
      patrol: 'CALM',
      travel: 'MOVE',
      spy: 'SPY',
      employ: 'EMPLOY',
      shop: 'SHOP',
      inventory: 'INV',
      chronicle: 'LOG',
      recruit_rumor: 'RUMOR',
      buy: 'BUY',
      use: 'USE',
      next: 'NEXT',
      end_turn: 'TURN',
      auto_day: 'AUTO',
      story: 'STORY',
      skirmish: 'FIGHT',
      breakout: 'ESC',
      scout_accept: 'SCOUT',
      scout_decline: 'SCOUT'
    };
    const tag = map[verb] || verb.toUpperCase();
    return `[${n}] ${tag}`;
  }

  function topNavBtn(label, active, onClick) {
    return React.createElement(
      'button',
      { className: `nav-btn ${active ? 'active' : ''}`, onClick },
      label
    );
  }

  function costText({ ap, gold }) {
    const parts = [];
    if (typeof ap === 'number' && ap > 0) parts.push(`AP -${ap}`);
    if (typeof gold === 'number' && gold > 0) parts.push(`GOLD -${gold}`);
    return parts.join(' | ');
  }

  function cmdDesc(verb, why) {
    if (why) return String(why);
    if (verb === 'cultivate') return '현장 지원(보급/민심) +';
    if (verb === 'train') return '훈련/공적 +';
    if (verb === 'socialize') return '인맥(관시) +';
    if (verb === 'search') return '인재/금 발견';
    if (verb === 'rest') return 'AP 회복(짧은 휴식)';
    if (verb === 'spy') return '인접 도시 정보';
    if (verb === 'travel') return '인접 도시 이동';
    if (verb === 'employ') return '재야 장수 등용';
    if (verb === 'shop') return '아이템 확인/구매';
    if (verb === 'recruit_rumor') return '소문(다음 탐색 인재 조우 +)';
    if (verb === 'next') return '추천 갱신';
    if (verb === 'end_turn') return '턴 종료(하루 진행 + AP/제한 리셋)';
    if (verb === 'auto_day') return '자동 진행';
    if (verb === 'story') return '목표/임무';
    return '';
  }

  function portraitArtForOfficer(me) {
    const name = String(me?.name_kr || '');
    // One custom portrait to start with: Wei Yan (위연)
    if (name.includes('위연')) {
      return [
        '................................',
        '.............######.............',
        '..........############..........',
        '........################........',
        '.......#####..######..#####.....',
        '......####..............####....',
        '.....####..###......###..####...',
        '.....####..###......###..####...',
        '.....####................####...',
        '......####......####......####..',
        '.......####.....####.....####...',
        '........####...######...####....',
        '.........####..######..####.....',
        '..........####........####......',
        '...........####......####.......',
        '............####....####........',
        '.............####..####.........',
        '..............########..........',
        '...............######...........',
        '................####............',
        '...............######...........',
        '.............##########.........',
        '...........####......####.......',
        '..........###..위..연..###......'
      ].join('\\n');
    }
    // Default: monogram
    const ch = (name || '?').slice(0, 1);
    return [
      '      ____      ',
      '   .-"    "-.   ',
      '  /          \\\\  ',
      ` |     ${ch}      | `,
      ' |            | ',
      ' |            | ',
      '  \\\\          /  ',
      "   '-.____.-'   "
    ].join('\\n');
  }

  return React.createElement(
    'div',
    {
      onPointerDownCapture: (e) => {
        const t = e.target;
        const tag = t?.tagName || 'unknown';
        const txt = typeof t?.innerText === 'string' ? t.innerText.slice(0, 24).replace(/\s+/g, ' ') : '';
        setLastPointer(`${tag}${txt ? `(${txt})` : ''} @${Math.round(e.clientX)},${Math.round(e.clientY)}`);
      },
      className: 'crt-root'
    },
    showOfficerPicker
      ? React.createElement(
          'div',
          {
            style: {
              position: 'fixed',
              inset: 0,
              zIndex: 500,
              background: 'rgba(0,0,0,0.78)',
              padding: 16,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            },
            onClick: () => setShowOfficerPicker(false)
          },
          React.createElement(
            'div',
            {
              className: 'popover',
              style: { width: 'min(980px, 96vw)', maxHeight: '88vh', overflow: 'auto' },
              onClick: (e) => e.stopPropagation()
            },
            React.createElement('div', { className: 'text-glow', style: { fontSize: 22, marginBottom: 10 } }, '장수 선택'),
            React.createElement(
              'div',
              { className: 'hint', style: { marginBottom: 10 } },
              '이 게임은 군주가 아니라 장수 1인 시점으로 진행합니다. 먼저 플레이할 장수를 선택하세요.'
            ),
            React.createElement(
              'div',
              { style: { display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 } },
              React.createElement('input', {
                className: 'input',
                style: { flex: '1 1 240px' },
                value: pickerQuery,
                onChange: (e) => setPickerQuery(e.target.value),
                placeholder: '검색 (예: 조운, 장료...)'
              }),
              React.createElement(
                'button',
                { className: 'retro-btn secondary', onClick: () => loadAvailableOfficers(pickerQuery) },
                pickerLoading ? 'loading...' : 'search'
              )
            ),
            React.createElement(
              'div',
              { style: { display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 } },
              React.createElement('input', {
                className: 'input',
                style: { flex: '1 1 240px' },
                value: pickerUsername,
                onChange: (e) => setPickerUsername(e.target.value),
                placeholder: '닉네임 (선택, 비워두면 장수 이름 사용)'
              }),
              React.createElement(
                'button',
                {
                  className: 'retro-btn',
                  onClick: async () => {
                    // Fallback: start as anonymous ronin (not historical).
                    const u = pickerUsername.trim() || `재야${Math.floor(Math.random() * 1000)}`;
                    const r = await bootstrapPlayer({ username: u });
                    if (r.ok) {
                      pushSystem(`플레이어 생성 완료: ${String(r.id).slice(0, 8)}...`);
                      setShowOfficerPicker(false);
                      await refreshUI();
                    } else setUiError(`bootstrap 실패: ${r.error}`);
                  }
                },
                '재야로 시작'
              ),
              React.createElement(
                'button',
                {
                  className: 'retro-btn secondary',
                  onClick: () => setShowOfficerPicker(false)
                },
                '닫기'
              )
            ),
            React.createElement(
              'div',
              { style: { display: 'grid', gap: 10 } },
              (pickerItems || []).length
                ? (pickerItems || []).map((o) =>
                    React.createElement(
                      'div',
                      { key: o.id, className: 'feed-item' },
                      React.createElement(
                        'div',
                        { style: { display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'baseline' } },
                        React.createElement('div', { className: 'feed-text text-glow', style: { fontSize: 20 } }, o.name_kr),
                        React.createElement(
                          'div',
                          { className: 'hint' },
                          `${o.city_name || o.city_id} | ${String(o.force_id || '').toUpperCase()}`
                        )
                      ),
                      React.createElement(
                        'div',
                        { className: 'hint', style: { marginTop: 6 } },
                        `LDR:${o.ldr} WAR:${o.war} INT:${o.int_stat} POL:${o.pol} CHR:${o.chr}`
                      ),
                      React.createElement(
                        'div',
                        { style: { marginTop: 10, display: 'flex', gap: 10, flexWrap: 'wrap' } },
                        React.createElement(
                          'button',
                          {
                            className: 'retro-btn',
                            onClick: async () => {
                              const u = pickerUsername.trim() || o.name_kr;
                              const r = await bootstrapPlayer({ officerId: o.id, username: u });
                              if (r.ok) {
                                pushSystem(`장수 선택 완료: ${o.name_kr} (${String(r.id).slice(0, 8)}...)`);
                                setShowOfficerPicker(false);
                                await refreshUI();
                              } else setUiError(`bootstrap 실패: ${r.error}`);
                            }
                          },
                          '선택'
                        ),
                        React.createElement(
                          'button',
                          {
                            className: 'retro-btn secondary',
                            onClick: () => {
                              pushSystem(`선택 후보: ${o.name_kr} / ${o.city_name || o.city_id}`);
                            }
                          },
                          '정보'
                        )
                      )
                    )
                  )
                : React.createElement('div', { className: 'hint' }, pickerLoading ? '장수 목록을 불러오는 중...' : '표시할 장수가 없습니다.')
            )
          )
        )
      : null,
    React.createElement('div', { className: 'crt-overlay', 'aria-hidden': 'true' }),
    React.createElement('div', { className: 'crt-scanline', 'aria-hidden': 'true' }),
    React.createElement(
      'div',
      { className: 'topbar' },
      React.createElement(
        'div',
        null,
        React.createElement('div', { className: 'title text-glow' }, 'RED CLIFF TERMINAL'),
        debug
          ? React.createElement(
              React.Fragment,
              null,
              React.createElement('div', { className: 'sub' }, playerId ? `playerId: ${String(playerId).slice(0, 8)}...  |  ${me?.city_name || '-'}` : 'playerId: (없음)'),
              React.createElement('div', { className: 'sub' }, `last: ${lastAction || '-'} ${lastPointer ? `| ${lastPointer}` : ''}`)
            )
          : React.createElement('div', { className: 'sub' }, playerId ? `${me?.name_kr || 'Officer'} · ${me?.city_name || '-'} · AP ${me?.ap ?? 0}/100` : 'Start to play')
      ),
      React.createElement(
        'div',
        { style: { display: 'flex', gap: 8, alignItems: 'center' } },
        debug
          ? React.createElement(
              'div',
              { style: { display: 'flex', gap: 6, alignItems: 'center', marginRight: 10 } },
              React.createElement(
                'button',
                { className: 'tab', role: 'tab', 'aria-selected': dashTab === 'design' ? 'true' : 'false', onClick: () => setDashTab('design') },
                'GAME DESIGN'
              ),
              React.createElement(
                'button',
                { className: 'tab', role: 'tab', 'aria-selected': dashTab === 'play' ? 'true' : 'false', onClick: () => setDashTab('play') },
                'PLAY'
              ),
              React.createElement(
                'button',
                { className: 'tab', role: 'tab', 'aria-selected': dashTab === 'db' ? 'true' : 'false', onClick: () => setDashTab('db') },
                'DB SCHEMA'
              ),
              React.createElement(
                'button',
                { className: 'tab', role: 'tab', 'aria-selected': dashTab === 'arch' ? 'true' : 'false', onClick: () => setDashTab('arch') },
                'ARCH'
              )
            )
          : null,
        React.createElement(
          'button',
          {
            onPointerDown: (e) => {
              e.preventDefault();
              e.stopPropagation();
              uiSend(playerId ? 'end_turn' : 'bootstrap');
            },
            onClick: () => uiSend(playerId ? 'end_turn' : 'bootstrap'),
            className: 'retro-btn'
          },
          playerId ? '턴 종료' : 'start'
        ),
        React.createElement(
          'button',
          {
            onPointerDown: (e) => {
              e.preventDefault();
              e.stopPropagation();
              uiSend('story');
            },
            onClick: () => uiSend('story'),
            className: 'retro-btn secondary'
          },
          'story'
        ),
        playerId
          ? React.createElement(
              'button',
              {
                onPointerDown: (e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  uiSend('next');
                },
                onClick: () => uiSend('next'),
                className: 'retro-btn secondary'
              },
              '추천'
            )
          : null,
        playerId
          ? React.createElement(
              'button',
              {
                onPointerDown: (e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  safeLocalStorageSet('playerId', '');
                  setPlayerId('');
                  setMe(null);
                  setFeed([]);
                  setActions([]);
                  setNearby([]);
                  setShowOfficerPicker(true);
                },
                onClick: () => {
                  safeLocalStorageSet('playerId', '');
                  setPlayerId('');
                  setMe(null);
                  setFeed([]);
                  setActions([]);
                  setNearby([]);
                  setShowOfficerPicker(true);
                },
                className: 'retro-btn secondary'
              },
              'change'
            )
          : null,
        debug
          ? React.createElement(
              'button',
              {
                onPointerDown: (e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  safeLocalStorageSet('uiMode', 'terminal');
                  setMode('terminal');
                },
                onClick: () => {
                  safeLocalStorageSet('uiMode', 'terminal');
                  setMode('terminal');
                },
                className: 'retro-btn secondary'
              },
              '터미널'
            )
          : null
      )
    ),
    uiError ? React.createElement('div', { className: 'banner' }, uiError) : null,
    localNotes && localNotes.length
      ? React.createElement(
          'div',
          { className: 'note-tray', role: 'status', 'aria-live': 'polite' },
          localNotes.map((n) =>
            React.createElement(
              'div',
              { key: n.id, className: 'note-chip' },
              React.createElement('div', { className: 'note-time' }, new Date(n.created_at).toLocaleTimeString()),
              React.createElement('div', { className: 'note-msg' }, n.msg)
            )
          )
        )
      : null,
          dashTab === 'play'
      ? React.createElement(
          React.Fragment,
          null,
          React.createElement(
            'div',
            { className: 'play-shell' },
            React.createElement(
              'div',
              { className: 'pane' },
              React.createElement('div', { className: 'pane-header' }, React.createElement('div', { className: 'pane-title' }, 'DASHBOARD')),
              React.createElement(
                'div',
                { className: 'pane-body' },
                React.createElement(
                  'div',
                  { className: 'card card-header' },
                  React.createElement(
                    'button',
                    { className: 'avatar-btn', onClick: () => setShowPortraitModal(true), title: '초상/프롬프트' },
                    me?.portrait?.status === 'done' && me?.portrait?.url
                      ? React.createElement('img', {
                          className: 'avatar avatar-img',
                          alt: 'portrait',
                          src: `${me.portrait.url}?t=${encodeURIComponent(String(me.portrait.updated_at || ''))}`
                        })
                      : React.createElement(PixelPortrait, {
                          seedText: `${me?.id || ''}|${me?.name_kr || ''}`,
                          size: 56,
                          className: 'avatar avatar-pixel'
                        })
                  ),
                  React.createElement(
                    'div',
                    { className: 'who' },
                    React.createElement('div', { className: 'who-name' }, me?.name_kr || '장수'),
                    React.createElement(
                      'div',
                      { className: 'who-meta' },
                      `${me?.city_name || '-'} · ${String(me?.force_id || 'ronin').toUpperCase()} · Rank ${me?.rank ?? '-'}`
                    ),
                    React.createElement(
                      'div',
                      { className: 'who-tags' },
                      React.createElement('span', { className: 'tag tag-ok' }, `AP ${me?.ap ?? 0}/100`),
                      React.createElement('span', { className: 'tag' }, `MERIT ${me?.merit ?? 0}`),
                      React.createElement('span', { className: 'tag' }, `FAME ${me?.fame ?? 0}`),
                      React.createElement('span', { className: 'tag' }, `GOLD ${String(me?.gold ?? 0).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ',')}`)
                    )
                  )
                ),
                React.createElement(
                  'div',
                  { className: 'card' },
                  React.createElement('div', { className: 'card-title' }, 'STATS'),
                  React.createElement(RadarMini, {
                    stats: { LDR: me?.ldr ?? 0, WAR: me?.war ?? 0, INT: me?.int_stat ?? 0, POL: me?.pol ?? 0, CHR: me?.chr ?? 0 }
                  }),
                  React.createElement(
                    'div',
                    { className: 'stat-row' },
                    React.createElement('span', { className: 'stat' }, `LDR ${me?.ldr ?? '-'}`),
                    React.createElement('span', { className: 'stat' }, `WAR ${me?.war ?? '-'}`),
                    React.createElement('span', { className: 'stat' }, `INT ${me?.int_stat ?? '-'}`),
                    React.createElement('span', { className: 'stat' }, `POL ${me?.pol ?? '-'}`),
                    React.createElement('span', { className: 'stat' }, `CHR ${me?.chr ?? '-'}`)
                  )
                ),
                React.createElement(
                  'div',
                  { className: 'card card-compact' },
                  React.createElement('div', { className: 'card-title' }, 'SHORTCUTS'),
                  React.createElement(
                    'div',
                    { className: 'mini-actions' },
                    React.createElement('button', { className: 'btn-soft', onClick: () => uiSend('status') }, 'Status'),
                    React.createElement('button', { className: 'btn-soft', onClick: () => uiSend('skills') }, 'Skills'),
                    React.createElement('button', { className: 'btn-soft', onClick: () => openInventory() }, 'Inventory'),
                    React.createElement('button', { className: 'btn-soft', onClick: () => openShop() }, 'Shop'),
                    React.createElement('button', { className: 'btn-soft', onClick: () => openChronicle() }, 'Chronicle'),
                    React.createElement('button', { className: 'btn-soft', onClick: () => setShowMapOverlay(true) }, 'Map'),
                    React.createElement('button', { className: 'btn-soft', onClick: () => openEmployCandidates() }, 'Employ')
                  )
                ),
                React.createElement(
                  'div',
                  { className: 'card' },
                  React.createElement('div', { className: 'card-title' }, 'AUTO-BATTLER (1v1 · 7x4)'),
                  React.createElement(
                    'div',
                    { className: 'hint', style: { marginBottom: 8 } },
                    matchId ? `matchId: ${String(matchId).slice(0, 8)}...` : '매치를 생성하면 라운드가 자동 진행됩니다.'
                  ),
                  React.createElement(
                    'div',
                    { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 } },
                    React.createElement(
                      'button',
                      { className: 'retro-btn pill', disabled: matchBusy, onClick: () => createMatch() },
                      matchBusy ? '...' : matchId ? 'NEW MATCH' : 'CREATE MATCH'
                    ),
                    matchId
                      ? React.createElement(
                          'button',
                          {
                            className: 'retro-btn pill secondary',
                            disabled: matchBusy,
                            onClick: () => {
                              safeLocalStorageSet('matchId', '');
                              setMatchId('');
                              setMatchState(null);
                              setMatchReplay(null);
                              setMatchSelectedUnitId('');
                            }
                          },
                          'CLEAR'
                        )
                      : null,
                    matchId
                      ? React.createElement('button', { className: 'retro-btn pill secondary', disabled: matchBusy, onClick: () => fetchMatchState() }, 'REFRESH')
                      : null
                  ),
                  (() => {
                    if (!matchId || !matchState?.ok) return null;
                    const ms = matchState;
                    const round = ms.round || null;
                    const phase = String(round?.phase || '-');
                    const endsAt = round?.ends_at ? new Date(round.ends_at).getTime() : 0;
                    const left = endsAt ? Math.max(0, Math.ceil((endsAt - Date.now()) / 1000)) : null;
                    const my = ms.me || {};
                    const opp = ms.opponent || {};
                    const storyEv = my.storyEvent || null;
                    const storyPending = !!(storyEv && Array.isArray(storyEv.choices) && storyEv.choices.length);
                    const shop = my.shop || {};
                    const slots = Array.isArray(shop.slots) ? shop.slots : [];

                    const benchObj = my.bench && typeof my.bench === 'object' ? my.bench : {};
                    const benchUnits = Array.isArray(benchObj.units)
                      ? benchObj.units
                      : Array.isArray(benchObj.slots)
                        ? benchObj.slots.filter(Boolean)
                        : [];

                    const boardObj = my.board && typeof my.board === 'object' ? my.board : {};
                    const boardUnits = Array.isArray(boardObj.units) ? boardObj.units : [];
                    const unitAt = (x, y) => boardUnits.find((u) => u && Number(u.x) === x && Number(u.y) === y) || null;

                    const grid = [];
                    for (let y = 0; y < 4; y += 1) {
                      const row = [];
                      for (let x = 0; x < 7; x += 1) {
                        const u = unitAt(x, y);
                        const label = u ? String(u.unitId || '').slice(0, 8) : '';
                        row.push(
                          React.createElement(
                            'button',
                            {
                              key: `cell-${x}-${y}`,
                              className: 'btn-soft',
                              style: { padding: '8px 6px', textAlign: 'center', minHeight: 34, opacity: matchBusy ? 0.7 : 1 },
                              disabled: matchBusy || storyPending,
                              onClick: () => {
                                if (u && u.instanceId) matchRemove(u.instanceId);
                                else matchPlace(x, y);
                              },
                              title: u
                                ? `REMOVE ${u.unitId} (${String(u.instanceId || '').slice(0, 8)}...)`
                                : matchSelectedUnitId
                                  ? `PLACE ${matchSelectedUnitId}`
                                  : 'EMPTY'
                            },
                            label || '·'
                          )
                        );
                      }
                      grid.push(React.createElement('div', { key: `row-${y}`, style: { display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 6 } }, row));
                    }

                    const replayRound = phase === 'prep' ? Math.max(1, asNum(round?.round, 1) - 1) : asNum(round?.round, 1);

                    return React.createElement(
                      'div',
                      null,
                      storyPending
                        ? React.createElement(
                            'div',
                            { className: 'feed-item', style: { marginBottom: 10 } },
                            React.createElement('div', { className: 'feed-text text-glow' }, storyEv.title || 'STORY'),
                            React.createElement('div', { className: 'hint', style: { marginTop: 6, whiteSpace: 'pre-wrap' } }, storyEv.body || ''),
                            React.createElement(
                              'div',
                              { style: { marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' } },
                              (storyEv.choices || []).slice(0, 3).map((c) =>
                                React.createElement(
                                  'button',
                                  {
                                    key: `sev-${c.id}`,
                                    className: 'retro-btn pill',
                                    disabled: matchBusy || phase !== 'prep',
                                    onClick: () => matchStoryChoice(c.id)
                                  },
                                  String(c.label || c.id || 'choice')
                                )
                              )
                            )
                          )
                        : null,
                      React.createElement(
                        'div',
                        { className: 'hint', style: { marginBottom: 8 } },
                        `R${round?.round ?? '-'} · ${phase.toUpperCase()}${left != null ? ` · ${left}s` : ''} · HP ${my.hp ?? '-'} vs ${opp.hp ?? '-'} · GOLD ${my.gold ?? '-'}`
                      ),
                      React.createElement('div', { className: 'hint', style: { marginBottom: 8 } }, `상점: ${shop.locked ? 'LOCKED' : 'OPEN'} · rolls ${shop.rollsUsed ?? 0}`),
                      React.createElement(
                        'div',
                        { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 } },
                        React.createElement('button', { className: 'retro-btn pill secondary', disabled: matchBusy || phase !== 'prep' || storyPending, onClick: () => matchReroll() }, 'REROLL'),
                        React.createElement(
                          'button',
                          { className: 'retro-btn pill secondary', disabled: matchBusy || storyPending, onClick: () => matchLock(!shop.locked) },
                          shop.locked ? 'UNLOCK' : 'LOCK'
                        ),
                        React.createElement(
                          'button',
                          { className: 'retro-btn pill secondary', disabled: matchBusy, onClick: () => loadReplay(replayRound) },
                          `REPLAY R${replayRound}`
                        )
                      ),
                      React.createElement(
                        'div',
                        { style: { display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8, marginBottom: 10 } },
                        slots.map((s, i) => {
                          const empty = !s || !s.unitId;
                          return React.createElement(
                            'button',
                            {
                              key: `shop-${i}`,
                              className: 'btn-soft',
                              disabled: matchBusy || phase !== 'prep' || empty || storyPending,
                              onClick: () => matchBuy(i)
                            },
                            empty ? '—' : `${String(s.unitId).slice(0, 8)} · ${s.cost}G`
                          );
                        })
                      ),
                      React.createElement('div', { className: 'hint', style: { marginBottom: 6 } }, `벤치(${benchUnits.length}/${benchObj.cap ?? 8}): 클릭해서 배치 선택`),
                      React.createElement(
                        'div',
                        { style: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginBottom: 10 } },
                        benchUnits.length
                          ? benchUnits.map((u) => {
                              const id = String(u?.instanceId || '').trim();
                              const active = id && id === matchSelectedUnitId;
                              return React.createElement(
                                'button',
                                {
                                  key: `bench-${id}`,
                                  className: 'btn-soft',
                                  style: { outline: active ? '2px solid rgba(54,243,177,0.65)' : 'none' },
                                  disabled: matchBusy || !id || phase !== 'prep' || storyPending,
                                  onClick: () => setMatchSelectedUnitId(active ? '' : id),
                                  title: id
                                },
                                `${String(u?.unitId || '').slice(0, 10)}`
                              );
                            })
                          : [React.createElement('div', { key: 'bench-empty', className: 'hint' }, '빈 벤치')]
                      ),
                      React.createElement('div', { className: 'hint', style: { marginBottom: 6 } }, '보드(7x4): 빈칸 클릭=배치, 유닛 클릭=회수'),
                      React.createElement('div', { style: { display: 'grid', gap: 6, marginBottom: 10 } }, grid),
	                      matchReplay?.ok
	                        ? React.createElement(
	                            'div',
	                            { className: 'feed-item', style: { marginTop: 10 } },
	                            React.createElement('div', { className: 'feed-text text-glow' }, `REPLAY R${matchReplay.round}`),
                            React.createElement(
                              'div',
                              { className: 'hint', style: { marginTop: 6 } },
                              `events: ${(matchReplay.timeline || []).length} · winnerSeat: ${matchReplay.summary?.winnerSeat ?? '-'} · dmg: ${matchReplay.summary?.dmgToLoser ?? '-'}`
                            ),
                            React.createElement(
                              'pre',
                              { className: 'hint', style: { marginTop: 10, whiteSpace: 'pre-wrap' } },
                              (matchReplay.timeline || [])
                                .slice(0, 60)
                                .map((e) => {
                                  if (e.type === 'move') return `[${String(e.t).padStart(5)}] move ${e.src} (${e.from.x},${e.from.y})->(${e.to.x},${e.to.y})`;
                                  if (e.type === 'attack') return `[${String(e.t).padStart(5)}] atk ${e.src} -> ${e.dst} -${e.amount} (hp:${e.dstHp})`;
                                  if (e.type === 'death') return `[${String(e.t).padStart(5)}] death ${e.src}`;
                                  return `[${String(e.t).padStart(5)}] ${e.type}`;
                                })
                                .join('\\n')
                            )
	                          )
	                        : null
	                    );
	                  })()
	                )
	              )
	              ,
	              React.createElement(
	                'div',
	                { className: 'card', style: { marginTop: 12 } },
	                React.createElement('div', { className: 'card-title' }, 'BATTLE PROTO (4x3)'),
	                React.createElement(
	                  'div',
	                  { className: 'hint', style: { marginBottom: 8 } },
	                  '전투 재미/해석성/정체성만 검증하는 프로토. 4x6 보드(상단=적, 하단=아군). 클릭으로 배치.'
	                ),
	                React.createElement(
	                  'div',
	                  { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 } },
	                  React.createElement('input', {
	                    value: protoSeed,
	                    onChange: (e) => setProtoSeed(String(e.target.value || '')),
	                    placeholder: 'seed',
	                    style: { flex: '1 1 160px' }
	                  }),
	                  React.createElement('button', { className: 'retro-btn pill secondary', onClick: () => setProtoSeed(String(Date.now())) }, 'NEW SEED'),
	                  React.createElement('button', { className: 'retro-btn pill', disabled: protoBusy, onClick: () => protoSimulate() }, protoBusy ? 'SIM...' : 'SIMULATE'),
	                  React.createElement('button', { className: 'retro-btn pill secondary', onClick: () => setProtoGrid(Array(24).fill(null)) }, 'CLEAR')
	                ),
	                React.createElement(
	                  'div',
	                  { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 } },
	                  (protoRoster.length
	                    ? protoRoster
	                    : [
	                        { unitId: 'xuchu', name: '허저', role: 'juggernaut' },
	                        { unitId: 'zhangliao', name: '장료', role: 'diver' },
	                        { unitId: 'xunyu', name: '순욱', role: 'strategist' },
	                        { unitId: 'dianwei', name: '전위', role: 'tank' }
	                      ]
	                  ).map((u) =>
	                    React.createElement(
	                      'button',
	                      {
	                        key: `proto-unit-${u.unitId}`,
	                        className: `retro-btn pill ${protoSelected === u.unitId ? '' : 'secondary'}`,
	                        onClick: () => setProtoSelected(String(u.unitId || ''))
	                      },
	                      `${u.name} · ${String(u.role || '').toUpperCase()}`
	                    )
	                  )
	                ),
	                (() => {
	                  const cellSize = 44;
	                  const rows = [];
	                  for (let y = 0; y < 6; y += 1) {
	                    const row = [];
	                    for (let x = 0; x < 4; x += 1) {
	                      const idx = y * 4 + x;
	                      const unitId = protoGrid[idx];
	                      const isEnemy = y < 3;
	                      const label = unitId ? String(unitId).slice(0, 2).toUpperCase() : '';
	                      row.push(
	                        React.createElement(
	                          'button',
	                          {
	                            key: `proto-cell-${idx}`,
	                            className: 'btn-soft',
	                            onClick: () => {
	                              if (unitId) protoSetCell(idx, null);
	                              else protoSetCell(idx, protoSelected);
	                            },
	                            title: unitId ? `REMOVE ${unitId}` : `PLACE ${protoSelected}`,
	                            style: {
	                              width: cellSize,
	                              height: cellSize,
	                              borderRadius: 10,
	                              border: '1px solid rgba(143,255,205,0.16)',
	                              background: unitId
	                                ? isEnemy
	                                  ? 'rgba(255,90,90,0.10)'
	                                  : 'rgba(54,243,177,0.10)'
	                                : 'rgba(0,0,0,0.12)',
	                              color: 'rgba(231,255,242,0.92)',
	                              fontFamily: 'VT323, ui-monospace, monospace',
	                              fontSize: 16
	                            }
	                          },
	                          label || '·'
	                        )
	                      );
	                    }
	                    rows.push(React.createElement('div', { key: `proto-row-${y}`, style: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 } }, row));
	                  }
	                  return React.createElement('div', { style: { display: 'grid', gap: 6, justifyContent: 'start', marginBottom: 10 } }, rows);
	                })(),
	                protoSim
	                  ? protoSim.ok
	                    ? React.createElement(
	                        'div',
	                        { className: 'feed-item', style: { marginBottom: 10 } },
	                        React.createElement(
	                          'div',
	                          { className: 'feed-text text-glow' },
	                          `WINNER: SEAT ${protoSim.analysis?.winnerSeat ?? protoSim.summary?.winnerSeat ?? '-'}`
	                        ),
	                        React.createElement('div', { className: 'hint', style: { marginTop: 6 } }, protoSim.analysis?.reason || ''),
	                        React.createElement('div', { className: 'hint', style: { marginTop: 6 } }, (protoSim.analysis?.reasons || []).join(' · ')),
	                        React.createElement(
	                          'div',
	                          { style: { marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' } },
	                          React.createElement(
	                            'button',
	                            {
	                              className: 'retro-btn pill secondary',
	                              disabled: protoPlay.on || !(protoSim.initial && protoSim.timeline),
	                              onClick: () => {
	                                const units = {};
	                                (protoSim.initial || []).forEach((u) => {
	                                  units[u.id] = { ...u, hp: u.hpMax };
	                                });
	                                setProtoPlay({ on: true, t: 0, units, idx: 0 });
	                              }
	                            },
	                            protoPlay.on ? 'PLAYING...' : 'PLAY'
	                          ),
	                          React.createElement('div', { className: 'hint', style: { alignSelf: 'center' } }, protoPlay.on ? `t=${protoPlay.t}ms` : '')
	                        )
	                      )
	                    : React.createElement('div', { className: 'hint' }, `오류: ${protoSim.error || 'unknown'}`)
	                  : null,
	                protoSim && protoSim.ok && Array.isArray(protoSim.timeline)
	                  ? React.createElement(
	                      'div',
	                      { className: 'feed-item' },
	                      React.createElement('div', { className: 'feed-text text-glow' }, 'EVENTS'),
	                      React.createElement(
	                        'pre',
	                        { style: { whiteSpace: 'pre-wrap', fontSize: 14, marginTop: 8 } },
	                        protoSim.timeline
	                          .slice(0, 160)
	                          .map(
	                            (e) =>
	                              `${String(e.t).padStart(5)}ms ${e.type}${e.skill ? `(${e.skill})` : ''} ${e.src || ''}${e.dst ? ` -> ${e.dst}` : ''}${
	                                e.amount != null ? ` dmg=${e.amount}` : ''
	                              }`
	                          )
	                          .join('\\n')
	                      )
	                    )
	                  : null
	              )
	            ),
            React.createElement(
              'div',
              { className: 'pane play-center' },
              React.createElement(
                'div',
                { className: 'pane-header' },
                React.createElement('div', { className: 'pane-title' }, 'LOG'),
                React.createElement(
                  'div',
                  { className: 'mini' },
                  gameTime ? `${gameTime.year}.${String(gameTime.month).padStart(2, '0')}.${String(gameTime.day).padStart(2, '0')} · ${seasonByMonth(gameTime?.month)} · ${me?.city_name || '-'}` : '-'
                )
              ),
              React.createElement(
                'div',
                { ref: logRef, className: 'log' },
                (feed || [])
                  .filter((it) => it && !isSystemFeed(it))
                  .map((it) => ({ ...it, _text: feedRenderText(it) }))
                  .filter((it) => String(it._text || '').trim())
                  .map((it) =>
                  React.createElement(
                    'div',
                    {
                      key: it.id,
                      className: `feed-item ${feedKind(it)}`,
                      role: it?.event_type === 'loot' ? 'button' : undefined,
                      tabIndex: it?.event_type === 'loot' ? 0 : undefined,
                      onClick: it?.event_type === 'loot' ? () => openInventory() : undefined
                    },
                    React.createElement(
                      'div',
                      { className: 'feed-head' },
                      React.createElement('div', { className: 'feed-badge' }, feedTitle(it)),
                      React.createElement('div', { className: 'feed-time' }, new Date(it.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
                    ),
                    React.createElement('div', { className: 'feed-text' }, renderWithKeywords(it._text))
                  )
                )
              ),
              storyChoices && storyChoices.length
                ? React.createElement(
                    'div',
                    { className: 'choice-row' },
                    storyChoices.map((c, idx) =>
                      React.createElement(
                        'button',
                        {
                          key: `${c.cmd || 'choice'}-${idx}`,
                          className: 'choice-btn',
                          onPointerDown: (e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            uiSend(String(c.cmd || '').trim());
                          },
                          onClick: () => uiSend(String(c.cmd || '').trim())
                        },
                        c.label || c.cmd || `choice${idx + 1}`
                      )
                    )
                  )
                : null,
              React.createElement(
                'div',
                { className: 'prompt-row' },
                React.createElement('span', { className: 'prompt' }, '> COMMAND INPUT:'),
                React.createElement('input', {
                  className: 'input',
                  ref: promptInputRef,
                  value: inputValue,
                  onChange: (e) => setInputValue(e.target.value),
                  onCompositionStart: () => {
                    composingRef.current = true;
                  },
                  onCompositionEnd: (e) => {
                    composingRef.current = false;
                    // Ensure we capture the final composed string.
                    setInputValue(e.target.value);
                  },
                  onKeyDown: (e) => {
                    if (e.key !== 'Enter') return;
                    // IME(Korean) composition: avoid submitting half-composed text.
                    if (e.isComposing || composingRef.current || e.keyCode === 229) return;
                    e.preventDefault();
                    // Use DOM value (state can lag by 1 frame with IME).
                    submitInput(e.currentTarget.value);
                  },
                  placeholder: 'Type a command or natural language... (end_turn, next, socialize, travel 허창...)'
                }),
                React.createElement(
                  'button',
                  {
                    className: 'retro-btn secondary',
                    onPointerDown: (e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      const live = promptInputRef.current ? promptInputRef.current.value : inputValue;
                      submitInput(live);
                    },
                    onClick: () => {
                      const live = promptInputRef.current ? promptInputRef.current.value : inputValue;
                      submitInput(live);
                    }
                  },
                  'SEND'
                )
              )
            ),
            React.createElement(
              'div',
              { className: 'pane' },
              React.createElement('div', { className: 'pane-header' }, React.createElement('div', { className: 'pane-title' }, 'ACTIONS')),
              React.createElement(
                'div',
                { className: 'pane-body' },
                React.createElement(
                  'div',
                  { className: 'cmd-grid' },
                  (actions || []).slice(0, 10).map((a, idx) => {
                    const cmd = String(a.command || a.cmd || '').trim();
                    const verb = cmdVerb(cmd);
                    const ap = minApForVerb(verb);
                    const disabled = typeof me?.ap === 'number' && ap > 0 ? me.ap < ap : false;
                    return React.createElement(
                      'div',
                      {
                        key: `${cmd || 'cmd'}-${idx}`,
                        className: 'cmd-card',
                        role: 'button',
                        tabIndex: 0,
                        'aria-disabled': disabled ? 'true' : 'false',
                        onClick: () => {
                          if (disabled) return;
                          uiSend(cmd, a.payload || {});
                        },
                        onKeyDown: (e) => {
                          if (e.key !== 'Enter') return;
                          if (disabled) return;
                          uiSend(cmd, a.payload || {});
                        }
                      },
                      React.createElement('div', { className: 'cmd-title' }, cmdLabel(verb, idx)),
                      React.createElement('div', { className: 'cmd-desc' }, cmdDesc(verb, a.why || '')),
                      ap ? React.createElement('div', { className: 'cmd-desc' }, costText({ ap })) : null
                    );
                  })
                ),
                React.createElement('div', { style: { height: 12 } }),
                React.createElement(
                  'div',
                  { className: 'mini-actions' },
                  React.createElement('button', { className: 'btn-soft', onClick: () => uiSend('end_turn') }, 'Turn End'),
                  React.createElement('button', { className: 'btn-soft', onClick: () => uiSend('auto_day') }, 'Auto Day'),
                  React.createElement('button', { className: 'btn-soft', onClick: () => uiSend('story') }, 'Story'),
                  React.createElement('button', { className: 'btn-soft', onClick: () => uiSend('next') }, 'Recommend'),
                  React.createElement('button', { className: 'btn-soft', onClick: () => openShop() }, 'Shop'),
                  React.createElement('button', { className: 'btn-soft', onClick: () => openInventory() }, 'Inventory'),
                  React.createElement('button', { className: 'btn-soft', onClick: () => openChronicle() }, 'Chronicle')
                )
              )
            )
          ),
          showPortraitModal
            ? React.createElement(
                'div',
                {
                  style: {
                    position: 'fixed',
                    inset: 0,
                    zIndex: 260,
                    background: 'rgba(0,0,0,0.58)',
                    padding: 16,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center'
                  },
                  onClick: () => setShowPortraitModal(false)
                },
                React.createElement(
                  'div',
                  {
                    className: 'popover',
                    style: { width: 'min(820px, 96vw)', maxHeight: '90vh', overflow: 'auto' },
                    onClick: (e) => e.stopPropagation()
                  },
                  React.createElement('div', { className: 'text-glow', style: { fontSize: 16, marginBottom: 10 } }, '초상 / 프롬프트'),
                  React.createElement(
                    'div',
                    { style: { display: 'grid', gridTemplateColumns: '260px 1fr', gap: 14, alignItems: 'start' } },
                    React.createElement(
                      'div',
                      null,
                      me?.portrait?.status === 'done' && me?.portrait?.url
                        ? React.createElement('img', {
                            className: 'portrait portrait-modal portrait-img',
                            alt: 'portrait',
                            src: `${me.portrait.url}?t=${encodeURIComponent(String(me.portrait.updated_at || ''))}`
                          })
                        : React.createElement(PixelPortrait, {
                            seedText: `${me?.id || ''}|${me?.name_kr || ''}`,
                            size: 96,
                            className: 'portrait portrait-modal portrait-pixel'
                          }),
                      React.createElement('div', { className: 'hint', style: { marginTop: 10 } }, `상태: ${me?.portrait?.status || 'none'}`)
                    ),
                    React.createElement(
                      'div',
                      null,
                      React.createElement('div', { className: 'hint', style: { marginBottom: 6 } }, '프롬프트'),
                      React.createElement(
                        'div',
                        { style: { display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 10, alignItems: 'center' } },
                        React.createElement(
                          'label',
                          { className: 'hint', style: { display: 'flex', gap: 6, alignItems: 'center' } },
                          '스타일',
                          React.createElement(
                            'select',
                            {
                              className: 'input',
                              style: { width: 160, padding: '8px 10px' },
                              value: portraitStyle,
                              onChange: (e) => setPortraitStyle(String(e.target.value || 'realistic'))
                            },
                            React.createElement('option', { value: 'drama' }, 'drama (photo)'),
                            React.createElement('option', { value: 'realistic' }, 'realistic'),
                            React.createElement('option', { value: 'ink' }, 'ink wash'),
                            React.createElement('option', { value: 'pixel' }, 'pixel')
                          )
                        ),
                        React.createElement(
                          'label',
                          { className: 'hint', style: { display: 'flex', gap: 6, alignItems: 'center' } },
                          '구도',
                          React.createElement(
                            'select',
                            {
                              className: 'input',
                              style: { width: 160, padding: '8px 10px' },
                              value: portraitFocus,
                              onChange: (e) => setPortraitFocus(String(e.target.value || 'face'))
                            },
                            React.createElement('option', { value: 'face' }, 'face'),
                            React.createElement('option', { value: 'bust' }, 'bust')
                          )
                        ),
                        React.createElement(
                          'button',
                          { className: 'retro-btn secondary', onClick: () => suggestPortraitPrompt({ style: portraitStyle, focus: portraitFocus }) },
                          '자동완성'
                        )
                      ),
                      React.createElement('textarea', {
                        className: 'input',
                        style: { width: '100%', minHeight: 96, resize: 'vertical' },
                        value: portraitPrompt,
                        onChange: (e) => setPortraitPrompt(e.target.value),
                        placeholder: '예: pixel art portrait, chinese general, helmet, scar, close-up face...'
                      }),
                      portraitAnchors && portraitAnchors.length
                        ? React.createElement(
                            'div',
                            { className: 'hint', style: { marginTop: 10 } },
                            React.createElement('div', { style: { marginBottom: 6, opacity: 0.9 } }, '근거(로어 카드)'),
                            React.createElement(
                              'div',
                              { style: { display: 'grid', gap: 6 } },
                              portraitAnchors.slice(0, 4).map((a, i) =>
                                React.createElement(
                                  'div',
                                  { key: `anc_${i}`, className: 'lore-card', style: { padding: '8px 10px' } },
                                  String(a || '')
                                    .replace(/\\n/g, ' ')
                                    .replace(/\s+/g, ' ')
                                    .trim()
                                )
                              )
                            )
                          )
                        : null,
                      React.createElement(
                        'div',
                        { style: { display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 10 } },
                        React.createElement(
                          'button',
                          {
                            className: 'retro-btn secondary',
                            onClick: async () => {
                              const p = String(portraitPrompt || '').trim();
                              if (!p) {
                                setUiError('초상 프롬프트가 비었습니다.');
                                return;
                              }
                              const r = await execGameCommand('portrait_set', { prompt: p });
                              pushSystem(r.ok ? r.summary : `오류: ${r.error}`);
                              if (!r.ok) setUiError(`portrait_set 실패: ${r.error}`);
                              if (r.ok) await refreshUI();
                            }
                          },
                          '저장(set)'
                        ),
                        React.createElement('button', { className: 'retro-btn', onClick: () => generatePortrait(256) }, '생성(256)'),
                        React.createElement('button', { className: 'retro-btn secondary', onClick: () => generatePortrait(512) }, '생성(512)'),
                        React.createElement(
                          'button',
                          { className: 'retro-btn secondary', onClick: () => setShowPortraitModal(false) },
                          '닫기'
                        )
                      ),
                      me?.portrait?.status === 'error' && me?.portrait?.error
                        ? React.createElement('div', { className: 'banner', style: { marginTop: 12 } }, `초상 오류: ${me.portrait.error}`)
                        : null
                    )
                  )
                )
              )
            : null,
          showShopOverlay
            ? React.createElement(
                'div',
                {
                  style: {
                    position: 'fixed',
                    inset: 0,
                    zIndex: 220,
                    background: 'rgba(0,0,0,0.65)',
                    padding: 16,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center'
                  },
                  onClick: () => setShowShopOverlay(false)
                },
                React.createElement(
                  'div',
                  { className: 'popover', style: { width: 'min(860px, 96vw)', maxHeight: '86vh', overflow: 'auto' }, onClick: (e) => e.stopPropagation() },
                  React.createElement(
                    'div',
                    { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 } },
                    React.createElement('div', { className: 'text-glow', style: { fontSize: 18 } }, 'SHOP'),
                    React.createElement('button', { className: 'retro-btn pill secondary', onClick: () => setShowShopOverlay(false) }, '닫기')
                  ),
                  React.createElement(
                    'div',
                    { className: 'hint', style: { marginBottom: 10 } },
                    `Gold: ${me?.gold ?? '-'} | 약 ${invQty('med_small')} | 군마 ${equippedId('mount') ? 'ON' : invQty('mount_basic') ? 'OWN' : 'OFF'} | 무기 ${equippedId('weapon') ? 'ON' : invQty('weapon_basic') ? 'OWN' : 'OFF'}`
                  ),
                  React.createElement(
                    'div',
                    { style: { display: 'grid', gap: 10 } },
                    (shopItems || []).map((it) => {
                      const id = it.item_id || it.id;
                      const soldOut = !!(it.soldOut || it.sold_out);
                      const owned = invQty(String(id || ''));
                      const rarity = String(it.rarity || 'common');
                      const type = String(it.type || '');
                      return React.createElement(
                        'div',
                        { key: String(id), className: 'feed-item' },
                        React.createElement(
                          'div',
                          { className: 'feed-head' },
                          React.createElement('div', { className: 'feed-time' }, rarity.toUpperCase()),
                          React.createElement('div', { className: 'feed-badge' }, type.toUpperCase() || 'ITEM')
                        ),
                        React.createElement('div', { className: 'feed-text text-glow' }, `${it.name} (${id})`),
                        React.createElement('div', { className: 'hint', style: { marginTop: 6 } }, `${it.price}G | owned:${owned} | ${it.description || it.desc || ''}`),
                        soldOut ? React.createElement('div', { className: 'banner', style: { marginTop: 10 } }, 'SOLD OUT') : null,
                        React.createElement(
                          'div',
                          { style: { marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' } },
                          React.createElement(
                            'button',
                            {
                              className: 'retro-btn pill',
                              disabled: soldOut,
                              onClick: async () => {
                                if (soldOut) return;
                                const r = await execGameCommand('buy', { itemId: id });
                                pushSystem(r.ok ? r.summary : `오류: ${r.error}`);
                                if (!r.ok) setUiError(`buy 실패: ${r.error}`);
                                await refreshUI();
                              }
                            },
                            `BUY (${it.price}G)`
                          ),
                          type === 'consumable' && owned > 0
                            ? React.createElement(
                                'button',
                                {
                                  className: 'retro-btn pill secondary',
                                  onClick: async () => {
                                    const r = await execGameCommand('use', { itemId: id });
                                    pushSystem(r.ok ? r.summary : `오류: ${r.error}`);
                                    if (!r.ok) setUiError(`use 실패: ${r.error}`);
                                    await refreshUI();
                                  }
                                },
                                'USE'
                              )
                            : null,
                          React.createElement(
                            'button',
                            { className: 'retro-btn pill secondary', onClick: () => openInventory() },
                            'OPEN INV'
                          )
                        )
                      );
                    })
                  )
                )
              )
            : null,
          showInventoryOverlay
            ? React.createElement(
                'div',
                {
                  style: {
                    position: 'fixed',
                    inset: 0,
                    zIndex: 221,
                    background: 'rgba(0,0,0,0.65)',
                    padding: 16,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center'
                  },
                  onClick: () => setShowInventoryOverlay(false)
                },
                React.createElement(
                  'div',
                  { className: 'popover', style: { width: 'min(860px, 96vw)', maxHeight: '86vh', overflow: 'auto' }, onClick: (e) => e.stopPropagation() },
                  React.createElement(
                    'div',
                    { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 } },
                    React.createElement('div', { className: 'text-glow', style: { fontSize: 18 } }, 'INVENTORY'),
                    React.createElement(
                      'div',
                      { style: { display: 'flex', gap: 8, alignItems: 'center' } },
                      React.createElement('button', { className: 'retro-btn pill secondary', onClick: () => openChronicle() }, 'CHRONICLE'),
                      React.createElement('button', { className: 'retro-btn pill secondary', onClick: () => setShowInventoryOverlay(false) }, '닫기')
                    )
                  ),
                  React.createElement('div', { className: 'hint', style: { marginBottom: 10 } }, `Gold: ${me?.gold ?? '-'} | Items: ${inventoryItems.length}`),
                  (() => {
                    const eWeapon = equippedId('weapon');
                    const eMount = equippedId('mount');
                    const nameById = (id) => {
                      const hit = (inventoryItems || []).find((x) => x && x.id === id);
                      const nm = hit && hit.item && hit.item.name ? String(hit.item.name) : '';
                      return nm || String(id || '');
                    };

                    const filtered = (inventoryItems || []).filter((x) => {
                      if (!x) return false;
                      const t = String(x.item?.type || '').toLowerCase();
                      if (inventoryTab === 'all') return true;
                      if (inventoryTab === 'equipment') return t === 'equipment';
                      if (inventoryTab === 'consumable') return t === 'consumable';
                      return true;
                    });

                    const tabBtn = (id, label) =>
                      React.createElement(
                        'button',
                        {
                          key: `invtab-${id}`,
                          className: `retro-btn pill ${inventoryTab === id ? '' : 'secondary'}`,
                          onClick: () => setInventoryTab(id)
                        },
                        label
                      );

                    const slotCard = (slot, title, activeId) =>
                      React.createElement(
                        'div',
                        { key: `slot-${slot}`, className: 'feed-item' },
                        React.createElement(
                          'div',
                          { className: 'feed-head' },
                          React.createElement('div', { className: 'feed-time' }, title),
                          React.createElement('div', { className: 'feed-badge' }, activeId ? 'EQUIPPED' : 'EMPTY')
                        ),
                        React.createElement('div', { className: 'feed-text text-glow' }, activeId ? `${nameById(activeId)} (${activeId})` : '—'),
                        activeId
                          ? React.createElement(
                              'div',
                              { style: { marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' } },
                              React.createElement(
                                'button',
                                {
                                  className: 'retro-btn pill secondary',
                                  onClick: async () => {
                                    const r = await execGameCommand('unequip', { slot });
                                    pushSystem(r.ok ? r.summary : `오류: ${r.error}`);
                                    if (!r.ok) setUiError(`unequip 실패: ${r.error}`);
                                    await refreshUI();
                                    await openInventory();
                                  }
                                },
                                'UNEQUIP'
                              )
                            )
                          : null
                      );

                    return React.createElement(
                      React.Fragment,
                      null,
                      React.createElement(
                        'div',
                        { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 } },
                        slotCard('weapon', 'WEAPON', eWeapon),
                        slotCard('mount', 'MOUNT', eMount)
                      ),
                      React.createElement(
                        'div',
                        { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 } },
                        tabBtn('equipment', '장비'),
                        tabBtn('consumable', '소모품'),
                        tabBtn('all', '전체')
                      ),
                      filtered.length
                        ? React.createElement(
                            'div',
                            { style: { display: 'grid', gap: 10 } },
                            filtered.map((x) => {
                              const it = x.item || {};
                              const id = x.id;
                              const qty = x.qty;
                              const type = String(it.type || '');
                              const rarity = String(it.rarity || 'common');
                              const isEquippedWeapon = eWeapon && id === eWeapon;
                              const isEquippedMount = eMount && id === eMount;
                              const equipped = isEquippedWeapon || isEquippedMount;

                              return React.createElement(
                                'div',
                                { key: `inv-${id}`, className: `feed-item ${equipped ? 'reward' : ''}` },
                                React.createElement(
                                  'div',
                                  { className: 'feed-head' },
                                  React.createElement('div', { className: 'feed-time' }, `x${qty}`),
                                  React.createElement(
                                    'div',
                                    { className: 'feed-badge' },
                                    `${rarity.toUpperCase()} ${type.toUpperCase()}${equipped ? ' · ON' : ''}`
                                  )
                                ),
                                React.createElement('div', { className: 'feed-text text-glow' }, `${it.name || id} (${id})`),
                                React.createElement('div', { className: 'hint', style: { marginTop: 6 } }, it.description || ''),
                                type === 'consumable' || type === 'equipment'
                                  ? React.createElement(
                                      'div',
                                      { style: { marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' } },
                                      type === 'consumable'
                                        ? React.createElement(
                                            'button',
                                            {
                                              className: 'retro-btn pill',
                                              onClick: async () => {
                                                const r = await execGameCommand('use', { itemId: id });
                                                pushSystem(r.ok ? r.summary : `오류: ${r.error}`);
                                                if (!r.ok) setUiError(`use 실패: ${r.error}`);
                                                await refreshUI();
                                                await openInventory();
                                              }
                                            },
                                            'USE'
                                          )
                                        : null,
                                      type === 'equipment'
                                        ? React.createElement(
                                            'button',
                                            {
                                              className: 'retro-btn pill',
                                              disabled: equipped,
                                              onClick: async () => {
                                                const r = await execGameCommand('equip', { itemId: id });
                                                pushSystem(r.ok ? r.summary : `오류: ${r.error}`);
                                                if (!r.ok) setUiError(`equip 실패: ${r.error}`);
                                                await refreshUI();
                                                await openInventory();
                                              }
                                            },
                                            equipped ? 'EQUIPPED' : 'EQUIP'
                                          )
                                        : null
                                    )
                                  : null
                              );
                            })
                          )
                        : React.createElement('div', { className: 'hint' }, '표시할 아이템이 없습니다.')
                    );
                  })()
                )
              )
            : null,
          showChronicleOverlay
            ? React.createElement(
                'div',
                {
                  style: {
                    position: 'fixed',
                    inset: 0,
                    zIndex: 222,
                    background: 'rgba(0,0,0,0.65)',
                    padding: 16,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center'
                  },
                  onClick: () => setShowChronicleOverlay(false)
                },
                React.createElement(
                  'div',
                  { className: 'popover', style: { width: 'min(920px, 96vw)', maxHeight: '86vh', overflow: 'auto' }, onClick: (e) => e.stopPropagation() },
                  React.createElement(
                    'div',
                    { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 } },
                    React.createElement('div', { className: 'text-glow', style: { fontSize: 18 } }, 'CHRONICLE'),
                    React.createElement('button', { className: 'retro-btn pill secondary', onClick: () => setShowChronicleOverlay(false) }, '닫기')
                  ),
                  React.createElement(
                    'div',
                    { className: 'hint', style: { marginBottom: 12 } },
                    `Officer: ${chronicle?.officer?.name_kr || '-'} | Fame: ${chronicle?.officer?.fame ?? '-'} | Merit: ${chronicle?.officer?.merit ?? '-'}`
                  ),
                  chronicle?.ending
                    ? React.createElement(
                        'div',
                        { className: 'feed-item reward', style: { marginBottom: 12 } },
                        React.createElement(
                          'div',
                          { className: 'feed-head' },
                          React.createElement('div', { className: 'feed-time' }, 'ENDING'),
                          React.createElement('div', { className: 'feed-badge' }, String(chronicle.ending.endingName || 'ENDING'))
                        ),
                        React.createElement(
                          'div',
                          { className: 'feed-text text-glow' },
                          chronicle.ending.endingDesc || '챕터 결말이 기록되었습니다.'
                        )
                      )
                    : null,
                  React.createElement('div', { className: 'hint', style: { marginBottom: 8 } }, 'UNIQUE ITEMS'),
                  Array.isArray(chronicle?.uniques) && chronicle.uniques.length
                    ? React.createElement(
                        'div',
                        { style: { display: 'grid', gap: 10 } },
                        chronicle.uniques.map((u) => {
                          const effects = u.effects && typeof u.effects === 'object' ? u.effects : {};
                          const effectLine =
                            effects.kind === 'travel_discount'
                              ? `Effect: travel AP -${Math.round((effects.pct || 0) * 100)}% (min ${effects.min_ap || 5})`
                              : effects.kind === 'battle_attack_flat'
                                ? `Effect: battle attack +${effects.amount || 0}`
                                : effects.kind
                                  ? `Effect: ${effects.kind}`
                                  : '';
                          return React.createElement(
                            'div',
                            { key: String(u.unique_key || u.item_id), className: 'feed-item loot' },
                            React.createElement(
                              'div',
                              { className: 'feed-head' },
                              React.createElement(
                                'div',
                                { className: 'feed-time' },
                                u.acquired_at ? new Date(u.acquired_at).toLocaleString() : '—'
                              ),
                              React.createElement('div', { className: 'feed-badge' }, String((u.rarity || 'unique').toUpperCase()))
                            ),
                            React.createElement('div', { className: 'feed-text text-glow' }, `${u.name} (${u.item_id})`),
                            effectLine ? React.createElement('div', { className: 'hint', style: { marginTop: 6 } }, effectLine) : null,
                            u.lore?.body
                              ? React.createElement('div', { className: 'hint', style: { marginTop: 10, whiteSpace: 'pre-wrap' } }, u.lore.body)
                              : React.createElement('div', { className: 'hint', style: { marginTop: 10, whiteSpace: 'pre-wrap' } }, u.description || '')
                          );
                        })
                      )
                    : React.createElement('div', { className: 'hint' }, '보유 중인 유니크 아이템이 없습니다.')
                )
              )
            : null,
          showEmployOverlay
            ? React.createElement(
                'div',
                {
                  style: {
                    position: 'fixed',
                    inset: 0,
                    zIndex: 230,
                    background: 'rgba(0,0,0,0.65)',
                    padding: 16,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center'
                  },
                  onClick: () => setShowEmployOverlay(false)
                },
                React.createElement(
                  'div',
                  { className: 'popover', style: { width: 'min(860px, 96vw)', maxHeight: '86vh', overflow: 'auto' }, onClick: (e) => e.stopPropagation() },
                  React.createElement(
                    'div',
                    { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 } },
                    React.createElement('div', { className: 'text-glow', style: { fontSize: 18 } }, 'EMPLOY (같은 도시 재야)'),
                    React.createElement('button', { className: 'retro-btn pill secondary', onClick: () => setShowEmployOverlay(false) }, '닫기')
                  ),
                  React.createElement(
                    'div',
                    { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 } },
                    React.createElement(
                      'button',
                      {
                        className: 'retro-btn pill',
                        onClick: async () => {
                          const r = await execGameCommand('recruit_rumor', {});
                          pushSystem(r.ok ? r.summary : `오류: ${r.error}`);
                          if (!r.ok) setUiError(`recruit_rumor 실패: ${r.error}`);
                          await refreshUI();
                        }
                      },
                      'RUMOR (AP-10 | G-50)'
                    ),
                    React.createElement(
                      'button',
                      {
                        className: 'retro-btn pill secondary',
                        onClick: async () => {
                          const r = await execGameCommand('search', {});
                          pushSystem(r.ok ? r.summary : `오류: ${r.error}`);
                          if (!r.ok) setUiError(`search 실패: ${r.error}`);
                          await refreshUI();
                          await openEmployCandidates();
                        }
                      },
                      'SEARCH'
                    ),
                    React.createElement(
                      'button',
                      { className: 'retro-btn pill secondary', onClick: () => openEmployCandidates() },
                      'REFRESH LIST'
                    )
                  ),
                  employCandidates.length
                    ? React.createElement(
                        'div',
                        { style: { display: 'grid', gap: 10 } },
                        employCandidates.map((c) =>
                          React.createElement(
                            'div',
                            { key: c.id, className: 'feed-item' },
                            React.createElement('div', { className: 'feed-text text-glow' }, `${c.name_kr} (${c.id})`),
                            React.createElement('div', { className: 'hint', style: { marginTop: 6 } }, `WAR:${c.war} LDR:${c.ldr} INT:${c.int_stat} POL:${c.pol} CHR:${c.chr}`),
                            React.createElement(
                              'div',
                              { style: { marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' } },
                              React.createElement(
                                'button',
                                {
                                  className: 'retro-btn pill',
                                  onClick: async () => {
                                    const r = await execGameCommand('employ', { targetOfficerId: c.id });
                                    pushSystem(r.ok ? r.summary : `오류: ${r.error}`);
                                    if (!r.ok) setUiError(`employ 실패: ${r.error}`);
                                    await refreshUI();
                                    await openEmployCandidates();
                                  }
                                },
                                'EMPLOY'
                              )
                            )
                          )
                        )
                      )
                    : React.createElement('div', { className: 'hint' }, '후보가 없습니다. RUMOR -> SEARCH로 재야 조우 확률을 올려보세요.')
                )
              )
            : null,
          showMapOverlay
            ? React.createElement(
                'div',
                {
                  style: {
                    position: 'fixed',
                    inset: 0,
                    zIndex: 200,
                    background: 'rgba(0,0,0,0.65)',
                    padding: 16,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center'
                  },
                  onClick: () => setShowMapOverlay(false)
                },
                React.createElement(
                  'div',
                  { className: 'popover', style: { width: 'min(980px, 96vw)', maxHeight: '86vh', overflow: 'auto' }, onClick: (e) => e.stopPropagation() },
                  React.createElement(
                    'div',
                    { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 } },
                    React.createElement('div', { className: 'text-glow', style: { fontSize: 18 } }, 'MAP OVERLAY'),
                    React.createElement('button', { className: 'retro-btn pill secondary', onClick: () => setShowMapOverlay(false) }, '닫기')
                  ),
                  React.createElement(AsciiMap)
                )
              )
            : null
        )
      : React.createElement(
          'div',
          { style: { padding: 12 } },
          React.createElement(
            'div',
            { className: 'pane', style: { height: 'calc(100vh - 140px)' } },
            React.createElement(
              'div',
              { className: 'pane-header' },
              React.createElement('div', { className: 'pane-title' }, dashTab === 'design' ? 'GAME DESIGN' : dashTab === 'db' ? 'DB SCHEMA' : 'ARCHITECTURE'),
              React.createElement('div', { className: 'hint' }, 'PLAY 탭으로 돌아가면 게임 화면으로 전환됩니다.')
            ),
            React.createElement(
              'div',
              { className: 'pane-body' },
              dashTab === 'design'
                ? React.createElement(
                    'div',
                    null,
                    React.createElement('div', { className: 'feed-text text-glow', style: { marginBottom: 10 } }, 'Officer Perspective (장수 1인 플레이)'),
                    React.createElement(
                      'div',
                      { className: 'feed-item' },
                      React.createElement('div', { className: 'feed-text' }, '핵심: 군주/세력 운영이 아니라 장수의 커리어(재야 -> 임관 -> 전공/인맥 -> 출세)'),
                      React.createElement('div', { className: 'hint', style: { marginTop: 6 } }, 'AI는 “표현”만, 판정/결과는 서버 규칙이 100% 결정')
                    ),
                    React.createElement(
                      'div',
                      { className: 'feed-item' },
                      React.createElement('div', { className: 'feed-text' }, '입력: 버튼(쉬움) + 커맨드(파워유저) + 자연어(점진 적용)'),
                      React.createElement('div', { className: 'hint', style: { marginTop: 6 } }, '추천: next, 자동: auto_day, 인맥: socialize, 회복: rest')
                    ),
                    React.createElement(
                      'div',
                      { className: 'feed-item' },
                      React.createElement('div', { className: 'feed-text' }, '루프: 정보(정찰/지도) -> 이동 -> 인맥/등용 -> 임무(story) -> 교전/전공'),
                      React.createElement('div', { className: 'hint', style: { marginTop: 6 } }, 'Tab 키: 중앙 MAIN VIEW(지도/지역/열전) 전환')
                    )
                  )
                : dashTab === 'db'
                  ? React.createElement(
                      'div',
                      null,
                      React.createElement('div', { className: 'feed-text text-glow', style: { marginBottom: 10 } }, 'PostgreSQL (Core + JSONB 확장)'),
                      React.createElement(
                        'pre',
                        { className: 'feed-item', style: { whiteSpace: 'pre-wrap', fontSize: 16 } },
                        [
                          '핵심 테이블:',
                          '- officers: 5대 스탯 + hidden_stats(jsonb), personality',
                          '- cities: resources(jsonb), coordinates(point), defense_max',
                          '- edges: 그래프 이동(terrain, distance) + is_chokepoint',
                          '- relationships: (source,target,type) 관시 그래프',
                          '- scenario_events: 날짜 + 조건(condition_json) + 효과(effect_script)',
                          '',
                          '원칙:',
                          '- AI는 DB/룰을 바꾸지 못함(표현만 담당)',
                          '- 결과는 biography_logs로 기록, 재현 가능한 로그 지향'
                        ].join('\n')
                      )
                    )
                  : React.createElement(
                      'div',
                      null,
                      React.createElement('div', { className: 'feed-text text-glow', style: { marginBottom: 10 } }, 'Architecture'),
                      React.createElement(
                        'pre',
                        { className: 'feed-item', style: { whiteSpace: 'pre-wrap', fontSize: 16 } },
                        [
                          'Clients: Web / (향후) Telegram Bot + Mini App',
                          'API: Node.js(Express) + Socket.io',
                          'DB: PostgreSQL + Redis + BullMQ(worker)',
                          'AI: FastAPI(openai-compatible) -> 서사(narration) 생성',
                          '',
                          'Flow:',
                          'User Input -> API(Command) -> DB Update -> Log Insert -> Queue -> AI Narration -> UI Stream'
                        ].join('\n')
                      )
                    )
            )
          )
        )
  );
}

function showFatal(err) {
  const msg = (err && (err.stack || err.message)) ? String(err.stack || err.message) : String(err);
  let el = document.getElementById('fatal');
  if (!el) {
    el = document.createElement('pre');
    el.id = 'fatal';
    el.style.position = 'fixed';
    el.style.inset = '0';
    el.style.padding = '16px';
    el.style.margin = '0';
    el.style.background = '#0b0e1a';
    el.style.color = '#ffb4b4';
    el.style.zIndex = '99999';
    el.style.whiteSpace = 'pre-wrap';
    document.body.appendChild(el);
  }
  el.textContent = msg;
}

window.addEventListener('error', (e) => showFatal(e.error || e.message));
window.addEventListener('unhandledrejection', (e) => showFatal(e.reason || 'unhandled rejection'));

try {
  createRoot(document.getElementById('root')).render(React.createElement(App));
} catch (err) {
  showFatal(err);
}
