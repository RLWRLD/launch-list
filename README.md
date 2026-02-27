# RLDX Waitlist

RLDX Launch List 등록 페이지 + 자동 이메일 확인 + Notion 동기화 + Slack 알림 + 일일 백업.

## 아키텍처

```
사용자 폼 제출 (index.html)
        ↓
Supabase REST API → waitlist 테이블 INSERT
        ↓
        ├─→ [즉시] Database Webhook → Edge Function → Resend API
        │   → 확인 이메일 자동 발송
        │
        ├─→ [5분마다] sync-notion.js (cron)
        │   → Notion DB 동기화 + Slack 알림
        │
        └─→ [매일 00:00 KST] backup-supabase.js (cron)
            → JSON 백업 + git commit & push
```

## 프로젝트 구조

```
waitlist/
├── index.html                          # Launch List 폼 (HTML/CSS/JS + Supabase)
├── rlwrld/
│   ├── css/styles.css                  # 공통 스타일 (다크 테마)
│   ├── js/script.js                    # 공통 JS (progress bar, scroll 등)
│   └── assets/logos/                   # 로고 SVG
├── supabase/
│   ├── config.toml                     # Supabase 로컬 설정
│   └── functions/
│       └── send-confirmation-email/
│           ├── index.ts                # 확인 이메일 Edge Function (Deno/TypeScript)
│           └── deno.json               # Deno import map
├── sync/
│   ├── sync-notion.js                  # Supabase → Notion 동기화 + Slack 알림
│   ├── backup-supabase.js              # Supabase 일일 백업
│   ├── sync-config.json                # API 키 설정 (gitignored)
│   ├── sync-config.example.json        # 설정 파일 템플릿
│   ├── email-template.md               # 이메일 템플릿 레퍼런스
│   ├── DATA_PIPELINE.md                # 데이터 파이프라인 상세 문서
│   ├── backups/                        # 일일 백업 저장 (YYYY-MM-DD/)
│   └── logs/                           # 동기화/백업 로그
├── QA/
│   ├── run-all-tests.sh                # Playwright 테스트 실행 스크립트
│   ├── tests/                          # Playwright 테스트 코드
│   ├── Option_Checklist.md             # 226항목 테스트 체크리스트
│   ├── Flow_Edge_Case.md               # 플로우 엣지케이스 문서
│   └── Option_Edge_Case.md             # 옵션 엣지케이스 문서
├── SUPABASE_SETUP.md                   # Supabase 테이블/RLS 설정 가이드
├── OPERATIONS.md                       # 운영/인수인계 가이드 ← 신규
└── README.md
```

## 기능별 요약

### 1. Launch List 폼

`index.html` — 정적 HTML/CSS/JS, 프레임워크 없음.

- 4개 섹션: Who You Are / Robot & Hardware / Interest in RLDX / Event & Engagement
- 조건부 필드 표시 (radio 선택에 따라)
- 이메일 중복 방지 (Supabase UNIQUE INDEX)
- Honeypot 안티스팸 + 3초 제출 쿨다운
- 제출 데이터: 핵심 필드는 개별 컬럼, 전체 응답은 `form_data` JSONB

```bash
# 로컬 테스트 (file:// 불가, 반드시 HTTP 서버)
npx serve .
# 또는
python3 -m http.server 8080
```

### 2. 확인 이메일 (자동)

Supabase Edge Function + Database Webhook + Resend API.

- waitlist INSERT 즉시 자동 트리거 (프론트엔드 수정 불필요)
- 커스텀 도메인 발신 (`launch@rlwrld.ai`)
- HTML + Plain Text 이메일 (다크 테마, 사이트 디자인 매칭)
- 중복 발송 방지 (`confirmation_sent_at` 체크)
- 발송 로그: `email_logs` 테이블
- 모니터링: Resend 대시보드 + Supabase `email_logs`

### 3. Notion 동기화 (5분마다)

`sync/sync-notion.js` — Node.js 18+, 외부 패키지 불필요.

- index.html을 자동 파싱하여 라벨/섹션 구조 추출 (하드코딩 매핑 없음)
- 코드값 → 사람이 읽을 수 있는 라벨 변환
- 섹션별 질문:답변 형태의 병합 텍스트 생성
- email 기준 중복 방지
- Notion DB에 섹션 컬럼이 없으면 자동 생성

### 4. Slack 알림 (동기화 시)

Notion 동기화와 함께 실행. 새 가입자가 있을 때 Slack 채널에 알림.

- `sync-config.json`의 `slack.webhookUrl`과 `slack.enabled`로 제어
- 가입자 이름, 이메일, 소속, 국가 정보 포함

### 5. 일일 백업

`sync/backup-supabase.js` — 매일 KST 00:00에 실행.

- Supabase 전체 데이터를 `sync/backups/YYYY-MM-DD/waitlist.json`에 저장
- 자동 git commit + push

### 6. QA 테스트

Playwright 기반 자동화 테스트 + 수동 체크리스트 226항목.

```bash
cd QA && bash run-all-tests.sh
```

## 설정

### sync-config.json

```bash
cp sync/sync-config.example.json sync/sync-config.json
```

```json
{
  "supabase": {
    "url": "https://YOUR_PROJECT.supabase.co",
    "serviceRoleKey": "YOUR_SUPABASE_SERVICE_ROLE_KEY"
  },
  "notion": {
    "token": "YOUR_NOTION_API_TOKEN",
    "databaseId": "YOUR_NOTION_DATABASE_ID"
  },
  "slack": {
    "webhookUrl": "YOUR_SLACK_WEBHOOK_URL",
    "enabled": true
  }
}
```

### Cron 설정

```crontab
# Notion sync + Slack alert every 5 minutes
*/5 * * * * /usr/bin/node /home/rlwrld/projects/waitlist/sync/sync-notion.js >> /home/rlwrld/projects/waitlist/sync/logs/sync.log 2>&1

# Daily backup at KST 00:00 (UTC 15:00)
0 15 * * * /usr/bin/node /home/rlwrld/projects/waitlist/sync/backup-supabase.js >> /home/rlwrld/projects/waitlist/sync/logs/backup.log 2>&1
```

## DB 스키마

### waitlist 테이블

| 컬럼 | 타입 | 설명 |
|---|---|---|
| `id` | bigint (자동) | Primary key |
| `created_at` | timestamptz (자동) | 제출 시각 |
| `email` | text, NOT NULL, UNIQUE | 이메일 |
| `full_name` | text | 이름 |
| `organization` | text | 소속 |
| `country` | text | 국가 코드 |
| `social_profile` | text | X 또는 LinkedIn URL |
| `form_data` | jsonb | 폼 전체 응답 JSON |
| `confirmation_sent_at` | timestamptz | 확인 이메일 발송 시각 (NULL = 미발송) |

### email_logs 테이블

| 컬럼 | 타입 | 설명 |
|---|---|---|
| `id` | bigint (자동) | Primary key |
| `waitlist_id` | bigint (FK → waitlist.id) | 대상 가입자 |
| `email` | text | 수신자 이메일 |
| `status` | text | pending / sent / failed |
| `resend_id` | text | Resend API 응답 ID |
| `error_message` | text | 실패 시 에러 메시지 |
| `created_at` | timestamptz | 기록 시각 |
| `sent_at` | timestamptz | 발송 완료 시각 |

## 관련 문서

- [SUPABASE_SETUP.md](SUPABASE_SETUP.md) — Supabase 테이블/RLS 초기 설정
- [OPERATIONS.md](OPERATIONS.md) — 운영/인수인계 가이드 (외부 서비스 세팅, 로그인 정보)
- [sync/DATA_PIPELINE.md](sync/DATA_PIPELINE.md) — 데이터 파이프라인 상세 구조
- [sync/email-template.md](sync/email-template.md) — 이메일 템플릿 레퍼런스
