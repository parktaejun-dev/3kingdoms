// 190 AD Anti-Dong Zhuo Coalition scenario seed data
// Historical names are public domain. Stats are original approximations (not Koei data).
//
// Design notes:
// - TEXT IDs for cities/officers/factions (API compatibility)
// - Fixed stats per officer (no archetype randomization)
// - Compatibility: 0-149 ring structure (closer = better chemistry)
// - Hidden stats: ambition (betrayal tendency), duty (loyalty persistence)

// ─── Regions (10 provinces) ────────────────────────────────────────────────────
export const seedRegions = [
  { name_zh: '사예', name_en: 'Sili', description: '황실 수도권. 낙양과 장안이 위치한 정치의 중심.', climate_type: 'Temperate', resource_modifier: { food: 1.0, gold: 1.2 } },
  { name_zh: '기주', name_en: 'Jizhou', description: '하북의 풍요로운 대평원. 인구와 곡창의 중심지.', climate_type: 'Temperate', resource_modifier: { food: 1.3, gold: 1.0 } },
  { name_zh: '연주', name_en: 'Yanzhou', description: '중원의 요충지. 사방으로 통하는 교통의 핵심.', climate_type: 'Temperate', resource_modifier: { food: 1.1, gold: 1.0 } },
  { name_zh: '예주', name_en: 'Yuzhou', description: '인구 밀집 지역. 중원 패권 경쟁의 무대.', climate_type: 'Temperate', resource_modifier: { food: 1.0, gold: 1.1 } },
  { name_zh: '형주', name_en: 'Jingzhou', description: '남북을 잇는 교통 요지. 수군과 농업이 발달.', climate_type: 'Wet', resource_modifier: { food: 1.2, gold: 1.0 } },
  { name_zh: '양주', name_en: 'Yangzhou', description: '강동 지역. 풍부한 수산과 상업의 땅.', climate_type: 'Wet', resource_modifier: { food: 1.0, gold: 1.2 } },
  { name_zh: '익주', name_en: 'Yizhou', description: '천혜의 요새. 산악 지형으로 방어에 유리.', climate_type: 'Humid', resource_modifier: { food: 1.1, gold: 0.9 } },
  { name_zh: '청주', name_en: 'Qingzhou', description: '동쪽 해안 지역. 황건적 잔당의 활동지.', climate_type: 'Temperate', resource_modifier: { food: 1.0, gold: 0.9 } },
  { name_zh: '유주', name_en: 'Youzhou', description: '북방 국경. 이민족과 접경한 군사 요충.', climate_type: 'Cold', resource_modifier: { food: 0.8, gold: 0.8 } },
  { name_zh: '서량', name_en: 'Liangzhou', description: '서북방 건조 지대. 기마 민족의 영향이 강함.', climate_type: 'Dry', resource_modifier: { food: 0.7, gold: 0.8 } },
];

// ─── Factions (6 warlords + 2 system) ──────────────────────────────────────────
export const seedFactions = [
  { id: 'dong_zhuo', name_zh: '동탁', name_en: 'Dong Zhuo', ruler_officer_id: 'dong_zhuo', color_hex: '#1a1a2e', reputation: 500, imperial_seal: false, capital_city_id: 'luo_yang' },
  { id: 'cao_cao',   name_zh: '조조', name_en: 'Cao Cao',   ruler_officer_id: 'cao_cao',   color_hex: '#0066cc', reputation: 100, imperial_seal: false, capital_city_id: 'chen_liu' },
  { id: 'liu_bei',   name_zh: '유비', name_en: 'Liu Bei',   ruler_officer_id: 'liu_bei',   color_hex: '#2d8c46', reputation: 50,  imperial_seal: false, capital_city_id: 'ping_yuan' },
  { id: 'sun_jian',  name_zh: '손견', name_en: 'Sun Jian',  ruler_officer_id: 'sun_jian',  color_hex: '#cc3333', reputation: 200, imperial_seal: false, capital_city_id: 'chang_sha' },
  { id: 'yuan_shao', name_zh: '원소', name_en: 'Yuan Shao', ruler_officer_id: 'yuan_shao', color_hex: '#cccc00', reputation: 400, imperial_seal: false, capital_city_id: 'nan_pi' },
  { id: 'yuan_shu',  name_zh: '원술', name_en: 'Yuan Shu',  ruler_officer_id: 'yuan_shu',  color_hex: '#e68a00', reputation: 300, imperial_seal: false, capital_city_id: 'wan' },
  // System factions (compatible with existing force_id)
  { id: 'neutral',   name_zh: '중립', name_en: 'Neutral',   ruler_officer_id: null, color_hex: '#888888', reputation: 0, imperial_seal: false, capital_city_id: null },
  { id: 'ronin',     name_zh: '재야', name_en: 'Ronin',     ruler_officer_id: null, color_hex: '#aaaaaa', reputation: 0, imperial_seal: false, capital_city_id: null },
];

// ─── Cities (11 key cities for 190 AD) ─────────────────────────────────────────
// region_name maps to seedRegions by name_zh (resolved at insert time)
export const seedCities = [
  // Sili (Dong Zhuo)
  { id: 'luo_yang',  name_kr: '낙양', region_name: '사예', owner_force_id: 'dong_zhuo', gold: 52000, rice: 300000, population: 800000, max_population: 1000000, commerce: 520, farming: 520, defense: 600, traits: { port: false, horse_production: false, imperial_capital: true } },
  { id: 'chang_an',  name_kr: '장안', region_name: '사예', owner_force_id: 'dong_zhuo', gold: 40000, rice: 250000, population: 600000, max_population: 800000, commerce: 480, farming: 480, defense: 580, traits: { port: false, horse_production: false } },

  // Jizhou (Yuan Shao / neutral)
  { id: 'ye',        name_kr: '업',   region_name: '기주', owner_force_id: 'neutral',   gold: 20000, rice: 150000, population: 400000, max_population: 600000, commerce: 360, farming: 360, defense: 390, traits: {} },
  { id: 'nan_pi',    name_kr: '남피', region_name: '기주', owner_force_id: 'yuan_shao', gold: 15000, rice: 120000, population: 350000, max_population: 500000, commerce: 320, farming: 330, defense: 360, traits: {} },

  // Yanzhou (Cao Cao)
  { id: 'chen_liu',  name_kr: '진류', region_name: '연주', owner_force_id: 'cao_cao',   gold: 5000,  rice: 80000,  population: 250000, max_population: 400000, commerce: 320, farming: 330, defense: 360, traits: {} },
  { id: 'pu_yang',   name_kr: '복양', region_name: '연주', owner_force_id: 'neutral',   gold: 8000,  rice: 100000, population: 300000, max_population: 450000, commerce: 300, farming: 310, defense: 330, traits: {} },

  // Jingzhou (Liu Biao territory, but 190 = contested)
  { id: 'xiang_yang', name_kr: '양양', region_name: '형주', owner_force_id: 'neutral',  gold: 30000, rice: 200000, population: 450000, max_population: 650000, commerce: 400, farming: 400, defense: 420, traits: { port: true } },
  { id: 'wan',        name_kr: '완',   region_name: '형주', owner_force_id: 'yuan_shu',  gold: 25000, rice: 180000, population: 400000, max_population: 550000, commerce: 350, farming: 360, defense: 380, traits: {} },
  { id: 'chang_sha',  name_kr: '장사', region_name: '형주', owner_force_id: 'sun_jian',  gold: 10000, rice: 80000,  population: 200000, max_population: 350000, commerce: 260, farming: 320, defense: 300, traits: {} },

  // Qingzhou (Liu Bei)
  { id: 'ping_yuan', name_kr: '평원', region_name: '청주', owner_force_id: 'liu_bei',   gold: 3000,  rice: 50000,  population: 150000, max_population: 280000, commerce: 250, farming: 260, defense: 260, traits: {} },

  // Youzhou (Gongsun Zan, simplified as neutral)
  { id: 'bei_ping',  name_kr: '북평', region_name: '유주', owner_force_id: 'neutral',   gold: 8000,  rice: 90000,  population: 200000, max_population: 350000, commerce: 230, farming: 240, defense: 310, traits: { horse_production: true } },
];

// ─── Map Connections (10 links, bidirectional) ─────────────────────────────────
// [city_a, city_b, distance_days, terrain_type, is_chokepoint]
export const seedMapConnections = [
  // Luoyang hub (Dong Zhuo's defense perimeter)
  ['luo_yang', 'chang_an',  10, 'Mountain', true],   // Hulao/Hangu pass corridor
  ['luo_yang', 'chen_liu',   5, 'Plains',   true],   // Hulao Gate (호로관)
  ['luo_yang', 'wan',        8, 'Mountain', false],   // southern approach

  // Hebei region
  ['ye',       'nan_pi',     4, 'Plains',   false],
  ['nan_pi',   'ping_yuan',  6, 'Plains',   false],
  ['ping_yuan','bei_ping',  12, 'Plains',   false],

  // Central plains & Jingzhou
  ['chen_liu', 'pu_yang',    3, 'Plains',   false],
  ['chen_liu', 'wan',        7, 'Plains',   false],   // Cao Cao / Yuan Shu border
  ['wan',      'xiang_yang', 6, 'River',    false],   // Han River crossing
  ['xiang_yang','chang_sha',10, 'River',    false],   // Yangtze approach
];

// Also populate legacy edges table for backward compatibility
export const seedEdges = seedMapConnections.map(([a, b, dist, terrain, choke]) => [a, b, dist, terrain.toLowerCase(), choke]);

// ─── Officers (~22, fixed stats, approximate not Koei-exact) ───────────────────
// Stats are self-derived ranges on 1-100 scale. No values copied from commercial games.
// Fields: id, name_kr, birth_year, lifespan, stats(lea/war/int/pol/cha),
//         ambition, duty, compatibility, force_id, city_id, rank,
//         is_playable, is_historical, traits, relationships

export const seedOfficers = [
  // ── Dong Zhuo faction (Luoyang) ──
  { id: 'dong_zhuo',  name_kr: '동탁', birth_year: 139, lifespan: 56,
    ldr: 88, war: 83, int_stat: 66, pol: 16, chr: 34,
    ambition: 98, duty: 10, compatibility: 2,
    force_id: 'dong_zhuo', city_id: 'luo_yang', rank: 1,
    is_playable: false, is_historical: true,
    traits: ['Tyrant', 'Intimidator'],
    relationships: {} },

  { id: 'lu_bu',      name_kr: '여포', birth_year: 161, lifespan: 38,
    ldr: 93, war: 99, int_stat: 28, pol: 14, chr: 42,
    ambition: 96, duty: 6,  compatibility: 4,
    force_id: 'dong_zhuo', city_id: 'luo_yang', rank: 3,
    is_playable: true, is_historical: true,
    traits: ['Flying General', 'Peerless Warrior'],
    relationships: { adoptive_father: 'dong_zhuo' } },

  { id: 'li_ru',      name_kr: '이유', birth_year: 145, lifespan: 55,
    ldr: 58, war: 22, int_stat: 92, pol: 76, chr: 38,
    ambition: 72, duty: 78, compatibility: 6,
    force_id: 'dong_zhuo', city_id: 'luo_yang', rank: 4,
    is_playable: false, is_historical: true,
    traits: ['Schemer'],
    relationships: {} },

  { id: 'hua_xiong',  name_kr: '화웅', birth_year: 155, lifespan: 36,
    ldr: 80, war: 91, int_stat: 38, pol: 22, chr: 44,
    ambition: 48, duty: 62, compatibility: 5,
    force_id: 'dong_zhuo', city_id: 'luo_yang', rank: 5,
    is_playable: false, is_historical: true,
    traits: ['Vanguard'],
    relationships: {} },

  // ── Cao Cao faction (Chenliu) ──
  { id: 'cao_cao',    name_kr: '조조', birth_year: 155, lifespan: 66,
    ldr: 96, war: 74, int_stat: 92, pol: 93, chr: 95,
    ambition: 94, duty: 68, compatibility: 24,
    force_id: 'cao_cao', city_id: 'chen_liu', rank: 1,
    is_playable: true, is_historical: true,
    traits: ['Hero of Chaos', 'Poet'],
    relationships: {} },

  { id: 'xiahou_dun', name_kr: '하후돈', birth_year: 157, lifespan: 63,
    ldr: 88, war: 89, int_stat: 58, pol: 68, chr: 84,
    ambition: 58, duty: 94, compatibility: 26,
    force_id: 'cao_cao', city_id: 'chen_liu', rank: 4,
    is_playable: true, is_historical: true,
    traits: ['One-Eyed General'],
    relationships: { cousin: 'cao_cao' } },

  { id: 'xiahou_yuan', name_kr: '하후연', birth_year: 160, lifespan: 60,
    ldr: 84, war: 87, int_stat: 52, pol: 42, chr: 78,
    ambition: 48, duty: 92, compatibility: 26,
    force_id: 'cao_cao', city_id: 'chen_liu', rank: 5,
    is_playable: true, is_historical: true,
    traits: ['Swift Cavalry'],
    relationships: { cousin: 'cao_cao' } },

  { id: 'xun_yu',     name_kr: '순욱', birth_year: 163, lifespan: 50,
    ldr: 52, war: 12, int_stat: 95, pol: 98, chr: 88,
    ambition: 38, duty: 98, compatibility: 28,
    force_id: 'cao_cao', city_id: 'chen_liu', rank: 4,
    is_playable: true, is_historical: true,
    traits: ['Royal Advisor', 'Kingmaker'],
    relationships: {} },

  // ── Liu Bei faction (Pingyuan) ──
  { id: 'liu_bei',    name_kr: '유비', birth_year: 161, lifespan: 63,
    ldr: 76, war: 72, int_stat: 74, pol: 78, chr: 98,
    ambition: 82, duty: 94, compatibility: 76,
    force_id: 'liu_bei', city_id: 'ping_yuan', rank: 1,
    is_playable: true, is_historical: true,
    traits: ['Benevolent Ruler', 'Survivor'],
    relationships: { sworn_brother: ['guan_yu', 'zhang_fei'] } },

  { id: 'guan_yu',    name_kr: '관우', birth_year: 160, lifespan: 60,
    ldr: 94, war: 96, int_stat: 74, pol: 60, chr: 92,
    ambition: 58, duty: 99, compatibility: 76,
    force_id: 'liu_bei', city_id: 'ping_yuan', rank: 4,
    is_playable: true, is_historical: true,
    traits: ['God of War', 'Righteous'],
    relationships: { sworn_brother: ['liu_bei', 'zhang_fei'] } },

  { id: 'zhang_fei',  name_kr: '장비', birth_year: 162, lifespan: 59,
    ldr: 84, war: 97, int_stat: 32, pol: 24, chr: 46,
    ambition: 42, duty: 92, compatibility: 76,
    force_id: 'liu_bei', city_id: 'ping_yuan', rank: 5,
    is_playable: true, is_historical: true,
    traits: ['Thunder Voice', 'Reckless Valor'],
    relationships: { sworn_brother: ['liu_bei', 'guan_yu'] } },

  // ── Sun Jian faction (Changsha) ──
  { id: 'sun_jian',   name_kr: '손견', birth_year: 155, lifespan: 37,
    ldr: 92, war: 89, int_stat: 72, pol: 72, chr: 86,
    ambition: 82, duty: 84, compatibility: 124,
    force_id: 'sun_jian', city_id: 'chang_sha', rank: 1,
    is_playable: true, is_historical: true,
    traits: ['Tiger of Jiangdong'],
    relationships: {} },

  { id: 'huang_gai',  name_kr: '황개', birth_year: 150, lifespan: 65,
    ldr: 78, war: 82, int_stat: 64, pol: 58, chr: 74,
    ambition: 48, duty: 94, compatibility: 126,
    force_id: 'sun_jian', city_id: 'chang_sha', rank: 5,
    is_playable: false, is_historical: true,
    traits: ['Iron Will'],
    relationships: {} },

  { id: 'cheng_pu',   name_kr: '정보', birth_year: 151, lifespan: 64,
    ldr: 82, war: 78, int_stat: 68, pol: 64, chr: 76,
    ambition: 48, duty: 92, compatibility: 126,
    force_id: 'sun_jian', city_id: 'chang_sha', rank: 5,
    is_playable: false, is_historical: true,
    traits: ['Veteran General'],
    relationships: {} },

  // ── Yuan Shao faction (Nanpi) ──
  { id: 'yuan_shao',  name_kr: '원소', birth_year: 154, lifespan: 48,
    ldr: 80, war: 68, int_stat: 72, pol: 74, chr: 88,
    ambition: 86, duty: 42, compatibility: 140,
    force_id: 'yuan_shao', city_id: 'nan_pi', rank: 1,
    is_playable: true, is_historical: true,
    traits: ['Noble Birth', 'Indecisive'],
    relationships: { half_brother: 'yuan_shu' } },

  { id: 'yan_liang',  name_kr: '안량', birth_year: 155, lifespan: 46,
    ldr: 80, war: 92, int_stat: 42, pol: 28, chr: 48,
    ambition: 48, duty: 72, compatibility: 142,
    force_id: 'yuan_shao', city_id: 'nan_pi', rank: 5,
    is_playable: false, is_historical: true,
    traits: ['Fierce Blade'],
    relationships: {} },

  { id: 'wen_chou',   name_kr: '문추', birth_year: 155, lifespan: 46,
    ldr: 78, war: 93, int_stat: 26, pol: 22, chr: 44,
    ambition: 48, duty: 68, compatibility: 142,
    force_id: 'yuan_shao', city_id: 'nan_pi', rank: 5,
    is_playable: false, is_historical: true,
    traits: ['Fierce Blade'],
    relationships: {} },

  // ── Yuan Shu faction (Wan) ──
  { id: 'yuan_shu',   name_kr: '원술', birth_year: 155, lifespan: 44,
    ldr: 64, war: 58, int_stat: 62, pol: 52, chr: 68,
    ambition: 94, duty: 22, compatibility: 136,
    force_id: 'yuan_shu', city_id: 'wan', rank: 1,
    is_playable: false, is_historical: true,
    traits: ['Arrogant Noble', 'Self-Proclaimed Emperor'],
    relationships: { half_brother: 'yuan_shao' } },

  { id: 'ji_ling',    name_kr: '기령', birth_year: 152, lifespan: 50,
    ldr: 76, war: 82, int_stat: 44, pol: 32, chr: 48,
    ambition: 48, duty: 74, compatibility: 138,
    force_id: 'yuan_shu', city_id: 'wan', rank: 5,
    is_playable: false, is_historical: true,
    traits: ['Trident Fighter'],
    relationships: {} },

  // ── Ronin / Unaffiliated (scattered across map) ──
  { id: 'diaochan',   name_kr: '초선', birth_year: 172, lifespan: 40,
    ldr: 28, war: 16, int_stat: 78, pol: 82, chr: 98,
    ambition: 62, duty: 48, compatibility: 3,
    force_id: 'ronin', city_id: 'luo_yang', rank: 9,
    is_playable: true, is_historical: true,
    traits: ['Peerless Beauty', 'Schemer'],
    relationships: {} },

  { id: 'zhao_yun',   name_kr: '조운', birth_year: 168, lifespan: 61,
    ldr: 90, war: 94, int_stat: 76, pol: 64, chr: 84,
    ambition: 42, duty: 96, compatibility: 76,
    force_id: 'ronin', city_id: 'bei_ping', rank: 9,
    is_playable: true, is_historical: true,
    traits: ['Dragon of Changshan'],
    relationships: {} },

  // Default ronin for anonymous players
  { id: 'player_default', name_kr: '신규장수', birth_year: 170, lifespan: 60,
    ldr: 70, war: 70, int_stat: 70, pol: 70, chr: 70,
    ambition: 50, duty: 50, compatibility: 75,
    force_id: 'ronin', city_id: 'xiang_yang', rank: 9,
    is_playable: false, is_historical: false,
    traits: [],
    relationships: {} },
];

// ─── Story Arc: 190 Anti-Dong Zhuo (chapter/season) ───────────────────────────
// Big beats are deterministic. LLM only writes small scene flavor.
export const seedStoryArcs = [
  {
    arc_id: '190_anti_dong_zhuo',
    title: '반동탁 연합과 군웅할거의 서막',
    start_year: 190,
    start_month: 1,
    start_day: 1,
    end_stage: 4
  }
];

// Stages are intentionally simple and officer-centric (no ruler fantasy).
export const seedStoryBeats = [
  {
    arc_id: '190_anti_dong_zhuo',
    stage: 1,
    title: '완으로 향하다',
    objective: '190년의 소문이 중원에 번진다. 먼저 [완]으로 이동해 소문의 근원을 잡으세요. (travel 완)',
    trigger_json: { when: 'travel', city: 'wan' },
    effect_json: { set_flag: { arc190_stage: 1 }, reward: { gold: 200, fame: 2 } }
  },
  {
    arc_id: '190_anti_dong_zhuo',
    stage: 2,
    title: '낙양의 동향',
    objective: '완에서 낙양의 동향을 캐내세요. (spy 낙양)',
    trigger_json: { when: 'spy', city: 'luo_yang' },
    effect_json: { set_flag: { arc190_stage: 2 }, reward: { gold: 260, fame: 3 } }
  },
  {
    arc_id: '190_anti_dong_zhuo',
    stage: 3,
    title: '낙양으로',
    objective: '결정적인 소문을 확인했습니다. 직접 [낙양]으로 가서 상황을 보세요. (travel 낙양)',
    trigger_json: { when: 'travel', city: 'luo_yang' },
    effect_json: { set_flag: { arc190_stage: 3 }, reward: { gold: 380, fame: 4 } }
  },
  {
    arc_id: '190_anti_dong_zhuo',
    stage: 4,
    title: '연합 해산',
    objective: '연합은 한데 모이지 못하고 흩어진다. 당신은 오늘을 살아남아 이름을 남길 길을 택해야 한다. (next로 하루를 넘기면 결말 정리)',
    trigger_json: { when: 'next', city: 'luo_yang', require_stage: 3 },
    effect_json: { set_flag: { arc190_stage: 4, arc190_ended: true }, reward: { fame: 12 } }
  }
];

// ─── Items (starting catalog, extends existing SHOP_ITEMS) ─────────────────────
export const seedItems = [
  // Shop core (easy + meaningful)
  { item_id: 'med_small', name: '약(기혈환)', type: 'consumable', rarity: 'common', slot: null, stackable: true, max_stack: 99, unique_key: null, is_shop: true, price: 120, sell_price: 60,
    description: '다음 휴식(rest) 회복량 +30 (use med_small)',
    effects: { kind: 'rest_bonus_once', amount: 30 } },

  // Drop-only small consumable (used for episode rewards)
  { item_id: 'med_tiny', name: '약(약초)', type: 'consumable', rarity: 'common', slot: null, stackable: true, max_stack: 99, unique_key: null, is_shop: false, price: 0, sell_price: 0,
    description: '다음 휴식(rest) 회복량 +15 (use med_tiny)',
    effects: { kind: 'rest_bonus_once', amount: 15 } },

  { item_id: 'mount_basic', name: '군마', type: 'equipment', rarity: 'common', slot: 'mount', stackable: false, max_stack: 1, unique_key: null, is_shop: true, price: 500, sell_price: 250,
    description: '이동(travel) AP 비용 20% 감소(최저 5 AP)',
    effects: { kind: 'travel_discount', pct: 0.2, min_ap: 5 } },

  { item_id: 'weapon_basic', name: '보검', type: 'equipment', rarity: 'common', slot: 'weapon', stackable: false, max_stack: 1, unique_key: null, is_shop: true, price: 800, sell_price: 400,
    description: '전투 공격 +2 (향후 전투 고도화 시 반영)',
    effects: { kind: 'battle_attack_flat', amount: 2 } },

  // Books (apply immediately; not stored)
  { item_id: 'book_int', name: '서적(지력)', type: 'book', rarity: 'common', slot: null, stackable: false, max_stack: 1, unique_key: null, is_shop: true, price: 300, sell_price: 0,
    description: '구매 즉시 INT +1 (최대 99)',
    effects: { kind: 'stat_up', stat: 'int_stat', amount: 1, cap: 99 } },
  { item_id: 'book_pol', name: '서적(정치)', type: 'book', rarity: 'common', slot: null, stackable: false, max_stack: 1, unique_key: null, is_shop: true, price: 300, sell_price: 0,
    description: '구매 즉시 POL +1 (최대 99)',
    effects: { kind: 'stat_up', stat: 'pol', amount: 1, cap: 99 } },
  { item_id: 'book_chr', name: '서적(매력)', type: 'book', rarity: 'common', slot: null, stackable: false, max_stack: 1, unique_key: null, is_shop: true, price: 300, sell_price: 0,
    description: '구매 즉시 CHR +1 (최대 99)',
    effects: { kind: 'stat_up', stat: 'chr', amount: 1, cap: 99 } },
  { item_id: 'book_war', name: '서적(무력)', type: 'book', rarity: 'common', slot: null, stackable: false, max_stack: 1, unique_key: null, is_shop: true, price: 300, sell_price: 0,
    description: '구매 즉시 WAR +1 (최대 99)',
    effects: { kind: 'stat_up', stat: 'war', amount: 1, cap: 99 } },
  { item_id: 'book_ldr', name: '서적(통솔)', type: 'book', rarity: 'common', slot: null, stackable: false, max_stack: 1, unique_key: null, is_shop: true, price: 300, sell_price: 0,
    description: '구매 즉시 LDR +1 (최대 99)',
    effects: { kind: 'stat_up', stat: 'ldr', amount: 1, cap: 99 } },

  // Unique (not sold in regular shop; appear via story/events later)
  { item_id: 'mount_red_hare', name: '명마: 적토', type: 'equipment', rarity: 'legendary', slot: 'mount', stackable: false, max_stack: 1, unique_key: 'red_hare', is_shop: false, price: 0, sell_price: 0,
    description: '전설의 명마. 이동 AP 40% 감소(최저 4 AP).',
    effects: { kind: 'travel_discount', pct: 0.4, min_ap: 4 } },
  { item_id: 'weapon_qinggang', name: '명검: 청강', type: 'equipment', rarity: 'legendary', slot: 'weapon', stackable: false, max_stack: 1, unique_key: 'qinggang', is_shop: false, price: 0, sell_price: 0,
    description: '전설의 보검. 전투 공격 +6 (향후 전투 고도화 시 반영).',
    effects: { kind: 'battle_attack_flat', amount: 6 } },
];

// ─── Lore Entries (RAG / world knowledge) ─────────────────────────────────────
// Goal: factual anchors for narration. Keep compact, public-domain, non-Koei.
export const seedLoreEntries = [
  // Core events / chapter anchors
  {
    id: 'event:190_anti_dong_zhuo:overview',
    kind: 'event',
    title: '190년 반동탁 연합',
    tags: ['190', '반동탁', '연합', 'dong_zhuo', 'luo_yang', 'chang_an', '190_anti_dong_zhuo'],
    body:
      '190년, 동탁이 낙양의 권력을 장악하면서 각지 군벌들이 “동탁 토벌”을 명분으로 연합을 꾸린다.\n' +
      '게임에서는 이 흐름을 “큰 줄기(챕터 비트)”로 고정하고, 플레이어는 장수 관점에서 정보 수집/이동/인맥을 통해 개입한다.',
    source: 'seed:story'
  },
  // Beat cards (story_beats stage 1-4): factual summary + practical play hints.
  // These use the same id format as auto-seeded beats so the curated text wins via UPSERT.
  {
    id: 'event:190_anti_dong_zhuo:1',
    kind: 'event',
    title: '비트1: 완으로 향하라',
    tags: ['190_anti_dong_zhuo', 'stage:1', '완', 'wan', '이동', 'travel'],
    body:
      '큰 줄기(190) 1단계는 “완(wan) 도착”이다.\n' +
      '의미: 중원-남방 연결의 요지에 들어가 소문을 잡는 단계.\n' +
      '플레이 힌트: travel wan → (도착 후) story로 다음 목표 확인.',
    source: 'seed:beat'
  },
  {
    id: 'event:190_anti_dong_zhuo:2',
    kind: 'event',
    title: '비트2: 낙양을 정찰하라',
    tags: ['190_anti_dong_zhuo', 'stage:2', '낙양', 'luo_yang', '정찰', 'spy'],
    body:
      '큰 줄기(190) 2단계는 “낙양 정찰(spy)”이다.\n' +
      '의미: 권력 중심(낙양)의 동향을 확인해 다음 이동을 안전하게 만든다.\n' +
      '플레이 힌트: spy luo_yang → story로 다음 목표 확인.',
    source: 'seed:beat'
  },
  {
    id: 'event:190_anti_dong_zhuo:3',
    kind: 'event',
    title: '비트3: 낙양에 도착하라',
    tags: ['190_anti_dong_zhuo', 'stage:3', '낙양', 'luo_yang', '도착', 'travel'],
    body:
      '큰 줄기(190) 3단계는 “낙양 도착”이다.\n' +
      '의미: 사건의 중심부에 발을 들이는 단계. 여기서부터 작은 선택(에피소드/유니크)이 자주 뜬다.\n' +
      '플레이 힌트: travel luo_yang → end_turn로 다음 날을 넘기면 챕터 종료 비트가 열린다.',
    source: 'seed:beat'
  },
  {
    id: 'event:190_anti_dong_zhuo:4',
    kind: 'event',
    title: '비트4: 연합은 해산했다',
    tags: ['190_anti_dong_zhuo', 'stage:4', '챕터', '엔딩', 'end_turn'],
    body:
      '큰 줄기(190) 4단계는 “연합 해산(챕터 종료)”이다.\n' +
      '의미: 시즌/챕터의 엔드게임 판정이 내려가고, 열전(기록)에 남는다.\n' +
      '플레이 힌트: 낙양 도착 후 end_turn을 한 번 실행하면 종료 트리거가 걸린다.',
    source: 'seed:beat'
  },
  {
    id: 'event:190_anti_dong_zhuo:luo_yang',
    kind: 'event',
    title: '낙양: 권력의 중심',
    tags: ['낙양', 'luo_yang', 'dong_zhuo', '사예', '190_anti_dong_zhuo'],
    body:
      '낙양은 수도권의 상징이며, 동탁이 권력을 틀어쥔 핵심 거점으로 묘사된다.\n' +
      '플레이 루프: “정찰(spy)로 동향 파악 → 이동(travel)로 접근 → 턴 종료(end_turn)로 큰 줄기 진행”이 기본 동선이다.',
    source: 'seed:story'
  },
  {
    id: 'event:190_anti_dong_zhuo:hulao',
    kind: 'event',
    title: '관문: 호로관/함곡관',
    tags: ['관문', '호로관', '함곡관', 'luo_yang', 'chang_an', 'is_chokepoint', '190_anti_dong_zhuo'],
    body:
      '낙양-장안 축선에는 관문이 존재해 병목이 된다.\n' +
      'DB에서 is_chokepoint는 “이 길을 지나야 하는 느낌”을 만드는 전략적 표식이며, 향후 보급/차단 로직의 기반이 된다.',
    source: 'seed:world190'
  },

  // Faction briefs (officer-centric framing)
  {
    id: 'faction:dong_zhuo',
    kind: 'faction',
    title: '동탁 세력',
    tags: ['dong_zhuo', '동탁', '낙양', 'luo_yang', '사예'],
    body:
      '동탁은 낙양을 장악한 강권 세력으로 묘사된다.\n' +
      '플레이어 관점: 정면 충돌보다 “정찰/이동/관계”로 위험을 피하며 큰 줄기를 진행하는 편이 안전하다.',
    source: 'seed:world190'
  },
  {
    id: 'faction:cao_cao',
    kind: 'faction',
    title: '조조 세력',
    tags: ['cao_cao', '조조', '진류', 'chen_liu', '연주'],
    body:
      '조조는 중원에서 기회를 노리는 실력파로 묘사된다.\n' +
      '플레이어 관점: 전공/명성(fame)을 쌓아 “유니크 소문/에피소드 선택지”의 폭을 넓히는 것이 핵심이다.',
    source: 'seed:world190'
  },
  {
    id: 'faction:liu_bei',
    kind: 'faction',
    title: '유비 세력',
    tags: ['liu_bei', '유비', '평원', 'ping_yuan', '청주'],
    body:
      '유비는 명분과 인망으로 버티는 세력으로 묘사된다.\n' +
      '플레이어 관점: “사교/방문/선물”로 관계를 쌓는 루프가 잘 맞는다.',
    source: 'seed:world190'
  },
  {
    id: 'faction:sun_jian',
    kind: 'faction',
    title: '손견 세력',
    tags: ['sun_jian', '손견', '장사', 'chang_sha', '형주'],
    body:
      '손견은 강동의 기세를 대표하는 인물로 묘사된다.\n' +
      '플레이어 관점: 이동 루프가 잦아질 수 있으니 군마/명마(이동 AP 할인) 계열 장비가 체감이 크다.',
    source: 'seed:world190'
  },

  // Officer briefs + relationship anchors (public domain facts + game framing)
  {
    id: 'officer:liu_bei',
    kind: 'officer',
    title: '유비',
    tags: ['liu_bei', '유비', '현덕', '관우', '장비', '의형제', '평원', 'ping_yuan', 'liu_bei'],
    body:
      '유비(현덕)는 난세에서 인망을 모으는 인물로 자주 그려진다.\n' +
      '관계: 관우·장비와 의형제 서사가 유명하다.\n' +
      '게임 포인트: “군주”가 아니라 ‘한 장수’로 플레이하므로, 유비는 세계의 NPC/데이터로서만 사실 앵커를 제공한다.',
    source: 'seed:world190'
  },
  {
    id: 'officer:guan_yu',
    kind: 'officer',
    title: '관우',
    tags: ['guan_yu', '관우', '운장', '유비', '장비', '의리', 'ping_yuan'],
    body:
      '관우(운장)는 의리와 무용의 상징으로 자주 묘사된다.\n' +
      '관계: 유비·장비와 깊은 인연이 있는 것으로 널리 알려져 있다.\n' +
      '게임 포인트: 높은 WAR 계열 장수는 결투/특수전투 분기에서 체감이 크다.',
    source: 'seed:world190'
  },
  {
    id: 'officer:zhang_fei',
    kind: 'officer',
    title: '장비',
    tags: ['zhang_fei', '장비', '익덕', '유비', '관우', '의형제', 'ping_yuan'],
    body:
      '장비(익덕)는 호방하고 거친 기질의 무장으로 자주 묘사된다.\n' +
      '게임 포인트: 성격/히든 스탯을 향후 “말투/에피소드 후크”에 반영할 수 있다.',
    source: 'seed:world190'
  },
  {
    id: 'officer:cao_cao',
    kind: 'officer',
    title: '조조',
    tags: ['cao_cao', '조조', '맹덕', '진류', 'chen_liu', '연주'],
    body:
      '조조(맹덕)는 현실적이고 결단이 빠른 인물로 자주 묘사된다.\n' +
      '게임 포인트: “큰 줄기”는 고정, “작은 에피소드”는 플레이어 선택으로 흔들리게 설계한다.',
    source: 'seed:world190'
  },
  {
    id: 'officer:dong_zhuo',
    kind: 'officer',
    title: '동탁',
    tags: ['dong_zhuo', '동탁', '낙양', 'luo_yang', '사예'],
    body:
      '동탁은 강권과 공포로 권력을 장악한 인물로 자주 묘사된다.\n' +
      '게임 포인트: 초반 “낙양 정찰/도착” 비트는 동탁의 존재감을 사실 앵커로 삼는다.',
    source: 'seed:world190'
  },
  {
    id: 'officer:lu_bu',
    kind: 'officer',
    title: '여포',
    tags: ['lu_bu', '여포', '봉선', '동탁', 'luo_yang'],
    body:
      '여포(봉선)는 무용의 상징처럼 묘사되는 인물이다.\n' +
      '게임 포인트: “전투”는 결정론으로 처리하고, AI는 묘사만 담당한다(오판정 방지).',
    source: 'seed:world190'
  },

  // Relationship cards: directed/typed anchors for RAG. Keep public-domain and neutral wording.
  {
    id: 'relationship:sworn_brothers',
    kind: 'relationship',
    title: '의형제: 유비·관우·장비',
    tags: ['relationship', '의형제', '도원결의', 'liu_bei', 'guan_yu', 'zhang_fei', '유비', '관우', '장비', 'ping_yuan'],
    body:
      '유비·관우·장비는 의형제로 묶이는 서사가 널리 알려져 있다.\n' +
      '게임 포인트: 이 관계는 “세계지식 앵커”로만 쓰고, 플레이어가 누군가의 신하/주군이 되는 서사는 강제하지 않는다.\n' +
      '활용: visit/gift/banquet 에피소드에서 “친밀도/갈등” 후크를 자연스럽게 붙일 수 있다.',
    source: 'seed:relation'
  },
  {
    id: 'relationship:adoptive_father:dong_zhuo:lu_bu',
    kind: 'relationship',
    title: '관계: 동탁-여포(양부자)',
    tags: ['relationship', '양부자', 'dong_zhuo', 'lu_bu', '동탁', '여포', '낙양', 'luo_yang'],
    body:
      '동탁과 여포는 “양부자” 관계로 자주 묘사된다.\n' +
      '게임 포인트: “큰 줄기”는 고정이지만, 작은 선택(에피소드/퀘스트)은 이런 인간관계를 재료로 더 설득력 있게 만든다.',
    source: 'seed:relation'
  },
  {
    id: 'relationship:half_brothers:yuan_shao:yuan_shu',
    kind: 'relationship',
    title: '관계: 원소-원술(형제/경쟁)',
    tags: ['relationship', '형제', '원소', '원술', 'yuan_shao', 'yuan_shu', '남피', '완', 'nan_pi', 'wan'],
    body:
      '원소와 원술은 혈연 관계로 묶이지만, 정치적 경쟁 구도로도 자주 그려진다.\n' +
      '게임 포인트: 세력 대립은 “배경”으로 두고, 플레이어는 장수 관점에서 정보/이동/인맥으로 살아남는 흐름을 우선한다.',
    source: 'seed:relation'
  },

  // Location briefs (names + practical play hints)
  {
    id: 'city:luo_yang',
    kind: 'city',
    title: '낙양',
    tags: ['luo_yang', '낙양', '사예', '수도권', 'dong_zhuo'],
    body:
      '낙양은 수도권의 상징이며, 동탁 세력의 중심 거점으로 설정되어 있다.\n' +
      '플레이 힌트: spy 낙양 → travel 낙양 → end_turn 로 “큰 줄기”를 밀어붙일 수 있다.',
    source: 'seed:world190'
  },
  {
    id: 'city:wan',
    kind: 'city',
    title: '완',
    tags: ['wan', '완', '형주', 'yuan_shu'],
    body:
      '완은 중원과 남방을 잇는 요지로 설정되어 있다.\n' +
      '플레이 힌트: 초반 정보 수집/이동 동선에서 자주 경유하게 된다.',
    source: 'seed:world190'
  },
];
