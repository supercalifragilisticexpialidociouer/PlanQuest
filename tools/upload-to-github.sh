#!/usr/bin/env bash
# PlanQuest · 一键上传到 GitHub（源码 + Releases 大文件）
#
# 用法：
#   GITHUB_TOKEN=ghp_xxx bash tools/upload-to-github.sh
#
# 做两件事：
#   1) git init + commit + push 源码到仓库（自动排除 node_modules / dist 发布包）
#   2) 用 GitHub REST API 创建 Release 并上传 5 个大文件（走 uploads.github.com，不受网页 100MB 限制）
#
# 令牌需要 repo 权限。脚本不会把令牌写进任何文件（remote URL 用一次性注入，push 后清除）。
set -euo pipefail

REPO_OWNER="supercalifragilisticexpialidociouer"
REPO_NAME="PlanQuest"
TAG="v2.9.11"
BRANCH="main"

: "${GITHUB_TOKEN:?请先设置 GITHUB_TOKEN 环境变量}"

echo "==> 仓库: https://github.com/$REPO_OWNER/$REPO_NAME"
echo "==> 令牌长度: ${#GITHUB_TOKEN} 字符（不会写入任何文件）"

# ---------- 第 1 段：源码进 git 仓库 ----------
echo ""
echo "== [1/2] 准备源码 git 仓库 =="

# 写一个安全的 .gitignore（只影响上传，不动用户现有文件）
cat > .gitignore <<'GITEOF'
# 依赖（458MB，绝不上传）
node_modules/
**/node_modules/

# 发布产物（>100MB，走 Releases，不进仓库）
dist/PlanQuest-win64-portable.zip
dist/releases/*.exe
dist/PlanQuest-win64/PlanQuest.exe

# -electron 运行时缓存 / 临时
*.log
.DS_Store
thumbs.db
.trash-docs/
.workbuddy/

# 截图与临时产物（可选保留，体积不大就不排）
# shots/
GITEOF

if [ ! -d .git ]; then
  git init -b "$BRANCH"
fi

# 令牌只用于这一次 push，用临时 remote，结束后删除
TMP_REMOTE="pqtmp"
git remote remove "$TMP_REMOTE" 2>/dev/null || true
git remote add "$TMP_REMOTE" "https://${GITHUB_TOKEN}@github.com/${REPO_OWNER}/${REPO_NAME}.git"

git config user.name  "PlanQuest Uploader"
git config user.email "zirc0656@agent.qq.com"

# 提交前检查有没有漏网的 >100MB 文件（GitHub 硬限制）
echo "==> 检查待提交文件中是否有 >100MB（GitHub 会拒绝）"
BIG=$(find . -path ./node_modules -prune -o -path ./.git -prune -o -type f -size +100M -print 2>/dev/null \
      | grep -vE '^\./dist/(PlanQuest-win64-portable\.zip|releases/.*\.exe|PlanQuest-win64/PlanQuest\.exe)$' || true)
if [ -n "$BIG" ]; then
  echo "!! 以下文件 >100MB 且未被 .gitignore 排除，git push 会失败："
  echo "$BIG"
  echo "!! 请把它们加进 .gitignore 或改走 Releases。"
fi

git add -A
echo "==> 暂存文件数: $(git diff --cached --name-only | wc -l)"
git commit -m "PlanQuest v2.9.11: 源码与文档首次上传" || echo "(没有新变更，跳过 commit)"

echo "==> 推送源码到 $BRANCH"
git push -u "$TMP_REMOTE" "$BRANCH" --force
git remote remove "$TMP_REMOTE"   # 推送后立即抹掉含令牌的 remote

echo "== [1/2] 源码上传完成 =="

# ---------- 第 2 段：大文件走 Releases API ----------
echo ""
echo "== [2/2] 创建 Release 并上传大文件 =="

API="https://api.github.com"

# 创建 release（若已存在则复用）
RELEASE_JSON=$(curl -sS -X POST "$API/repos/$REPO_OWNER/$REPO_NAME/releases" \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -d "{\"tag_name\":\"$TAG\",\"name\":\"PlanQuest $TAG\",\"body\":\"绿色版 + 安装助手。新手期翻案隔离、五源冗余更新。\",\"draft\":false,\"prerelease\":false}")
RELEASE_ID=$(echo "$RELEASE_JSON" | grep -o '"id": *[0-9]*' | head -1 | grep -o '[0-9]*' || true)
if [ -z "$RELEASE_ID" ]; then
  echo "!! 创建 Release 失败，响应："
  echo "$RELEASE_JSON" | head -c 500
  exit 1
fi
echo "==> Release ID: $RELEASE_ID"

# 上传 5 个大文件
upload_one() {
  local FILE="$1"
  if [ ! -f "$FILE" ]; then
    echo "  跳过（不存在）: $FILE"
    return
  fi
  local NAME
  NAME=$(basename "$FILE")
  echo "  上传 $NAME ($(du -h "$FILE" | cut -f1)) ..."
  curl -sS -X POST \
    "https://uploads.github.com/repos/$REPO_OWNER/$REPO_NAME/releases/$RELEASE_ID/assets?name=$NAME" \
    -H "Authorization: Bearer $GITHUB_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    -H "Content-Type: application/octet-stream" \
    --data-binary @"$FILE" \
    -o /dev/null -w "    HTTP %{http_code}  %{size_upload} bytes\n"
}

upload_one "dist/PlanQuest-win64-portable.zip"
upload_one "dist/releases/PlanQuest-2.9.11-setup.exe"
upload_one "dist/releases/PlanQuest-2.9.10-setup.exe"
upload_one "dist/releases/PlanQuest-2.9.9-setup.exe"
upload_one "dist/releases/PlanQuest-安装助手.exe"

echo ""
echo "== [2/2] Releases 上传完成 =="
echo "== 全部完成。仓库: https://github.com/$REPO_OWNER/$REPO_NAME"
echo "== 下载页: https://github.com/$REPO_OWNER/$REPO_NAME/releases/tag/$TAG"
