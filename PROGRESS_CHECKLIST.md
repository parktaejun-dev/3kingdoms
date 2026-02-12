# 적벽 터미널 진행사항 체크리스트 (기획서 기준)
기준일: 2026-02-10

이 문서는 `/Users/parktaejun/Downloads/삼국지 장수제 텍스트 머드 게임 기획.md`의 “원샷 출시안” 범위를 기준으로,
현재 구현 상태를 `완료/부분/미구현` 체크리스트로 추적한다.

표기:
- [x] 완료(동작 확인)
- [~] 부분 구현(프로토타입/제약 있음)
- [ ] 미구현

## 1) 서비스/배포/접속
- [x] 서버 배포: Docker Compose + Nginx 리버스프록시 (외부 80)
- [~] 웹 콘솔: React UI(대시보드/로그/커맨드 패널) + (debug=1에서만) xterm 터미널
- [x] HTTP 환경 호환: `crypto.randomUUID` 미지원(비-HTTPS)에서 동작하도록 클라이언트 UUID 폴백 적용
- [~] 터미널 입력(디버그): 일반 타이핑과 편집키(Backspace/Delete/화살표) 이벤트 중복 처리 제거 (IME는 UI 입력 권장)
- [~] 운영 안정화: nginx upstream DNS resolve 설정 유지 중
- [ ] Blue/Green 배포
- [~] 관측(초기): `GET /api/metrics`(prom-client) 기본 메트릭 + 요청 카운터
- [ ] 관측: Prometheus/Grafana, Sentry, 중앙로그(대시보드/알람/트레이스)
- [ ] 보안 점검(인증/리플레이/결제 위변조 등)

### 현재 포트
- 외부: `80` (nginx)
- 내부(컨테이너): `api 3000`, `web 4173`, `ai 8000`, `postgres 5432`, `redis 6379`

## 2) 플랫폼(텔레그램/웹)
- [~] 웹: 터미널 모드(xterm) + UI 모드(로그/지도/상태/추천 버튼)
- [x] 웹 UI: 한글 IME 입력 안정화(SEND 버튼/Enter), bootstrap 네트워크 오류 시 화이트스크린 방지
- [x] 웹 UI: story 호출 시 “선택지 버튼(choices)” 표시(다음 행동을 클릭으로 진행)
- [x] 웹 UI: 상점/인벤토리 오버레이(구매/사용/목록)
- [~] 텔레그램 봇(초기): 서비스 골격/컨테이너 + `/api/game/chat` 라우팅 + 인라인 버튼(next/story/status/rest 등) (토큰 설정 필요)
- [ ] 텔레그램 Mini App
- [ ] 일반 웹(계정/세션/보안)

## 3) 게임 루프/신분(장수제)
- [x] 장수 선택 시작(Officer Pick): `GET /api/officers/available` + `bootstrap(officerId)`
- [x] 재야(Ronin) 시작/플레이어 생성: `bootstrap` (재야로 시작 옵션)
- [x] 군주/관직 루프 폐기: `pledge`, `request_governor`, 태수/도독/군주 시스템은 “장수 1인 퀘스트+레벨업” 방향과 충돌하여 비활성화
- [ ] (대체) 퀘스트/챕터 기반 “세력 선택”은 스토리 비트/선택지로만 제공(운영/관직 없음)

## 4) 능력치/성장/규칙
- [x] 5대 능력치(WAR/INT/POL/CHR/LDR) 기반 수치
- [x] AP 소모 기반 커맨드
- [x] 공적(Merit) / 품관(Rank) 임계치(9/8/5/2) 동작
- [x] 레벨/XP/스킬포인트 + 스킬 해금/장착(LoL 느낌): `skills`, `skill_unlock`, `skill_equip`, `skill_unequip`
- [~] 스탯 성장(초기): 상점 서적(book_*) 구매로 능력치 +1 (최대 99)
- [~] 히든 일부: 충성/상성(compatibility) 등용에 반영 + hidden_stats(ambition/duty/affinity) 컬럼 도입(초기 반영)
- [ ] 히든 스탯(운/야망 등) 본격화
- [ ] 상성/인연/친밀도 전체
- [ ] “모든 커맨드 idempotency key” 완전 적용(현재 HTTP에 Idempotency-Key 지원)

## 5) 시간/경제(서버 주도)
- [x] 1일 tick API: `/api/game/tick/day`
- [x] 1일 tick 시 AP 100 회복(쉬운 플레이)
- [x] 서버 자동 tick(기본 3600초): `GAME_DAY_SECONDS=3600`
- [~] 30일마다 월 수입(간이): 금/쌀 증가
- [ ] 계절/재해/이벤트
- [ ] 30일 시뮬레이터/경제 안정성 게이트

## 6) 지도/이동/안개/첩보
- [x] 노드-엣지(그래프) 맵: `edges` 테이블
- [x] 인접 도시 조회: `map_nearby`
- [x] 인접 이동: `travel`
- [~] 안개: 현재/인접 도시만 `city` 조회 가능
- [x] 첩보: `spy` (INT 기반 정확도 + 노이즈)
- [~] 도시 수: 시드 30개 내외 도시(초기 확장 완료, 계속 확장 예정)
- [ ] 도시 50개 확장 + 지형/관문/랜덤 조우(관문/랜덤 조우는 미구현)

## 7) 커맨드(내정/군사/인사/계략)
- [x] 내정: `cultivate`, `train`, `recruit`, `rest`
- [x] 교류/치안: `visit`, `banquet`, `gift`, `patrol` (관시/도시 치안에 반영)
- [x] 인사: `search`(금/재야 장수 발견), `employ`(재야 장수 등용)
- [x] 상점/아이템: `shop`, `buy <itemId>`, `use <itemId>`, `inventory` (DB `items` 단일 소스 + curated shop)
- [x] 유니크 아이템 기반: `items.unique_key` + `unique_ownership` 테이블 (품목 “품절” 처리 가능)
- [x] 등용 UX 보강: `recruit_rumor` + UI 후보 리스트(`/api/player/:id/employ_candidates`) + 재야 파티(leader_officer_id)
- [x] 개인 오토전투(롤토체스 감각, 초기): `skirmish` (스쿼드 최대 3인 자동 전투 + 보상/드롭 + 1일 1회 제한)
- [~] 인맥/관시: `socialize`로 관계(relationships) 누적, `employ`에 보정 반영(초기)
- [x] 계략/정보: `spy`
- [ ] 치수/상업/외교/포상/이간/화계/설전 등 “전체 커맨드”

### 쉬운 플레이(UX)
- [x] 턴 종료: `end_turn` (하루 진행 + AP/일일 제한 리셋 + 작은 에피소드 선택지 생성)
- [x] 추천/가이드: `next` (시간 진행 없음, 추천 갱신)
- [x] 자동 진행: `auto_day` (재야는 정찰/이동/임관까지 밀어줌)
- [x] 이름 기반 입력(부분): `travel/spy/city/employ`에서 id 또는 한글 이름 허용
- [~] 초반 튜토리얼(퀘스트/가이드): `story_states.flags.story_step` 기반 단계형 목표(초기)
- [~] UI 명령 은닉(장수 행동명): `work(cultivate)`, `calm(patrol)` 별칭 + UI 라벨 적용(초기)

## 8) 전투(ASCII 전술)
- [~] 20x20 ASCII 전투 프로토타입: 시작/상태/이동/공격/대기
- [ ] 병과 상성/지형 보정/사기/진형
- [ ] 일기토(듀얼)
- [ ] 대규모 전투 룸/매칭/동시성

## 9) AI 내러티브/열전
- [x] 행동 로그 기록 + 큐 작업(BullMQ)
- [x] 워커가 AI 미들웨어 호출 후 열전 로그에 narration 업데이트
- [x] 워커가 특정 로그(id) 대상으로 narration 업데이트(자동 진행/동시 입력에도 안전)
- [x] 장수 시점 내러티브 룰: 군주톤(하사/충성맹세 등) 금지, 교류는 동료 장수간 호의/신뢰로 표현
- [~] 내러티브 품질/비용 제어는 초기 형태
- [x] RAG(초기): 워커가 `lore_entries`(태그/제목)에서 관련 지식 0~6개를 조회해 AI 프롬프트에 주입
- [x] 세계지식(초기): `lore_entries` 테이블 + `/api/lore/search` (시드 기반 최소 지식)
- [x] 작은 에피소드(초기): `story` 호출 시 “오늘의 짧은 에피소드” 생성 + 선택지 버튼 제공 + 선택 결과 저장/로그(episode/episode_resolve)
- [x] 스카우트 제의(2단계): `scout_accept`(제의 수락/의심도) -> 접선(socialize/visit/gift) -> 결단(`scout_join`/`scout_backout`)
- [ ] 거절/승낙 서신, NPC 설전, 열전 생성 고도화

## 10) BM/운영
- [ ] Telegram Stars 결제
- [ ] 치장/편의/구독 상품
- [ ] 시즌제/이벤트/메타조정 파이프라인
- [ ] 어뷰징 탐지(멀티/봇/경제 악용)

## 11) 다음 우선순위(쉬운 게임 유지)
1. 도시/세계 데이터 확장(최소 20~50) + 초반 “퀘스트 튜토리얼”(인맥/탐색/이동/첫 유니크) 강화
2. 내정 커맨드 확장(치수/상업/포상) + 월 수입/경제 밸런스 1차
3. 전투를 “간단하지만 재밌게” (병과 3종 + 상성 + 지형 2~3종)
4. 텔레그램 봇/미니앱(입력 채널 분리만 먼저)

## 12) 초상/프롬프트(이미지)
- [x] 초상 프롬프트 저장: `portrait_set` 커맨드 + `officers.portrait_prompt`
- [x] 프롬프트 -> 이미지 생성(job/queue/caching) + 웹 UI에서 “생성/미리보기” (기본 256, 512는 느림)
- [x] 프롬프트 자동완성(초기): `/api/portraits/suggest` + 웹 UI “자동완성”(스타일/구도 선택, 로어 카드 근거 표시)
