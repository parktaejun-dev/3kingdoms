const WIDTH = 20;
const HEIGHT = 20;

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function generateBattleMap() {
  const rows = [];
  for (let y = 0; y < HEIGHT; y += 1) {
    const row = [];
    for (let x = 0; x < WIDTH; x += 1) {
      const r = Math.random();
      if (r < 0.05) row.push('#');
      else if (r < 0.12) row.push('^');
      else if (r < 0.16) row.push('~');
      else row.push('.');
    }
    rows.push(row);
  }
  rows[1][1] = '.';
  rows[HEIGHT - 2][WIDTH - 2] = '.';
  return rows;
}

function inBounds(x, y) {
  return x >= 0 && x < WIDTH && y >= 0 && y < HEIGHT;
}

function walkable(mapRows, x, y) {
  if (!inBounds(x, y)) return false;
  const t = mapRows[y][x];
  return t !== '#' && t !== '~';
}

export function renderBattleMap(mapRows, playerPos, enemyPos) {
  const lines = [];
  for (let y = 0; y < HEIGHT; y += 1) {
    let line = '';
    for (let x = 0; x < WIDTH; x += 1) {
      if (playerPos.x === x && playerPos.y === y) line += 'P';
      else if (enemyPos.x === x && enemyPos.y === y) line += 'E';
      else line += mapRows[y][x];
    }
    lines.push(line);
  }
  return lines;
}

export function isAdjacent(a, b) {
  const d = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  return d === 1;
}

export function moveByDirection(pos, direction) {
  if (direction === 'n') return { x: pos.x, y: pos.y - 1 };
  if (direction === 's') return { x: pos.x, y: pos.y + 1 };
  if (direction === 'w') return { x: pos.x - 1, y: pos.y };
  if (direction === 'e') return { x: pos.x + 1, y: pos.y };
  return pos;
}

export function tryMove(mapRows, pos, direction) {
  const next = moveByDirection(pos, direction);
  if (walkable(mapRows, next.x, next.y)) return next;
  return pos;
}

export function calcPlayerDamage(war, bonusFlat = 0) {
  // Keep it simple: small, readable bonus that doesn't break early-game balance.
  const w = Number.isFinite(Number(war)) ? Number(war) : 0;
  const b = Number.isFinite(Number(bonusFlat)) ? Number(bonusFlat) : 0;
  return Math.max(5, Math.floor(w * 0.6) + randInt(0, 19) + Math.floor(b));
}

export function calcEnemyDamage() {
  return randInt(8, 22);
}

export function enemyStep(mapRows, enemyPos, playerPos) {
  if (isAdjacent(enemyPos, playerPos)) return enemyPos;
  const candidates = [];
  if (playerPos.x > enemyPos.x) candidates.push('e');
  if (playerPos.x < enemyPos.x) candidates.push('w');
  if (playerPos.y > enemyPos.y) candidates.push('s');
  if (playerPos.y < enemyPos.y) candidates.push('n');
  candidates.push('n', 's', 'e', 'w');
  for (const d of candidates) {
    const moved = tryMove(mapRows, enemyPos, d);
    if (moved.x !== enemyPos.x || moved.y !== enemyPos.y) return moved;
  }
  return enemyPos;
}

export const BATTLE_SIZE = { width: WIDTH, height: HEIGHT };
