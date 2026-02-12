function clamp(min, val, max) {
  return Math.max(min, Math.min(max, val));
}

export function cultivateYield(officer) {
  return Math.floor((officer.pol * 0.8 + officer.ldr * 0.2) * 1.2);
}

export function trainYield(officer) {
  return Math.floor((officer.war * 0.6 + officer.ldr * 0.4) * 0.7);
}

export function recruitYield(officer, city) {
  const base = officer.chr * 12;
  const penalty = city.population < 100000 ? 0.6 : 1;
  return Math.floor(base * penalty);
}

export function consumeAP(officer, cost) {
  if (officer.ap < cost) {
    throw new Error('AP가 부족합니다. rest로 회복하거나 next/auto_day로 진행하세요.');
  }
  return officer.ap - cost;
}

export function updateMerit(merit, delta) {
  return clamp(0, merit + delta, 999999);
}

export function nextRankByMerit(merit) {
  if (merit >= 30000) return 2;
  if (merit >= 10000) return 5;
  if (merit >= 1000) return 8;
  return 9;
}

export function travelCost(distance) {
  return Math.max(10, distance * 10);
}

export function searchFindChance(intStat, chr) {
  // 0.05 ~ 0.80
  const p = 0.05 + (intStat * 0.003) + (chr * 0.002);
  return clamp(0.05, p, 0.8);
}

export function employChance(chr, targetLoyalty, compatibilityDeltaAbs) {
  // Compatibility delta: 0 is best, 75 is worst (opposite).
  const compatBonus = Math.max(-30, 30 - Math.floor(compatibilityDeltaAbs / 3));
  const base = 30;
  const raw = base + (chr - targetLoyalty) + compatBonus;
  return clamp(1, raw, 95); // percent
}

export function spyAccuracy(intStat) {
  // 0.40 ~ 0.95
  const p = 0.4 + intStat * 0.006;
  return clamp(0.4, p, 0.95);
}

export function noisyValue(value, accuracy) {
  // accuracy 1.0 => no noise, 0.4 => up to ~+-40%
  const span = Math.max(0, 1 - accuracy);
  const noise = (Math.random() * 2 - 1) * span;
  return Math.max(0, Math.floor(value * (1 + noise)));
}
