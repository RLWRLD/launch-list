# RLDX Waitlist Data Pipeline

## Architecture Overview

```
[User submits form]
       │
       ▼
┌─────────────┐     FormData API (auto-collect all inputs)
│  index.html │────────────────────────────────────────────┐
└─────────────┘                                            │
                                                           ▼
                                              ┌────────────────────┐
                                              │      Supabase      │
                                              │  waitlist table     │
                                              │                    │
                                              │  - email           │
                                              │  - full_name       │
                                              │  - organization    │
                                              │  - country         │
                                              │  - social_profile  │
                                              │  - form_data (JSONB)│
                                              │  - created_at      │
                                              └────────┬───────────┘
                                                       │
                              ┌─────────────────────────┤
                              │                         │
                         cron 5min                 cron daily
                              │                         │
                              ▼                         ▼
                    ┌──────────────────┐     ┌──────────────────┐
                    │  sync-notion.js  │     │ backup-supabase.js│
                    │                  │     │                  │
                    │  Reads index.html│     │  JSON backup to  │
                    │  at runtime for  │     │  sync/backups/   │
                    │  auto label/     │     │  + git commit    │
                    │  section extract │     │  + git push      │
                    └────────┬─────────┘     └──────────────────┘
                             │
                             ▼
                    ┌──────────────────┐
                    │  Notion Database │
                    │                  │
                    │  Profile columns │
                    │  + 4 section     │
                    │    columns       │
                    └──────────────────┘
```

---

## 1. Supabase Storage

### Table: `waitlist`

| Column | Type | Source | Notes |
|---|---|---|---|
| `id` | serial | auto | Primary key |
| `email` | text | `data.email` | Unique, indexed |
| `full_name` | text | `data.fullName` | |
| `organization` | text | `data.organization` | |
| `country` | text | `data.country` | Code value (e.g., `KR`, `US`) |
| `social_profile` | text | `data.socialProfile` | URL or null |
| `form_data` | jsonb | `data` (entire FormData object) | All form fields |
| `created_at` | timestamptz | auto | Server timestamp |

### How form_data is collected (index.html)

```js
const formData = new FormData(form);
formData.delete('website');  // honeypot 제거
const data = {};

formData.forEach((value, key) => {
    if (data[key]) {
        if (Array.isArray(data[key])) {
            data[key].push(value);       // 3rd+ checkbox → push to array
        } else {
            data[key] = [data[key], value]; // 2nd checkbox → convert to array
        }
    } else {
        data[key] = value;               // 1st value → string
    }
});
```

### Storage rules

- **Radio inputs**: 하나만 선택 → `string` (e.g., `"academic"`)
- **Checkbox inputs**: 하나 선택 → `string`, 여러 개 → `array` (e.g., `["franka", "ur"]`)
- **Text inputs**: 항상 포함, 비어있으면 `""` (빈 문자열)
- **Conditional fields**: radio/checkbox가 미선택이면 key 자체가 없음, text input은 빈 문자열로 존재

### Hardcoded columns (index.html line 1580-1586)

아래 5개 필드는 개별 Supabase 컬럼으로 추출하여 저장합니다 (검색/인덱싱 용도).
이 필드의 `name` 속성을 변경하면 index.html의 fetch body도 수정 필요합니다.

```js
body: JSON.stringify({
    email: data.email,
    full_name: data.fullName,
    organization: data.organization,
    country: data.country,
    social_profile: data.socialProfile || null,
    form_data: data  // ← 전체 데이터 JSONB
})
```

### form_data example

```json
{
  "fullName": "홍길동",
  "email": "hong@kaist.ac.kr",
  "organization": "KAIST",
  "country": "KR",
  "socialProfile": "https://x.com/hong",
  "affiliation": "academic",
  "academicRole": "professor",
  "affiliationOther": "",
  "industryOther": "",
  "startupRoleOther": "",
  "communities": ["lerobot", "ros", "other"],
  "communitiesOther": "My Community",
  "robotAccess": "own",
  "robotType": ["humanoid", "single_arm"],
  "robotTypeOther": "",
  "robotBrand": ["franka", "ur"],
  "robotBrandOther": "",
  "simAccess": "rtx4090_plus",
  "useCase": ["benchmark", "finetune"],
  "applications": ["bin_picking", "assembly"],
  "applicationsOther": "",
  "shareWilling": "yes",
  "shareType": ["content", "testimonial"],
  "eventAttendance": "kr_inperson",
  "referralSource": "social",
  "referralSourceOther": ""
}
```

---

## 2. Notion Sync

### Script: `sync/sync-notion.js`

### Execution

```bash
# Manual
node sync/sync-notion.js           # 실제 싱크
node sync/sync-notion.js --dry-run # 프리뷰만 (Notion에 안 씀)

# Cron (자동)
*/5 * * * * /usr/bin/node /home/rlwrld/projects/waitlist/sync/sync-notion.js
```

### Auto-extraction from index.html

sync-notion.js는 실행 시마다 index.html을 파싱하여 아래 정보를 자동 추출합니다.
**하드코딩된 매핑 없음.**

#### 1) LABELS — 옵션 텍스트 매핑

```
<input name="simAccess" value="rtx4090_plus">
<span class="option-label">Yes, RTX 4090 or higher (24GB+ VRAM)</span>
```
→ `LABELS.simAccess.rtx4090_plus = "Yes, RTX 4090 or higher (24GB+ VRAM)"`

#### 2) SECTIONS — 섹션 구조 + 질문 텍스트

```
<div class="form-section">
  <h3 class="section-title">Robot & Hardware</h3>
  <div class="form-group">
    <label class="form-label">Do you have access to a robot? *</label>
    <input name="robotAccess" ...>
```
→ `{ title: "Robot & Hardware", fields: [{ key: "robotAccess", question: "Do you have access to a robot?" }] }`

#### 3) SELECT options

```
<select name="country">
  <option value="KR">South Korea</option>
```
→ `LABELS.country.KR = "South Korea"`

### Notion Database Structure

#### Profile columns (개별)

| Notion Column | Type | Source |
|---|---|---|
| Name | Title | `full_name` / `form_data.fullName` |
| Email | Email | `email` / `form_data.email` |
| Organization | Rich text | `organization` / `form_data.organization` |
| Country | Select | `country` → LABELS로 텍스트 변환 |
| Social Profile | URL | `social_profile` / `form_data.socialProfile` |
| Submitted | Date | `created_at` |

#### Section columns (병합 텍스트)

| Notion Column | form_data Keys |
|---|---|
| Who You Are | affiliation, academicRole, industryRole, industry, startupRole, communities + *Other fields |
| Robot & Hardware | robotAccess, robotType, robotBrand, simAccess + *Other fields |
| Interest in RLDX | useCase, applications, shareWilling, shareType + *Other fields |
| Event & Engagement | eventAttendance, referralSource + *Other fields |

#### Merged cell format

```
[Question Text]: [Answer Text]
[Question Text]: [Answer1, Answer2, Answer3]
[Question Text]: [Answer1, Other: 사용자 입력]
```

Example (Who You Are):
```
What type of organization are you from?: Academic (University / Research Institute)
What is your role?: Professor / Principal Investigator
Which communities are you part of?: LeRobot, ROS Community, Other: My Community
```

### Sync logic

1. Supabase에서 전체 row를 가져옴
2. Notion DB에 섹션 컬럼이 없으면 자동 생성 (PATCH API)
3. Notion DB에서 이미 싱크된 email 목록을 조회
4. 새 row만 필터링하여 Notion 페이지 생성
5. 중복 email은 skip (email 기준 비교)

### Auto-column creation

`ensureSectionColumns()` 함수가 실행마다 Notion DB 스키마를 확인하고,
index.html에 새 섹션이 추가되었으면 해당 컬럼을 자동 생성합니다.

---

## 3. Daily Backup

### Script: `sync/backup-supabase.js`

```bash
# Manual
node sync/backup-supabase.js

# Cron (자동, KST 00:00 = UTC 15:00)
0 15 * * * /usr/bin/node /home/rlwrld/projects/waitlist/sync/backup-supabase.js
```

- Supabase 전체 데이터를 `sync/backups/YYYY-MM-DD/waitlist.json`에 저장
- 자동으로 git commit + push

---

## 4. Configuration

### sync/sync-config.json

```json
{
  "supabase": {
    "url": "https://YOUR_PROJECT.supabase.co",
    "serviceRoleKey": "YOUR_SUPABASE_SERVICE_ROLE_KEY"
  },
  "notion": {
    "token": "YOUR_NOTION_API_TOKEN",
    "databaseId": "YOUR_NOTION_DATABASE_ID"
  }
}
```

> **주의:** `sync-config.json`은 시크릿 키를 포함하므로 `.gitignore`에 포함되어 있습니다.
> 새 환경 세팅 시 `sync-config.example.json`을 복사하여 키를 입력하세요.

### Cron entries

```crontab
# RLDX Waitlist — Notion sync every 5 minutes
*/5 * * * * /usr/bin/node /home/rlwrld/projects/waitlist/sync/sync-notion.js >> /home/rlwrld/projects/waitlist/sync/logs/sync.log 2>&1

# RLDX Waitlist — Daily backup at KST 00:00 (UTC 15:00)
0 15 * * * /usr/bin/node /home/rlwrld/projects/waitlist/sync/backup-supabase.js >> /home/rlwrld/projects/waitlist/sync/logs/backup.log 2>&1
```

---

## 5. Field Mapping Reference

### Who You Are

| Question (Label) | form_data Key | Type |
|---|---|---|
| What type of organization are you from? | `affiliation` | radio |
| (Other text) | `affiliationOther` | text |
| What is your role? (Academic) | `academicRole` | radio |
| What is your role? (Industry) | `industryRole` | radio |
| Which industry? | `industry` | checkbox (array) |
| (Other text) | `industryOther` | text |
| What is your role? (Startup) | `startupRole` | radio |
| (Other text) | `startupRoleOther` | text |
| Which communities are you part of? | `communities` | checkbox (array) |
| (Other text) | `communitiesOther` | text |

### Robot & Hardware

| Question (Label) | form_data Key | Type |
|---|---|---|
| Do you have access to a robot? | `robotAccess` | radio |
| Robot Type(s) | `robotType` | checkbox (array) |
| (Other text) | `robotTypeOther` | text |
| Robot Brand(s) | `robotBrand` | checkbox (array) |
| (Other text) | `robotBrandOther` | text |
| Do you have access to a simulation environment? | `simAccess` | radio |

### Interest in RLDX

| Question (Label) | form_data Key | Type |
|---|---|---|
| What do you want to do with RLDX? | `useCase` | checkbox (array) |
| What tasks are you interested in? | `applications` | checkbox (array) |
| (Other text) | `applicationsOther` | text |
| Would you share your experience publicly? | `shareWilling` | radio |
| How would you like to share? | `shareType` | checkbox (array) |

### Event & Engagement

| Question (Label) | form_data Key | Type |
|---|---|---|
| Would you attend an RLDX launch event? | `eventAttendance` | radio |
| How did you hear about RLDX? | `referralSource` | radio |
| (Other text) | `referralSourceOther` | text |

---

## 6. Maintenance Guide

### index.html 수정 시 영향 범위

| 변경 사항 | Supabase | Notion Sync | 추가 작업 |
|---|---|---|---|
| 옵션 텍스트 변경 | 영향 없음 (key로 저장) | 자동 반영 | 없음 |
| 옵션 추가 | 자동 (FormData 수집) | 자동 (LABELS 추출) | 없음 |
| 옵션 삭제 | 자동 | 기존 데이터는 key fallback | 없음 |
| 새 질문 추가 (기존 섹션) | 자동 (FormData 수집) | 자동 (SECTIONS 추출) | 없음 |
| 새 섹션 추가 | 자동 | 자동 (컬럼도 자동 생성) | 없음 |
| 섹션명 변경 | 영향 없음 | 새 컬럼 자동 생성 | 기존 컬럼 수동 삭제 |
| 섹션 삭제 | 영향 없음 | 기존 데이터/컬럼 유지 | 기존 컬럼 수동 삭제 |
| 프로필 필드명 변경 | **fetch body 수동 수정** | 영향 없음 | index.html 1580-1586행 수정 |
| HTML 구조 변경 (class명 등) | 영향 없음 | **파싱 깨질 수 있음** | sync-notion.js 정규식 확인 |

### 기존 데이터 마이그레이션 (옵션 변경 시)

Supabase에는 코드 key로 저장되므로, 옵션 텍스트를 바꿔도 기존 데이터는 영향 없습니다.
옵션의 **value(key)** 자체를 바꾸는 경우에만 마이그레이션이 필요합니다:

```sql
-- 예: value "rtx4090_plus" → "rtx5090_plus" 로 변경한 경우
UPDATE waitlist
SET form_data = jsonb_set(
  form_data,
  '{simAccess}',
  '"rtx5090_plus"'
)
WHERE form_data->>'simAccess' = 'rtx4090_plus';
```

### HTML 구조 의존성 (sync-notion.js 파싱 기준)

파싱이 정상 동작하려면 아래 HTML 구조를 유지해야 합니다:

```html
<div class="form-section">
  <div class="section-header">
    <h3 class="section-title">섹션명</h3>
  </div>
  <div class="form-group">
    <label class="form-label">질문 텍스트</label>
    <input name="fieldKey" value="optionValue">
    <span class="option-label">옵션 텍스트</span>
  </div>
</div>
```

필수 class:
- `form-section` — 섹션 경계
- `section-title` — 섹션명 (→ Notion 컬럼명)
- `form-label` — 질문 텍스트 (→ 셀 안의 라벨)
- `option-label` — 옵션 텍스트 (→ 답변 표시)

### Logs

```
sync/logs/sync.log    — Notion 싱크 로그 (5분마다)
sync/logs/backup.log  — 백업 로그 (매일)
```
