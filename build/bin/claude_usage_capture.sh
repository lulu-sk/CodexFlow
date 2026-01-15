#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)
#
# claude_usage_capture.sh
# Claude Code 用量抓取（WSL/Linux）：通过 tmux 运行 `claude` 并在 TUI 内触发 `/usage`，然后解析屏幕内容输出 JSON。
#
# 用法：./claude_usage_capture.sh
# 输出：JSON（stdout）
#
# 退出码：
#   0  - 成功
#   12 - TUI 启动失败/超时
#   13 - 需要登录（或 CLI 弹出登录提示）
#   14 - 未找到 claude CLI
#   15 - 未找到 tmux
#   16 - 解析失败
#   17 - 需要一次性手动完成 Claude Code 初始化（如条款确认）
#
# 说明：
# - 本脚本参考 `agent-sessions-main`（macOS）项目的实现，但针对 Win11+WSL 场景调整了提示文案。
# - 注意：`/usage` 可能触发网络请求，理论上可能计入 Claude Code 用量；本应用默认只在手动刷新时调用。
#

set -euo pipefail

# =============================================================================
# 配置（可通过环境变量覆盖）
# =============================================================================
MODEL="${MODEL:-sonnet}"
TIMEOUT_SECS="${TIMEOUT_SECS:-10}"
SLEEP_BOOT="${SLEEP_BOOT:-0.4}"
SLEEP_AFTER_USAGE="${SLEEP_AFTER_USAGE:-2.0}"
WORKDIR="${WORKDIR:-$(pwd)}"
# CLAUDE_TUI_DEBUG=1 时在解析失败时输出更多诊断信息

# Unique label to avoid interference
LABEL="cf-cc-$$"
SESSION="usage"

# =============================================================================
# 错误输出（统一 JSON）
# =============================================================================
error_json() {
  local code="$1"
  local hint="$2"
  cat <<EOF
{"ok":false,"error":"$code","hint":"$hint"}
EOF
}

# =============================================================================
# Cleanup trap
# =============================================================================
cleanup() {
  "${TMUX_CMD:-tmux}" -L "$LABEL" kill-server 2>/dev/null || true
}
trap cleanup EXIT

# =============================================================================
# 依赖检查
# =============================================================================

# tmux
TMUX_CMD="${TMUX_BIN:-tmux}"
if [[ -n "${TMUX_BIN:-}" ]]; then
  if [[ ! -x "$TMUX_BIN" ]]; then
    echo "$(error_json tmux_not_found "Binary not executable: $TMUX_BIN")"
    echo "ERROR: TMUX_BIN not executable: $TMUX_BIN" >&2
    exit 15
  fi
else
  if ! command -v tmux &>/dev/null; then
    echo "$(error_json tmux_not_found '请在 WSL 内安装 tmux：sudo apt update && sudo apt install -y tmux')"
    echo "ERROR: tmux not found" >&2
    exit 15
  fi
fi

# claude CLI
CLAUDE_CMD="${CLAUDE_BIN:-claude}"
if [[ -n "${CLAUDE_BIN:-}" ]]; then
  if [[ ! -x "$CLAUDE_BIN" ]]; then
    echo "$(error_json claude_cli_not_found "Binary not executable: $CLAUDE_BIN")"
    echo "ERROR: CLAUDE_BIN not executable: $CLAUDE_BIN" >&2
    exit 14
  fi
else
  if ! command -v claude &>/dev/null; then
    echo "$(error_json claude_cli_not_found '未找到 claude 命令。请在当前环境安装 Claude Code CLI，并确保 `claude` 在 PATH 中。')"
    echo "ERROR: claude CLI not found on PATH" >&2
    exit 14
  fi
fi

# =============================================================================
# 启动 Claude（tmux 后台）
# =============================================================================

# 使用 WORKDIR 运行，尽量避免触发项目扫描/信任提示
"$TMUX_CMD" -L "$LABEL" new-session -d -s "$SESSION" \
  "cd '$WORKDIR' && env TERM=xterm-256color '$CLAUDE_CMD' --model $MODEL"

# 固定面板大小，提升解析稳定性
"$TMUX_CMD" -L "$LABEL" resize-pane -t "$SESSION:0.0" -x 120 -y 32

# =============================================================================
# 等待 TUI 启动
# =============================================================================

sleep 1

iterations=0
max_iterations=$((TIMEOUT_SECS * 10 / 4))
booted=false

while [ $iterations -lt $max_iterations ]; do
  sleep "$SLEEP_BOOT"
  ((iterations++))

  output=$("$TMUX_CMD" -L "$LABEL" capture-pane -t "$SESSION:0.0" -p 2>/dev/null || echo "")

  # 信任提示：自动按回车继续
  if echo "$output" | grep -q "Do you trust the files in this folder?"; then
    "$TMUX_CMD" -L "$LABEL" send-keys -t "$SESSION:0.0" Enter
    sleep 1.0
    continue
  fi

  # 一次性初始化/条款确认：不自动选择，提示用户手动处理
  if echo "$output" | grep -q "Please select how you'd like to continue" || echo "$output" | grep -q "Help improve Claude"; then
    echo "$(error_json manual_setup_required "Claude Code 需要一次性初始化。请打开终端运行：claude")"
    echo "ERROR: manual setup required (terms prompt)" >&2
    echo "$output" >&2
    exit 17
  fi

  # 首次运行主题选择：默认回车
  if echo "$output" | grep -qE '(Choose the text style|Dark mode|Light mode)'; then
    "$TMUX_CMD" -L "$LABEL" send-keys -t "$SESSION:0.0" Enter
    sleep 1.0
    continue
  fi

  # 启动标志（尽量宽松）
  if echo "$output" | grep -qE '(Claude Code v|Try "|Thinking on|tab to toggle)'; then
    if ! echo "$output" | grep -qE '(Do you trust|Choose the text style)'; then
      booted=true
      break
    fi
  fi

  # 登录提示
  if echo "$output" | grep -qE '(sign in|login|authentication|unauthorized|Please run.*claude login|Select login method)'; then
    echo "$(error_json auth_required_or_cli_prompted_login '请先在终端登录：claude login')"
    echo "ERROR: login required" >&2
    echo "$output" >&2
    exit 13
  fi
done

if [ "$booted" = false ]; then
  echo "$(error_json tui_failed_to_boot "TUI 未在 ${TIMEOUT_SECS}s 内启动")"
  echo "ERROR: TUI failed to boot within ${TIMEOUT_SECS}s" >&2
  last_output=$("$TMUX_CMD" -L "$LABEL" capture-pane -t "$SESSION:0.0" -p 2>/dev/null || echo "(capture failed)")
  echo "Last output:" >&2
  echo "$last_output" >&2
  exit 12
fi

# =============================================================================
# 触发 /usage 并切换到 Usage 区域
# =============================================================================

"$TMUX_CMD" -L "$LABEL" send-keys -t "$SESSION:0.0" "/" 2>/dev/null
sleep 0.2
"$TMUX_CMD" -L "$LABEL" send-keys -t "$SESSION:0.0" "usage" 2>/dev/null
sleep 0.3
"$TMUX_CMD" -L "$LABEL" send-keys -t "$SESSION:0.0" Enter 2>/dev/null

sleep "$SLEEP_AFTER_USAGE"

# Tab 到 Usage（布局可能变化，保守发送几次）
for _ in 1 2 3 4; do
  "$TMUX_CMD" -L "$LABEL" send-keys -t "$SESSION:0.0" Tab 2>/dev/null
  sleep 0.25
done

capture_usage() {
  "$TMUX_CMD" -L "$LABEL" capture-pane -t "$SESSION:0.0" -p -S -300 2>/dev/null || echo ""
}

usage_output=$(capture_usage)

ensure_usage_visible() {
  tries=0
  while [ $tries -lt 3 ]; do
    if echo "$usage_output" | grep -q "Current session"; then
      return 0
    fi
    for _ in 1 2 3 4; do
      "$TMUX_CMD" -L "$LABEL" send-keys -t "$SESSION:0.0" Tab 2>/dev/null || true
      sleep 0.25
    done
    sleep 0.8
    usage_output=$(capture_usage)
    tries=$((tries+1))
  done
}

ensure_usage_visible

# =============================================================================
# 解析 Usage 屏幕
# =============================================================================

extract_pct_and_reset() {
  local anchor="$1"; shift
  local block
  block=$(echo "$usage_output" | awk -v a="$anchor" '
    BEGIN{c=0}
    {
      if (index($0,a)>0) { c=4 }
      if (c>0) { print; c-- }
    }
  ')

  local pct
  pct=$(echo "$block" | awk '
    BEGIN { pct = "" }
    {
      if (/Resets/) next

      if (tolower($0) ~ /% *used/) {
        if (match($0, /[0-9]+/)) {
          pct = 100 - substr($0, RSTART, RLENGTH)
          if (pct < 0) pct = 0
          if (pct > 100) pct = 100
          exit
        }
      }

      if (tolower($0) ~ /% *(left|remaining)/) {
        if (match($0, /[0-9]+/)) {
          pct = substr($0, RSTART, RLENGTH)
          exit
        }
      }

      if (pct == "" && match($0, /[0-9]+%/)) {
        pct = substr($0, RSTART, RLENGTH-1)
        exit
      }
    }
    END { print pct }
  ')

  local resets
  resets=$(echo "$block" | awk '
    /Resets/ {
      sub(/^.*Resets[ \t]*/, "")
      gsub(/^[ \t]+|[ \t]+$/, "")
      print
      exit
    }
  ')

  echo "$pct" "$resets"
}

read session_pct session_resets < <(extract_pct_and_reset "Current session")

week_anchor=$(echo "$usage_output" | awk 'BEGIN{IGNORECASE=1} /Current week \\(all models\\)|Current week \\(all-models\\)|Current week/ {print; exit}')
if [ -n "$week_anchor" ]; then
  read week_all_pct week_all_resets < <(extract_pct_and_reset "Current week")
else
  week_all_pct=""; week_all_resets=""
fi

if echo "$usage_output" | grep -q "Current week (Opus)"; then
  read week_opus_pct week_opus_resets < <(extract_pct_and_reset "Current week (Opus)")
  week_opus_json="{\"pct_left\": ${week_opus_pct:-0}, \"resets\": \"${week_opus_resets}\"}"
else
  week_opus_json="null"
fi

if [ -z "$session_pct" ] || [ -z "$week_all_pct" ]; then
  "$TMUX_CMD" -L "$LABEL" send-keys -t "$SESSION:0.0" Escape 2>/dev/null || true
  sleep 0.2
  "$TMUX_CMD" -L "$LABEL" send-keys -t "$SESSION:0.0" "/" 2>/dev/null
  sleep 0.2
  "$TMUX_CMD" -L "$LABEL" send-keys -t "$SESSION:0.0" "usage" 2>/dev/null
  sleep 0.2
  "$TMUX_CMD" -L "$LABEL" send-keys -t "$SESSION:0.0" Enter 2>/dev/null
  sleep "$SLEEP_AFTER_USAGE"
  usage_output=$(capture_usage)
  read session_pct session_resets < <(extract_pct_and_reset "Current session")
  read week_all_pct week_all_resets < <(extract_pct_and_reset "Current week")
fi

if [ -z "$session_pct" ] || [ -z "$week_all_pct" ]; then
  if [ "${CLAUDE_TUI_DEBUG:-0}" != "0" ]; then
    debug_file="$(mktemp -t claude_usage_pane)"
    echo "$usage_output" > "$debug_file"
    echo "DEBUG: Raw captured output saved to $debug_file" >&2
    echo "DEBUG: session_pct='$session_pct' week_all_pct='$week_all_pct'" >&2
    echo "DEBUG: session_resets='$session_resets' week_all_resets='$week_all_resets'" >&2
  fi
  echo "$(error_json parsing_failed '无法从 TUI 中解析用量信息。可设置 CLAUDE_TUI_DEBUG=1 获取更多信息。')"
  exit 16
fi

# =============================================================================
# 输出 JSON
# =============================================================================

cat <<EOF
{
  "ok": true,
  "source": "tmux-capture",
  "session_5h": {
    "pct_left": $session_pct,
    "resets": "$session_resets"
  },
  "week_all_models": {
    "pct_left": $week_all_pct,
    "resets": "$week_all_resets"
  },
  "week_opus": $week_opus_json
}
EOF

exit 0
