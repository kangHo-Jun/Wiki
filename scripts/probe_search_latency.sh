#!/bin/zsh
# 위키 검색 API 지연 측정기 (읽기 전용).
# 앱을 오래 쉬게 둔 뒤(예: 아침 첫 사용 전) 실행하면 "첫 검색(콜드)"과 "다음 검색(웜)" 시간을 비교할 수 있다.
# 토큰은 ~/.claude.json 의 llm-wiki MCP 설정에서 읽고 화면·로그에 출력하지 않는다.
# 결과는 outputs/search-latency.log 에 한 줄씩 추가된다.

set -u
BASE=${LLM_WIKI_API_BASE_URL:-http://127.0.0.1:19828}
LOG=${0:A:h}/../outputs/search-latency.log
mkdir -p "${LOG:h}"
TOKEN=$(python3 -I -c "import json,os;print(json.load(open(os.path.expanduser('~/.claude.json')))['mcpServers']['llm-wiki']['env']['LLM_WIKI_API_TOKEN'])")
APP_PID=$(pgrep -f '/Applications/LLM Wiki.app/Contents/MacOS/llm-wiki' | head -1)
RSS=$( [ -n "$APP_PID" ] && ps -o rss= -p "$APP_PID" | tr -d ' ' )
STAMP=$(date '+%Y-%m-%d %H:%M:%S')

health=$(curl -s -o /dev/null -w '%{http_code}/%{time_total}s' --max-time 10 "$BASE/api/v1/health")
line="$STAMP health=$health appRSS_KB=${RSS:-?}"
for q in '포켓도어 수리' 'MDF 하중' '사다리차 대기료'; do
  body=$(python3 -I -c "import json,sys;print(json.dumps({'query':sys.argv[1],'topK':5}))" "$q")
  r=$(curl -s -o /dev/null -w '%{http_code}/%{time_total}s' --max-time 240 \
      -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
      -X POST "$BASE/api/v1/projects/current/search" -d "$body")
  line="$line | $q=$r"
done
echo "$line" | tee -a "$LOG"
