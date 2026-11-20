# 대산 블로그 콘텐츠 위키 — 전체 워크플로

> **현재 상태 (2026-11-20)**: 위키 프로젝트 작업 폴더는 `~/LLMWiki/daesan-wiki-sync`(이 Mac 로컬)로 옮겼다. 앱은 이 경로를 연다. 아래 본문의 `SynologyDrive-daesan-wiki-sync`는 옛 구조 설명이다.
> - 크롤러 `OUTPUT_DIR`은 아직 Synology `raw/sources`를 가리킨다. 여기 쌓인 새 파일은 로컬 프로젝트로 **자동 복사되지 않는다**. 동기화 스크립트(`wiki_sync.sh pull-sources`)를 만들기 전까지는 수동으로 가져와야 한다.
> - 자세한 방향: `docs/위키_운영방향_제안.md`.

이 문서는 크롤링 → 인제스트 → 위키 생성 → NAS 동기화까지 전체 자동화 흐름을 정리한 것입니다.

> **변경 이력**:
> - 최초 설계는 크롤러(iCloud) → 로컬 스테이징(`Crawling-source`) → 예약 가져오기(1시간 주기) → `raw/sources`의 2단계 구조였으나, 크롤러가 처음부터 로컬 경로에 직접 다운로드 가능하다는 게 확인되어 **중간 스테이징 단계를 제거**하고 1단계로 단순화함 (2026-07-16).
> - 크롤러 **스크립트 자체**(`step3_download_new_posts.py`)는 iCloud 경로에 위치하지만, 스크립트 내부의 `OUTPUT_DIR` 변수가 `raw/sources`(로컬/NAS 동기화 경로)로 이미 정확히 지정되어 있음을 코드 확인으로 검증함. 크롤러가 "실행되는 위치(iCloud)"와 "결과물을 저장하는 위치(로컬 raw/sources)"는 서로 다르며, 저장 위치만 안전하면 실행 위치는 iCloud여도 무방함 (2026-07-16 확인).

---

## 1. 전체 흐름 다이어그램 (현재 구조)

```
[1] 크롤링 프로젝트
    → 벤치마킹 블로그를 크롤링, 결과를 로컬 경로에 직접 다운로드
         │
         ▼
[2] 프로젝트 소스 폴더 (실시간 감시 대상)
    /Users/zart/Library/CloudStorage/SynologyDrive-daesan-wiki-sync/raw/sources/
    → 크롤러가 이 경로에 파일을 저장하는 즉시 Wiki 앱이 실시간으로 감지
         │
         │ (파일 생성 즉시 자동 인제스트 트리거 — 대기시간 없음)
         ▼
[3] LLM 분석 → 지식 생성
    - 분석(엔티티/컨셉 식별) → 병합/생성 → 임베딩
    - 결과물이 wiki/ 폴더에 로컬로 저장됨
    /Users/zart/Library/CloudStorage/SynologyDrive-daesan-wiki-sync/wiki/
    (entities/ concepts/ synthesis/ sources/ 등)
         │
         │ (Synology Drive Client가 실시간·상시 감시)
         ▼
[4] NAS 자동 업로드
    NAS 경로: 성장전략실/Wiki_시장
    → 양방향 동기화로, 다른 컴퓨터(B)에서도 항상 최신 상태로 열람/수정 가능
```

---

## 2. 단계별 상세 설명

### [1] 크롤링 (에이전시 담당 영역)
- 크롤러 스크립트 위치: `/Users/zart/Library/Mobile Documents/com~apple~CloudDocs/프로젝트/Naver-Blog-Crawler/Naver_blog_crawling/step3_download_new_posts.py`
  - 이 스크립트 자체는 iCloud 경로에 있지만, **문제되지 않음** — 스크립트가 "실행되는 위치"와 "결과를 저장하는 위치"는 별개이기 때문
- 결과 저장 경로는 스크립트 내부에 다음과 같이 하드코딩되어 있고, **정확히 확인 완료**:
  ```python
  OUTPUT_DIR = "/Users/zart/Library/CloudStorage/SynologyDrive-daesan-wiki-sync/raw/sources"
  ```
- ⚠️ 저장 경로(`OUTPUT_DIR`)는 반드시 **로컬 디스크 경로**여야 함 — iCloud 등 클라우드 동기화 경로를 저장 위치로 쓰면 지연 동기화로 인한 파일 인식 오류 위험이 있음 (관련 트러블슈팅은 `NAS_가이드.md` 참고). 지금은 정확히 로컬(NAS 동기화) 경로로 설정되어 있어 안전함
- 파일명은 **매번 고유하게** 생성 (동일 파일명에 내용만 덮어쓰면 "변경됨"으로 인식되어 재인제스트가 걸림 — 의도한 게 아니면 글 ID·타임스탬프 등을 파일명에 포함시킬 것). 현재 크롤러는 `baro0904_[숫자ID].txt` 형식으로 매번 고유한 파일명을 생성 중
- 다운로드 이력은 크롤러 자체 로그(`downloaded_log.json`, 같은 폴더)에도 별도 기록됨

### [2] 프로젝트 소스 폴더
- 위치: `/Users/zart/Library/CloudStorage/SynologyDrive-daesan-wiki-sync/raw/sources/`
  (심볼릭 링크로도 접근 가능: `/Users/zart/Documents/daesan-blog-wiki/daesan-wiki-sync/raw/sources/`)
- Wiki 앱이 프로젝트를 열어둔 상태에서 이 폴더를 **실시간 감시**
- 지원 파일 형식: `md mdx txt pdf doc docx pptx xlsx odt odp ods xls csv json html htm rtf xml yaml yml`
- 대용량 PDF 등은 처리 시간·비용이 늘어남 — 사전 테스트 권장
- 이미 처리된 파일(내용 동일)은 자동으로 재인제스트되지 않음

### [3] 인제스트 & 위키 생성
- LLM(Gemini 2.5 Flash)이 소스를 분석 → entity/concept/synthesis/comparison 등 생성
- 결과는 프로젝트 폴더 내 `wiki/`에 로컬 저장
- 처리 시간은 소스 길이와 기존 위키 규모(병합 판단 호출 수)에 따라 달라짐

### [4] NAS 동기화
- Synology Drive Client(양방향 동기화)가 `daesan-wiki-sync` 폴더 전체를 실시간 감시
- `[2]`, `[3]` 단계에서 생성/변경되는 모든 파일이 자동으로 NAS(`성장전략실/Wiki_시장`)에 반영됨
- 다른 컴퓨터(B)도 같은 NAS 폴더에 연결하면 항상 최신 상태 열람/수정 가능 (협업 규칙은 `NAS_가이드.md` 참고)

---

## 3. 경로 요약표

| 구분 | 경로 | 위치 |
|---|---|---|
| 크롤러 스크립트 (실행 위치) | `.../Naver-Blog-Crawler/Naver_blog_crawling/step3_download_new_posts.py` | iCloud (무방함, 저장 위치와 무관) |
| 크롤러 다운로드 목적지 = 프로젝트 소스 폴더 (`OUTPUT_DIR`) | `.../SynologyDrive-daesan-wiki-sync/raw/sources/` | 로컬 (NAS 동기화) |
| 위키 결과물 | `.../SynologyDrive-daesan-wiki-sync/wiki/` | 로컬 (NAS 동기화) |
| NAS 저장소 | `성장전략실/Wiki_시장` | NAS |

---

## 4. 폐기된 구성 요소 (더 이상 사용하지 않음)

- ~~로컬 스테이징 폴더~~ `/Users/zart/Documents/daesan-blog-wiki/Crawling-source/` — 삭제됨
- ~~예약 가져오기(Scheduled Import) 1시간 주기 스캔~~ — 사용 안 함 (설정했다면 비활성화 필요)
- ~~크롤러 원본(iCloud) 경로~~ `.../Naver-Blog-Crawler/Naver_blog_crawling/downloaded_txt/` — 더 이상 다운로드 목적지로 쓰지 않음. 다만 과거 인제스트된 파일(예: 확인된 31개)이 남아있을 수 있으므로, 필요 시 별도로 검토 후 정리

> 이 구성을 다시 쓸 상황(예: 크롤러가 로컬에 직접 저장하지 못하는 환경으로 바뀌는 경우)이 생기면, 이전 버전의 이 문서(2단계 구조)를 참고해 복원 가능.

---

## 5. 확인이 필요한 부분 (진행 전 체크)

- [x] 크롤러가 실제로 `raw/sources`에 직접 저장하도록 설정되었는지 최종 확인 — **완료.** `OUTPUT_DIR` 코드 확인함 (2026-07-16)
- [x] 파일명 중복(덮어쓰기) 방지 로직이 크롤러 쪽에 반영되었는지 확인 — **완료.** 매번 고유 ID 기반 파일명 생성 확인
- [x] `Crawling-source` 폴더 삭제 완료 확인
- [ ] 예약 가져오기 설정이 켜져 있었다면 비활성화 확인
- [ ] **옛 iCloud 프로젝트 잔재 정리**: `/Users/zart/Library/Mobile Documents/com~apple~CloudDocs/프로젝트/Naver-Blog-Crawler/Naver_blog_crawling/downloaded_txt/Blog_wiki/` — 로컬 이전 전 사용하던 예전 프로젝트의 흔적(`wiki/sources/` 등)이 남아있어 파일 검색 시 혼동을 유발함. 현재 프로젝트와 무관하니 삭제 권장 (삭제 전 새 프로젝트에 없는 내용이 있는지 최종 대조 권장)

---

## 6. 관련 문서
- `NAS_가이드.md` — Synology NAS 연동, 협업 규칙, 트러블슈팅 (같은 위치에 보관)
- `purpose.md`, `schema.md` — 프로젝트 목적 및 엔티티/컨셉 스키마 정의 (프로젝트 루트)

---

*최초 작성: 2026-07-16. 1차 수정: 2026-07-16 (Crawling-source 중간 단계 제거, 크롤러 직접 다운로드 구조로 단순화). 2차 수정: 2026-07-16 (크롤러 스크립트 위치·OUTPUT_DIR 설정 코드 확인 반영, 옛 iCloud 잔재 정리 항목 추가). (주)대산 블로그 콘텐츠 위키 프로젝트 기준.*