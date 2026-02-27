# RLDX Waitlist — 운영/인수인계 가이드

이 문서는 프로젝트를 전수받는 사람이 모든 외부 서비스를 처음부터 세팅하거나 운영할 수 있도록 작성되었습니다.

---

## 외부 서비스 목록

| 서비스 | 용도 | URL |
|--------|------|-----|
| Supabase | DB + Edge Functions + Webhooks | https://supabase.com/dashboard |
| Resend | 이메일 발송 API | https://resend.com |
| Notion | 가입자 데이터 관리 대시보드 | https://notion.so |
| Slack | 새 가입 알림 | Slack Workspace |
| GoDaddy | 도메인 DNS 관리 (rlwrld.ai) | https://kr.godaddy.com |
| GitHub | 코드 저장소 + 백업 자동 push | https://github.com |

---

## 1. Supabase

### 로그인 정보

| 항목 | 값 |
|------|-----|
| URL | https://supabase.com/dashboard |
| 로그인 방법 | `________` (GitHub / Email) |
| 프로젝트명 | `________` |
| Project Ref | `fycshjlwrwwdbxwjnoqi` |
| Region | `________` |

### 필요한 키 (Settings → API)

| 키 | 용도 | 사용 위치 |
|----|------|-----------|
| Project URL | API 엔드포인트 | index.html, sync-config.json |
| anon key (JWT `eyJ...`) | 프론트엔드 INSERT | index.html |
| service_role key | 백엔드 전체 접근 | sync-config.json, Edge Function (자동 주입) |

### 주요 구성 요소

**테이블:**
- `waitlist` — 가입자 데이터 (RLS: anon INSERT만 허용)
- `email_logs` — 이메일 발송 기록 (RLS: service_role만 접근)

**Edge Function:**
- `send-confirmation-email` — 확인 이메일 발송
- 배포: Edge Functions → 해당 함수 → 코드 수정 후 Deploy
- Secrets: `RESEND_API_KEY` (Edge Functions → Manage Secrets)
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`는 자동 주입

**Database Webhook:**
- Name: `send-confirmation-email`
- Table: `waitlist`, Event: `INSERT`
- Type: Supabase Edge Functions → `send-confirmation-email`

### 초기 세팅 (프로젝트 새로 만들 때)

[SUPABASE_SETUP.md](SUPABASE_SETUP.md) 참고. 추가로 아래 SQL 실행 필요:

```sql
-- 이메일 발송 추적 컬럼
ALTER TABLE public.waitlist
ADD COLUMN IF NOT EXISTS confirmation_sent_at timestamptz DEFAULT NULL;

-- 이메일 로그 테이블
CREATE TABLE IF NOT EXISTS public.email_logs (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    waitlist_id bigint NOT NULL REFERENCES public.waitlist(id) ON DELETE CASCADE,
    email text NOT NULL,
    status text NOT NULL DEFAULT 'pending',
    resend_id text,
    error_message text,
    created_at timestamptz DEFAULT now(),
    sent_at timestamptz
);
ALTER TABLE public.email_logs ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_email_logs_waitlist_id ON public.email_logs(waitlist_id);
CREATE INDEX IF NOT EXISTS idx_email_logs_status ON public.email_logs(status);
```

---

## 2. Resend (이메일)

### 로그인 정보

| 항목 | 값 |
|------|-----|
| URL | https://resend.com |
| 로그인 방법 | `________` (GitHub / Email) |
| 연동된 도메인 | rlwrld.ai |

### API Key

| 항목 | 값 |
|------|-----|
| Key Name | rldx-waitlist-confirmation |
| Permission | Sending access (rlwrld.ai only) |
| 저장 위치 | Supabase Edge Functions → Manage Secrets → `RESEND_API_KEY` |

### 도메인 인증 (DNS 레코드)

GoDaddy DNS에 아래 3개 레코드가 등록되어 있어야 합니다:

| 타입 | Name | 용도 |
|------|------|------|
| MX | (Resend 제공값) | SPF — 발신 서버 인증 |
| TXT | (Resend 제공값) | DKIM — 이메일 서명 |
| TXT | `_dmarc` | DMARC — 정책 (`v=DMARC1; p=none;`) |

Resend 대시보드 → Domains → rlwrld.ai에서 레코드 값 확인 가능.

### 이메일 설정 (Edge Function 코드 내)

| 항목 | 현재 값 | 코드 위치 |
|------|---------|-----------|
| From | `RLDX by RLWRLD <launch@rlwrld.ai>` | `index.ts` line 13 |
| Reply-To | `do-not-reply@rlwrld.ai` | `index.ts` line 14 |
| Subject | `Welcome to RLDX, {name} — You're #{id}` | `index.ts` line 303 |

변경 시: 코드 수정 → Supabase Edge Functions에서 재배포.

### API Key 재발급 시

1. Resend → API Keys → Create API Key
2. Permission: Sending access, Domain: rlwrld.ai
3. Supabase → Edge Functions → Manage Secrets → `RESEND_API_KEY` 값 교체

### 모니터링

- Resend 대시보드 → Emails: 발송 내역, 열람률, 바운스 확인
- Supabase → Table Editor → `email_logs`: 발송 상태 (sent/failed)

---

## 3. Notion

### 로그인 정보

| 항목 | 값 |
|------|-----|
| Workspace | `________` |
| 로그인 방법 | `________` |

### Integration (API 연동)

| 항목 | 값 |
|------|-----|
| Integration 이름 | `________` |
| API Token | sync-config.json의 `notion.token` |
| 생성/관리 | https://www.notion.so/my-integrations |

### Database

| 항목 | 값 |
|------|-----|
| Database ID | sync-config.json의 `notion.databaseId` |
| Database URL | `________` |

**중요:** Notion 데이터베이스에 Integration이 연결(Share)되어 있어야 합니다.
Database 페이지 우상단 `...` → Connections → Integration 선택.

### Notion DB 컬럼 구조

**Profile columns (개별):**

| Column | Type | Source |
|--------|------|--------|
| Supabase ID | Title | `id` |
| Full Name | Rich text | `full_name` |
| Email | Email | `email` |
| Organization / Company | Rich text | `organization` |
| Country | Select | `country` |
| X or LinkedIn Profile | URL | `social_profile` |
| Submitted | Date | `created_at` |

**Section columns (병합 텍스트) — 자동 생성됨:**

| Column | 포함 필드 |
|--------|-----------|
| Who You Are | affiliation, role, industry, communities |
| Robot & Hardware | robotAccess, robotType, robotBrand, simAccess |
| Interest in RLDX | useCase, applications, shareWilling, shareType |
| Event & Engagement | eventAttendance, referralSource |

### Integration 재생성 시

1. https://www.notion.so/my-integrations → New Integration
2. Name 입력, Workspace 선택, Submit
3. Internal Integration Secret 복사 → `sync-config.json`의 `notion.token`에 입력
4. Notion Database 페이지에서 Connections에 Integration 추가

---

## 4. Slack

### 설정

| 항목 | 값 |
|------|-----|
| Workspace | `________` |
| Channel | `________` |
| Webhook URL | sync-config.json의 `slack.webhookUrl` |

### Webhook 생성 방법

1. https://api.slack.com/apps → Create New App → From scratch
2. App Name 입력, Workspace 선택
3. 좌측 메뉴 Incoming Webhooks → Activate
4. Add New Webhook to Workspace → 채널 선택 → Allow
5. Webhook URL 복사 → `sync-config.json`의 `slack.webhookUrl`에 입력

### 비활성화

`sync-config.json`에서 `"enabled": false`로 변경.

---

## 5. GoDaddy (도메인 DNS)

### 로그인 정보

| 항목 | 값 |
|------|-----|
| URL | https://kr.godaddy.com |
| 도메인 | rlwrld.ai |
| 로그인 방법 | `________` |

### 관리 중인 DNS 레코드

Resend 이메일 인증용 3개 레코드:

| 타입 | Name | 용도 |
|------|------|------|
| MX | (Resend 제공) | SPF |
| TXT | (Resend 제공) | DKIM |
| TXT | `_dmarc` | DMARC |

DNS 관리: 로그인 → 내 제품 → rlwrld.ai → DNS 관리

---

## 6. GitHub

### 로그인 정보

| 항목 | 값 |
|------|-----|
| Repository | `________` |
| 로그인 방법 | `________` |

### 자동 push

`backup-supabase.js`가 매일 백업 후 자동으로 git commit + push 합니다.
서버에서 GitHub 인증이 설정되어 있어야 합니다 (SSH key 또는 credential helper).

---

## 7. 서버 (Cron 실행 환경)

### 서버 정보

| 항목 | 값 |
|------|-----|
| Host | `________` |
| OS | Ubuntu (Linux) |
| Node.js 버전 | 18+ 필요 |
| 프로젝트 경로 | `/home/rlwrld/projects/waitlist` |
| 접속 방법 | `________` (SSH) |

### Cron 확인/수정

```bash
crontab -e
```

현재 등록된 cron:

```crontab
# Notion sync + Slack alert every 5 minutes
*/5 * * * * /usr/bin/node /home/rlwrld/projects/waitlist/sync/sync-notion.js >> /home/rlwrld/projects/waitlist/sync/logs/sync.log 2>&1

# Daily backup at KST 00:00 (UTC 15:00)
0 15 * * * /usr/bin/node /home/rlwrld/projects/waitlist/sync/backup-supabase.js >> /home/rlwrld/projects/waitlist/sync/logs/backup.log 2>&1
```

### 로그 확인

```bash
# 동기화 로그 (최근)
tail -50 sync/logs/sync.log

# 백업 로그 (최근)
tail -20 sync/logs/backup.log
```

---

## 일상 운영 체크리스트

### 매일

- [ ] Resend 대시보드에서 이메일 발송 상태 확인 (바운스/실패 여부)
- [ ] `sync/backups/` 에 오늘 날짜 백업 폴더 생성 확인

### 주간

- [ ] Supabase → `email_logs` 테이블에서 `status = 'failed'` 건 확인
- [ ] Notion DB에 최신 가입자 반영 확인
- [ ] `sync/logs/sync.log` 에러 여부 확인

### 트러블슈팅

| 증상 | 원인 | 해결 |
|------|------|------|
| 이메일 안 감 | Resend API Key 만료/삭제 | Resend에서 재발급 → Supabase Secrets 교체 |
| 이메일 안 감 | 도메인 인증 해제 | Resend → Domains에서 rlwrld.ai 상태 확인 |
| 이메일 안 감 | Webhook 비활성화 | Supabase → Database → Webhooks 확인 |
| Notion 동기화 안 됨 | Notion token 만료 | Notion Integration 재생성 → sync-config.json 업데이트 |
| Notion 동기화 안 됨 | cron 중단 | `crontab -l`로 확인, 서버 재부팅 후 cron 재시작 |
| 백업 안 됨 | git push 실패 | 서버에서 `git push` 수동 실행, 인증 확인 |
| 폼 제출 401 에러 | Supabase anon key 변경 | index.html의 키 교체 |

---

## 이메일 내용 수정 시

1. `supabase/functions/send-confirmation-email/index.ts` 수정 (로컬)
2. Supabase 대시보드 → Edge Functions → `send-confirmation-email`
3. 코드 전체 교체 후 **Deploy**
4. Edge Function Test에서 테스트 발송 확인

참고: `sync/email-template.md`에 이메일 디자인 레퍼런스 보관.

---

## 전체 시스템 처음부터 세팅 순서

1. Supabase 프로젝트 생성 → [SUPABASE_SETUP.md](SUPABASE_SETUP.md) 따라 테이블/RLS 설정
2. 위 SQL로 `confirmation_sent_at` 컬럼 + `email_logs` 테이블 추가
3. Resend 가입 → API Key 발급 → 도메인 등록 → DNS 레코드 추가 (GoDaddy) → Verify
4. Supabase Edge Functions → Manage Secrets → `RESEND_API_KEY` 추가
5. Edge Function 배포 (Via Editor, `index.ts` 코드 복붙)
6. Database Webhook 생성 (waitlist INSERT → send-confirmation-email)
7. `sync-config.json` 설정 (Supabase + Notion + Slack 키)
8. Notion Integration 생성 → Database에 연결
9. Slack Incoming Webhook 생성
10. Cron 등록 (sync + backup)
11. `index.html`에 Supabase URL + anon key 입력
12. 테스트: 폼 제출 → 이메일 수신 → Notion 동기화 → Slack 알림 → 백업 확인
