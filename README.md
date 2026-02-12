# Red Cliff Terminal (적벽 터미널)

원샷 출시안을 기준으로 한 통합 개발 시작 코드베이스입니다.

## 구성
- `services/api`: 게임 규칙 서버 (Express + Socket.io + PostgreSQL)
- `services/worker`: 비동기 열전/서사 워커 (BullMQ)
- `services/ai`: AI 서사 서비스 (FastAPI)
- `services/web`: 웹 콘솔 (React + xterm.js)
- `infra/postgres/init.sql`: 초기 스키마 및 시드
- `infra/nginx/nginx.conf`: 리버스 프록시

## 로컬 실행
```bash
cp .env.example .env
docker compose up -d --build
```

접속:
- 웹 콘솔: `http://localhost`
- API 헬스체크: `http://localhost/api/health`

웹 콘솔에서 명령 입력:
1. `bootstrap`
2. `status`
3. `cultivate` / `train` / `recruit` / `rest`
4. `battle_start` / `battle_state` / `battle_attack` / `battle_wait` / `battle_move_n`

## 서버 배포 (152.67.220.151)
```bash
scp -i ssh-key-2025-12-20.key -r . ubuntu@152.67.220.151:/home/ubuntu/redcliff-terminal
ssh -i ssh-key-2025-12-20.key ubuntu@152.67.220.151
cd /home/ubuntu/redcliff-terminal
cp .env.example .env
./scripts/deploy.sh
```

## 현재 구현 상태
- 장수/AP/공적/품관의 핵심 루프 구현
- 내정 커맨드(`cultivate`, `train`, `recruit`) 구현
- 20x20 ASCII 전투 기본 루프(`battle_*`) 구현
- 일 단위 시간 진행 엔드포인트(`/api/game/tick/day`) 구현
- 명령 멱등키 처리(`Idempotency-Key`) 구현
- 서사 로그 큐 + AI 텍스트 생성 연동 구현

## 다음 구현 우선순위
1. 텔레그램 Bot/Mini App 인증 실장
2. 전투(20x20 전술맵) 엔진
3. 외교/등용/설전/첩보 시스템
4. 결제(Telegram Stars) 연동
