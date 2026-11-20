#!/bin/bash
# 위키 소스 동기화: Synology Drive의 raw/sources → 로컬 위키 프로젝트의 raw/sources (pull-sources).
#
# 사용법
#   scripts/wiki_sync.sh            # 미리보기: 복사될 파일 목록만 출력 (아무것도 바꾸지 않음)
#   scripts/wiki_sync.sh --apply    # 실제 복사
#
# 규칙
#   - 삭제는 하지 않는다 (--delete 없음). 원본에서 사라진 파일은 로컬에 그대로 둔다.
#   - 충돌본(*_Conflict*), .DS_Store, .cache/, .llm-wiki/ 는 제외한다.
#   - 로컬이 더 새롭거나 같은 파일은 덮어쓰지 않는다 (--update).
#   - 로컬에서 지운 소스가 다음 pull 때 되살아나는 문제는 아직 해결 전이다 (삭제 목록 필요).
#
# 환경 변수 (필요할 때만)
#   WIKI_SRC  원본 raw/sources 경로
#   WIKI_DST  로컬 프로젝트 raw/sources 경로
set -euo pipefail
export LC_ALL=en_US.UTF-8   # 한글 파일명 인코딩 오류 방지 (rsync가 이것 때문에 실패한 적 있음)

SRC="${WIKI_SRC:-$HOME/Library/CloudStorage/SynologyDrive-daesan-wiki-sync/raw/sources}"
DST="${WIKI_DST:-$HOME/LLMWiki/daesan-wiki-sync/raw/sources}"
MODE="${1:-preview}"

[ -d "$SRC" ] || { echo "원본 없음: $SRC" >&2; exit 1; }
[ -d "$DST" ] || { echo "대상 없음: $DST" >&2; exit 1; }

OPTS=(-rlt --update
  --exclude='.DS_Store' --exclude='.cache/' --exclude='*_Conflict*' --exclude='.llm-wiki/')

case "$MODE" in
  preview|"")
    echo "[미리보기] $SRC → $DST"
    # rsync -n 은 한글 이름을 8진수로 깨뜨려 출력하므로, 같은 규칙을 Python으로 계산해 읽기 쉽게 보여 준다.
    python3 -I - "$SRC" "$DST" <<'PY'
import os, sys
src, dst = sys.argv[1], sys.argv[2]
EXCL_NAMES = {".DS_Store"}
def excluded(rel):
    parts = rel.split(os.sep)
    if ".cache" in parts or ".llm-wiki" in parts: return True
    if any(p in EXCL_NAMES for p in parts): return True
    return "_Conflict" in os.path.basename(rel)
todo, same = [], 0
for dp, dn, fn in os.walk(src):
    for f in fn:
        p = os.path.join(dp, f); rel = os.path.relpath(p, src)
        if excluded(rel): continue
        q = os.path.join(dst, rel)
        if not os.path.exists(q):
            todo.append(("새 파일", rel)); continue
        s, d = os.stat(p), os.stat(q)
        if s.st_size != d.st_size and s.st_mtime > d.st_mtime:
            todo.append(("변경됨", rel))
        else:
            same += 1
for kind, rel in sorted(todo, key=lambda x: x[1]):
    print(f"  {kind}: {rel}")
print(f"복사 대상 {len(todo)}개 (이미 같거나 더 새로움 {same}개는 건너뜀). 삭제는 하지 않음.")
PY
    echo "[미리보기 끝] 실제로 복사하려면: scripts/wiki_sync.sh --apply"
    ;;
  --apply)
    echo "[적용] $SRC → $DST"
    rsync "${OPTS[@]}" "$SRC/" "$DST/"
    echo "[적용 끝]"
    ;;
  *)
    echo "알 수 없는 옵션: $MODE (preview 또는 --apply)" >&2
    exit 2
    ;;
esac
