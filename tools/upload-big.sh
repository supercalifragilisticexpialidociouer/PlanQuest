#!/usr/bin/env bash
# PlanQuest · 逐个上传大文件到 GitHub Release v2.9.11
# 本机出口约 118KB/s，单文件 161~194MB，需 20~30 分钟且必须全程不断线。
# 失败会留下 state=starter 的半成品，脚本会先清理再重试。
set -u
cd "$(dirname "$0")/.." || exit 1
TOK=$(cat .gh_token_tmp)
OWNER=supercalifragilisticexpialidociouer
REPO=PlanQuest
RID=455511094
API="https://api.github.com/repos/$OWNER/$REPO/releases/assets"
UP="https://uploads.github.com/repos/$OWNER/$REPO/releases/$RID/assets"
LOG="$(pwd)/tools/upload-big.log"

FILES=(
  "dist/releases/PlanQuest-2.9.11-setup.exe"
  "dist/releases/PlanQuest-2.9.10-setup.exe"
  "dist/releases/PlanQuest-2.9.9-setup.exe"
  "dist/PlanQuest-win64-portable.zip"
)

log(){ echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG"; }

cleanup_starter(){
  # 删除所有 state != uploaded 的同名半成品
  local name="$1"
  local ids
  ids=$(curl -s -m 30 -H "Authorization: Bearer $TOK" "https://api.github.com/repos/$OWNER/$REPO/releases/$RID" \
    | python -c "
import sys,json
try:
    d=json.load(sys.stdin)
    for a in d.get('assets',[]):
        if a['name']=='$name' and a.get('state')!='uploaded':
            print(a['id'])
except Exception: pass
")
  for id in $ids; do
    log "  清理半成品 asset id=$id"
    curl -s -m 30 -o /dev/null -X DELETE -H "Authorization: Bearer $TOK" "$API/$id"
  done
}

upload_one(){
  local rel="$1"
  local name; name=$(basename "$rel")
  local size; size=$(stat -c%s "$rel" 2>/dev/null || echo 0)
  local mb=$((size/1048576))
  log ">>> 开始 $name (${mb}MB)"
  local ok=0
  for attempt in 1 2 3; do
    cleanup_starter "$name"
    local resp="tools/_up_resp.json"
    rm -f "$resp"
    log "  第 $attempt 次尝试..."
    # 3600s 超时；--speed-limit/time 防止假死；流式读文件
    local code
    code=$(curl -s -m 3600 --speed-time 300 --speed-limit 1024 \
      -o "$resp" -w "%{http_code}" \
      -X POST -H "Authorization: Bearer $TOK" -H "Accept: application/vnd.github+json" \
      -H "Content-Type: application/octet-stream" \
      --data-binary @"$rel" "$UP?name=$name")
    local state
    state=$(python -c "
import json
try:
    d=json.load(open('$resp'))
    print(d.get('state','?') if isinstance(d,dict) else '?')
except Exception: print('?')
" 2>/dev/null)
    log "  HTTP $code state=$state"
    if [ "$code" = "201" ] && [ "$state" = "uploaded" ]; then
      log "  ✓ 成功 $name"
      ok=1
      rm -f "$resp"
      break
    fi
    log "  失败，等待 10s 后重试 (resp: $(head -c 120 "$resp" 2>/dev/null))"
    sleep 10
  done
  if [ "$ok" = "0" ]; then log "  ✗ 放弃 $name（网络限制，需手动/换网）"; fi
}

: > "$LOG"
log "上传任务启动，共 ${#FILES[@]} 个文件"
for f in "${FILES[@]}"; do upload_one "$f"; done
log "全部结束"
echo "DONE" >> "$LOG"
