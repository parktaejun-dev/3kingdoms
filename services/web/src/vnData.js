export function vnDefaultRun() {
  return {
    version: 1,
    // Core identity
    hero: 'xuchu',
    // Story state (kept minimal for MVP)
    alignment: 'neutral', // king | tyrant | neutral
    fame: 0,
    infamy: 0,
    trust: 0,
    // Progress
    sceneId: 'pick',
    history: [],
    // Choice effects apply to next battle only.
    nextBattleMods: { seat1: {}, seat2: {} },
    // Last battle results
    lastBattle: null
  };
}

export function vnScenes() {
  // MVP Act1 (Guandu) - 8 scenes + 3 battles.
  return [
    {
      id: 'pick',
      type: 'pick',
      title: '장수 선택',
      body: '관도대전(Act 1) · 10분 런\n장수를 선택하면 이야기와 전투 스타일이 바뀝니다.'
    },
    {
      id: 's1_intro',
      type: 'story',
      title: '건안 5년, 관도',
      body:
        '건안 5년(200년). 관도.\n조조 2만 vs 원소 10만.\n역사는 고정이지만, 당신의 선택은 전장을 바꾼다.',
      choices: [{ id: 'to_s2', label: '계속', effects: {}, next: 's2_choice_1' }]
    },
    {
      id: 's2_choice_1',
      type: 'story',
      title: '백마의 선봉',
      body: '원소의 선봉이 몰려온다. 지금 무엇을 택하겠는가?',
      choices: [
        {
          id: 'defend',
          label: '방어를 굳힌다 (아군 방어 +20%)',
          effects: { alignment: 'king', trust: +10, nextBattleMods: { seat1: { defPct: +0.2 } } },
          next: 'b1_skirmish'
        },
        {
          id: 'push',
          label: '정면 돌파 (아군 공격 +15%)',
          effects: { alignment: 'tyrant', infamy: +10, nextBattleMods: { seat1: { atkPct: +0.15 } } },
          next: 'b1_skirmish'
        },
        {
          id: 'arson',
          label: '기습 준비 (적 체력 -20%)',
          effects: { alignment: 'neutral', fame: +5, nextBattleMods: { seat2: { hpPct: -0.2 } } },
          next: 'b1_skirmish'
        }
      ]
    },
    {
      id: 'b1_skirmish',
      type: 'battle',
      title: '전투 1: 조우전',
      body: '선택의 결과를 전투로 검증한다.',
      // Battle templates are kept very small for MVP.
      battle: {
        p1: [{ unitId: '$HERO', x: 1, y: 2 }, { unitId: 'xunyu', x: 2, y: 2 }],
        p2: [{ unitId: 'dianwei', x: 1, y: 0 }, { unitId: 'zhangliao', x: 2, y: 0 }]
      },
      next: 's3_after_b1'
    },
    {
      id: 's3_after_b1',
      type: 'story',
      title: '전투 후',
      body: '승리든 패배든, 원소의 본대는 멈추지 않는다.\n그리고 밀서가 도착한다.',
      choices: [
        {
          id: 'burn_letter',
          label: '밀서를 태운다 (명성 +10, 다음 전투 적 공격 -10%)',
          effects: { fame: +10, trust: +10, nextBattleMods: { seat2: { atkPct: -0.1 } } },
          next: 'b2_vanguard'
        },
        {
          id: 'report',
          label: '조조에게 보고한다 (신뢰 +20, 아군 체력 +10%)',
          effects: { trust: +20, nextBattleMods: { seat1: { hpPct: +0.1 } } },
          next: 'b2_vanguard'
        },
        {
          id: 'take_bribe',
          label: '받아들인다 (골드 대신 악명 +20, 적 체력 -10%)',
          effects: { infamy: +20, nextBattleMods: { seat2: { hpPct: -0.1 } } },
          next: 'b2_vanguard'
        }
      ]
    },
    {
      id: 'b2_vanguard',
      type: 'battle',
      title: '전투 2: 전초전',
      body: '전열이 무너지면 관도는 끝난다.',
      battle: {
        p1: [{ unitId: '$HERO', x: 1, y: 2 }, { unitId: 'dianwei', x: 1, y: 1 }],
        p2: [{ unitId: 'zhangliao', x: 2, y: 0 }, { unitId: 'xunyu', x: 1, y: 0 }]
      },
      next: 's4_anchor'
    },
    {
      id: 's4_anchor',
      type: 'story',
      title: '관도, 결전',
      body: '관도.\n양군이 대치한다.\n결전의 방식은 하나가 아니다.',
      choices: [
        {
          id: 'burn_wuchao',
          label: '오소 화공 (적 체력 -30%, 악명 +30)',
          effects: { infamy: +30, nextBattleMods: { seat2: { hpPct: -0.3 } } },
          next: 'b3_guandu'
        },
        {
          id: 'limited_fire',
          label: '군량만 태운다 (적 체력 -15%, 명성 +20)',
          effects: { fame: +20, nextBattleMods: { seat2: { hpPct: -0.15 } } },
          next: 'b3_guandu'
        },
        {
          id: 'refuse',
          label: '정공법 (아군 공격 +10%, 명성 +30)',
          effects: { fame: +30, nextBattleMods: { seat1: { atkPct: +0.1 } } },
          next: 'b3_guandu'
        }
      ]
    },
    {
      id: 'b3_guandu',
      type: 'battle',
      title: '전투 3: 관도대전',
      body: '전쟁의 결말이 결정된다.',
      battle: {
        p1: [{ unitId: '$HERO', x: 1, y: 2 }, { unitId: 'xunyu', x: 2, y: 2 }, { unitId: 'dianwei', x: 1, y: 1 }],
        p2: [{ unitId: 'dianwei', x: 1, y: 0 }, { unitId: 'zhangliao', x: 2, y: 0 }, { unitId: 'xunyu', x: 1, y: 0 }]
      },
      next: 's5_wrap'
    },
    {
      id: 's5_wrap',
      type: 'wrap',
      title: '결산',
      body: '연대기에 기록한다.',
      choices: [
        { id: 'retry_choice', label: '다른 선택으로 다시', effects: { resetTo: 's2_choice_1' }, next: 's2_choice_1' },
        { id: 'new_run', label: '새 런', effects: { resetAll: true }, next: 'pick' }
      ]
    }
  ];
}

