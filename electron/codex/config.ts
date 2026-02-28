// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { perfLogger } from "../log";
import { getCodexRootsFastAsync, uncToWsl } from "../wsl";

const REQUIRED_NOTIFICATION = "agent-turn-complete";
const REQUIRED_NOTIFICATION_METHOD = "osc9";
const NOTIFICATIONS_KEY = "notifications";
const NOTIFICATION_METHOD_KEY = "notification_method";
const ROOT_NOTIFY_KEY = "notify";
const DOTTED_TUI_NOTIFICATIONS_KEY = "tui.notifications";
const DOTTED_TUI_NOTIFICATION_METHOD_KEY = "tui.notification_method";
const CODEX_NOTIFY_SH_FILENAME = "codexflow_after_agent_notify.sh";
const CODEX_NOTIFY_PS1_FILENAME = "codexflow_after_agent_notify.ps1";
const CODEX_NOTIFY_JSONL_FILENAME = "codexflow_after_agent_notify.jsonl";
const CODEX_NOTIFY_FILE_MAX_BYTES = 512 * 1024;
const CODEX_NOTIFY_ENV_TAB_ID = "CODEXFLOW_NOTIFY_TAB_ID";
const CODEX_NOTIFY_ENV_ENV_LABEL = "CODEXFLOW_NOTIFY_ENV_LABEL";
const CODEX_NOTIFY_ENV_PROVIDER_ID = "CODEXFLOW_NOTIFY_PROVIDER_ID";

const CODEX_NOTIFY_SH_SCRIPT = [
  "#!/usr/bin/env sh",
  "# SPDX-License-Identifier: Apache-2.0",
  "# Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)",
  "",
  "# 中文说明：Codex legacy notify hook -> CodexFlow JSONL 完成事件桥接（无论终端焦点如何均写入）。",
  "set -eu",
  "",
  "SCRIPT_DIR=$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd)",
  "NOTIFY_PATH=\"${SCRIPT_DIR}/" + CODEX_NOTIFY_JSONL_FILENAME + "\"",
  "TAB_ID=\"${" + CODEX_NOTIFY_ENV_TAB_ID + ":-}\"",
  "ENV_LABEL=\"${" + CODEX_NOTIFY_ENV_ENV_LABEL + ":-}\"",
  "PROVIDER_ID=\"${" + CODEX_NOTIFY_ENV_PROVIDER_ID + ":-codex}\"",
  "RAW_PAYLOAD=\"${1-}\"",
  "",
  "json_escape() {",
  "  printf \"%s\" \"$1\" | sed 's/\\\\/\\\\\\\\/g; s/\"/\\\\\"/g'",
  "}",
  "",
  "PREVIEW=\"\"",
  "if [ -n \"$RAW_PAYLOAD\" ]; then",
  "  PREVIEW=$(printf \"%s\" \"$RAW_PAYLOAD\" | sed -n 's/.*\"last-assistant-message\"[[:space:]]*:[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p' | head -n 1 || true)",
  "fi",
  "PREVIEW=$(printf \"%s\" \"$PREVIEW\" | tr '\\r\\n\\t' '   ' | sed 's/[[:space:]][[:space:]]*/ /g; s/^ *//; s/ *$//')",
  "if [ -z \"$PREVIEW\" ]; then",
  "  PREVIEW=\"agent-turn-complete\"",
  "fi",
  "",
  "if [ -f \"$NOTIFY_PATH\" ]; then",
  "  SIZE=$(wc -c < \"$NOTIFY_PATH\" 2>/dev/null || echo 0)",
  "  if [ \"${SIZE:-0}\" -gt \"" + String(CODEX_NOTIFY_FILE_MAX_BYTES) + "\" ]; then",
  "    : > \"$NOTIFY_PATH\"",
  "  fi",
  "fi",
  "",
  "EVENT_ID=\"$$-$(date +%s 2>/dev/null || echo 0)\"",
  "TIMESTAMP=\"$(date -u +\"%Y-%m-%dT%H:%M:%SZ\" 2>/dev/null || date +\"%Y-%m-%dT%H:%M:%S%z\" 2>/dev/null || echo \"\")\"",
  "",
  "printf '{\"v\":1,\"eventId\":\"%s\",\"providerId\":\"%s\",\"tabId\":\"%s\",\"envLabel\":\"%s\",\"preview\":\"%s\",\"timestamp\":\"%s\"}\\n' \\",
  "  \"$(json_escape \"$EVENT_ID\")\" \\",
  "  \"$(json_escape \"$PROVIDER_ID\")\" \\",
  "  \"$(json_escape \"$TAB_ID\")\" \\",
  "  \"$(json_escape \"$ENV_LABEL\")\" \\",
  "  \"$(json_escape \"$PREVIEW\")\" \\",
  "  \"$(json_escape \"$TIMESTAMP\")\" >> \"$NOTIFY_PATH\" 2>/dev/null || true",
  "",
  "exit 0",
].join("\n") + "\n";

const CODEX_NOTIFY_PS1_SCRIPT = [
  "# SPDX-License-Identifier: Apache-2.0",
  "# Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)",
  "",
  "param(",
  "  [Parameter(ValueFromRemainingArguments=$true)]",
  "  [string[]]$RemainingArgs",
  ")",
  "",
  "$ErrorActionPreference = \"SilentlyContinue\"",
  "$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path",
  `$NotifyPath = Join-Path $ScriptDir "${CODEX_NOTIFY_JSONL_FILENAME}"`,
  `$TabId = [string]$env:${CODEX_NOTIFY_ENV_TAB_ID}`,
  `$EnvLabel = [string]$env:${CODEX_NOTIFY_ENV_ENV_LABEL}`,
  `$ProviderId = [string]$env:${CODEX_NOTIFY_ENV_PROVIDER_ID}`,
  "if ([string]::IsNullOrWhiteSpace($ProviderId)) { $ProviderId = \"codex\" }",
  "",
  "$RawPayload = \"\"",
  "if ($RemainingArgs -and $RemainingArgs.Count -gt 0) {",
  "  $RawPayload = [string]$RemainingArgs[$RemainingArgs.Count - 1]",
  "}",
  "",
  "$Preview = \"\"",
  "if (-not [string]::IsNullOrWhiteSpace($RawPayload)) {",
  "  try {",
  "    $obj = $RawPayload | ConvertFrom-Json -ErrorAction Stop",
  "    $Preview = [string]$obj.\"last-assistant-message\"",
  "  } catch {}",
  "}",
  "if (-not [string]::IsNullOrWhiteSpace($Preview)) {",
  "  $Preview = ($Preview -replace \"\\s+\", \" \").Trim()",
  "}",
  "if ([string]::IsNullOrWhiteSpace($Preview)) { $Preview = \"agent-turn-complete\" }",
  "",
  "try {",
  "  if (Test-Path -LiteralPath $NotifyPath) {",
  `    if ((Get-Item -LiteralPath $NotifyPath).Length -gt ${CODEX_NOTIFY_FILE_MAX_BYTES}) {`,
  "      Set-Content -LiteralPath $NotifyPath -Value \"\" -Encoding UTF8",
  "    }",
  "  }",
  "} catch {}",
  "",
  "$LineObj = @{",
  "  v = 1",
  "  eventId = \"${PID}-$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())\"",
  "  providerId = $ProviderId",
  "  tabId = $TabId",
  "  envLabel = $EnvLabel",
  "  preview = $Preview",
  "  timestamp = [DateTime]::UtcNow.ToString(\"o\")",
  "}",
  "$Line = $LineObj | ConvertTo-Json -Compress",
  "Add-Content -LiteralPath $NotifyPath -Value $Line -Encoding UTF8",
  "exit 0",
].join("\n") + "\n";

type NormalizeResult = { updated: string; changed: boolean };
type CodexNotifyCommandSpec = { scriptPath: string; scriptBody: string; commandArgv: string[] };

type ArrayScanState = {
  depth: number;
  hasBracket: boolean;
  inSingle: boolean;
  inDouble: boolean;
  escaped: boolean;
  done: boolean;
};

function normalizeLineEndings(input: string): { normalized: string; newline: string } {
  if (!input) return { normalized: "", newline: "\n" };
  const newline = input.includes("\r\n") ? "\r\n" : "\n";
  const normalized = newline === "\n" ? input : input.replace(/\r\n/g, "\n");
  return { normalized, newline };
}

function splitInlineComment(line: string): { code: string; comment: string } {
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (!inDouble && ch === "'") {
      inSingle = !inSingle;
      continue;
    }
    if (!inSingle && ch === '"') {
      inDouble = !inDouble;
      continue;
    }
    if (!inSingle && !inDouble && ch === "#") {
      return { code: line.slice(0, i), comment: line.slice(i).trim() };
    }
  }
  return { code: line, comment: "" };
}

function feedArrayState(state: ArrayScanState, fragment: string): void {
  for (let i = 0; i < fragment.length; i++) {
    const ch = fragment[i];
    if (state.escaped) {
      state.escaped = false;
      continue;
    }
    if (ch === "\\") {
      state.escaped = true;
      continue;
    }
    if (!state.inDouble && ch === "'") {
      state.inSingle = !state.inSingle;
      continue;
    }
    if (!state.inSingle && ch === '"') {
      state.inDouble = !state.inDouble;
      continue;
    }
    if (state.inSingle || state.inDouble) continue;
    if (ch === "[") {
      state.hasBracket = true;
      state.depth += 1;
    } else if (ch === "]") {
      if (state.depth > 0) state.depth -= 1;
      if (state.hasBracket && state.depth === 0) state.done = true;
    }
  }
}

function extractArrayValues(raw: string): string[] {
  const values: string[] = [];
  let current = "";
  let inString = false;
  let quote = '"';
  let escaped = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (!inString) {
      if (ch === '"' || ch === "'") {
        inString = true;
        quote = ch;
        current = "";
      }
      continue;
    }
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      if (quote === '"') {
        escaped = true;
        current += ch;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === quote) {
      let decoded = current;
      if (quote === '"') {
        try {
          decoded = JSON.parse(`"${current.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
        } catch {
          decoded = current;
        }
      }
      values.push(decoded);
      current = "";
      inString = false;
      continue;
    }
    current += ch;
  }
  return values;
}

function dedupePreservingOrder<T>(list: T[]): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const item of list) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

/**
 * 中文说明：判断文件中是否存在 [tui] 表头。
 */
function hasTuiTableHeader(lines: string[]): boolean {
  for (const line of lines) {
    const sectionMatch = String(line || "").match(/^(\s*\[([^\]\[]+)\])(\s*)(.*)$/);
    if (!sectionMatch) continue;
    const section = sectionMatch[2].trim().toLowerCase();
    if (section === "tui") return true;
  }
  return false;
}

/**
 * 中文说明：判断文件中是否出现任何 root 级的 tui.* dotted 配置（避免盲目追加 [tui] 导致 TOML 失效）。
 */
function hasRootTuiDottedKeys(lines: string[]): boolean {
  let sawAnySection = false;
  for (const rawLine of lines) {
    const sectionMatch = String(rawLine || "").match(/^(\s*\[([^\]\[]+)\])(\s*)(.*)$/);
    if (sectionMatch) {
      sawAnySection = true;
      continue;
    }
    if (sawAnySection) continue;
    const { code } = splitInlineComment(String(rawLine || ""));
    if (/^\s*tui\.[a-z0-9_.-]+\s*=/i.test(code)) return true;
  }
  return false;
}

type TomlArrayAssignment = {
  indent: string;
  key: string;
  comment: string;
  rawValue: string;
  endIndex: number;
  hasArray: boolean;
};

/**
 * 中文说明：解析一条 TOML 数组赋值（支持跨行与“= 后换行”写法）。
 */
function parseTomlArrayAssignment(lines: string[], startIndex: number, keyRegex: RegExp): TomlArrayAssignment | null {
  const { code, comment } = splitInlineComment(lines[startIndex] ?? "");
  const assignmentMatch = code.match(keyRegex);
  if (!assignmentMatch) return null;

  const indent = assignmentMatch[1] ?? "";
  const key = assignmentMatch[2] ?? "";
  const valueFragment = assignmentMatch[4] ?? "";

  const fragments: string[] = [valueFragment];
  let endIndex = startIndex;
  const state: ArrayScanState = { depth: 0, hasBracket: false, inSingle: false, inDouble: false, escaped: false, done: false };
  feedArrayState(state, valueFragment);

  while (!state.done && state.hasBracket && endIndex + 1 < lines.length) {
    endIndex += 1;
    const { code: nextCode } = splitInlineComment(lines[endIndex] ?? "");
    fragments.push(nextCode);
    feedArrayState(state, nextCode);
  }

  if (!state.hasBracket) {
    const probeFragments: string[] = [];
    const probeState: ArrayScanState = { ...state };
    let probeIndex = endIndex;
    // 中文说明：寻找下一行是否为数组起始，兼容 `key =` 换行写法。
    while (!probeState.done && probeIndex + 1 < lines.length) {
      const nextIndex = probeIndex + 1;
      const { code: nextCode } = splitInlineComment(lines[nextIndex] ?? "");
      const trimmedNext = nextCode.trim();
      if (trimmedNext === "") {
        probeFragments.push(nextCode);
        probeIndex = nextIndex;
        continue;
      }
      if (trimmedNext.startsWith("#")) break;
      probeFragments.push(nextCode);
      feedArrayState(probeState, nextCode);
      probeIndex = nextIndex;
      if (!probeState.hasBracket && !trimmedNext.startsWith("[")) {
        break;
      }
    }

    if (probeState.hasBracket) {
      fragments.push(...probeFragments);
      endIndex = probeIndex;
      Object.assign(state, probeState);
    }
  }

  const rawValue = fragments.join("\n").trim();
  return { indent, key, comment, rawValue, endIndex, hasArray: state.hasBracket };
}

/**
 * 中文说明：序列化为 TOML 的字符串数组（使用 JSON.stringify 保证转义正确）。
 */
function serializeTomlStringArray(values: string[]): string {
  return values.map((value) => JSON.stringify(value)).join(", ");
}

/**
 * 中文说明：将通知列表规范化为“去重 + 保留顺序 + 确保包含 required”。
 */
function normalizeTuiNotifications(values: string[]): string[] {
  const deduped = dedupePreservingOrder(values || []);
  if (!deduped.includes(REQUIRED_NOTIFICATION)) deduped.push(REQUIRED_NOTIFICATION);
  return deduped;
}

/**
 * 中文说明：移除 root 级的 tui.notifications / tui.notification_method，避免与 [tui] 配置重复导致 TOML 失效。
 * - 会返回从 tui.notifications 读取到的通知列表（用于后续合并到 [tui]）。
 */
function stripRootTuiDottedKeys(lines: string[]): { lines: string[]; changed: boolean; dottedNotifications: string[] } {
  let changed = false;
  const dottedNotifications: string[] = [];
  let sawAnySection = false;

  for (let i = 0; i < lines.length; i++) {
    const sectionMatch = String(lines[i] || "").match(/^(\s*\[([^\]\[]+)\])(\s*)(.*)$/);
    if (sectionMatch) {
      sawAnySection = true;
      continue;
    }
    if (sawAnySection) continue;

    const parsed = parseTomlArrayAssignment(lines, i, /^(\s*)(tui\.notifications)(\s*=\s*)(.*)$/i);
    if (parsed) {
      if (parsed.hasArray) {
        try { dottedNotifications.push(...extractArrayValues(parsed.rawValue)); } catch {}
      }
      lines.splice(i, parsed.endIndex - i + 1);
      i -= 1;
      changed = true;
      continue;
    }

    const { code } = splitInlineComment(String(lines[i] || ""));
    if (/^\s*tui\.notification_method\s*=/i.test(code)) {
      lines.splice(i, 1);
      i -= 1;
      changed = true;
      continue;
    }
  }

  return { lines, changed, dottedNotifications };
}

function findTuiSectionBounds(lines: string[]): { start: number; end: number } {
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) continue;
    const section = trimmed.slice(1, -1).trim().toLowerCase();
    if (section === "tui") {
      start = i;
      continue;
    }
    if (start >= 0) {
      end = i;
      break;
    }
  }
  return { start, end };
}

function updateNotificationsSection(normalized: string): NormalizeResult {
  const lines = normalized.length > 0 ? normalized.split("\n") : [];
  let changed = false;
  let tuiFound = false;
  let notificationsFound = false;
  let notificationMethodFound = false;

  // 中文说明：兼容 root 级 tui.* dotted 写法：存在 dotted 时，不要盲目追加 [tui]，否则会造成 TOML 解析失败。
  const tuiTableHeaderPresent = hasTuiTableHeader(lines);
  const rootTuiDottedPresent = hasRootTuiDottedKeys(lines);

  // 若存在 [tui] 表头，优先以表头为准，并移除 root 级的重复 dotted keys（避免重复键/表重定义导致配置失效）。
  const dottedMergeFromRoot: string[] = [];
  if (tuiTableHeaderPresent) {
    const stripped = stripRootTuiDottedKeys(lines);
    if (stripped.changed) changed = true;
    dottedMergeFromRoot.push(...stripped.dottedNotifications);
  }

  // 若没有 [tui] 表头但存在 root 级 dotted tui.*，则走 dotted 模式更新（避免追加 [tui]）。
  if (!tuiTableHeaderPresent && rootTuiDottedPresent) {
    let notificationsLineIndex = -1;
    let notificationsIndent = "";
    let notificationsComment = "";
    let notificationsValues: string[] = [];

    let methodLineIndex = -1;
    let methodIndent = "";
    let methodComment = "";

    let sawAnySection = false;
    for (let i = 0; i < lines.length; i++) {
      const sectionMatch = String(lines[i] || "").match(/^(\s*\[([^\]\[]+)\])(\s*)(.*)$/);
      if (sectionMatch) {
        sawAnySection = true;
        continue;
      }
      if (sawAnySection) continue;

      const parsed = parseTomlArrayAssignment(lines, i, /^(\s*)(tui\.notifications)(\s*=\s*)(.*)$/i);
      if (parsed) {
        const originalValues = parsed.hasArray ? extractArrayValues(parsed.rawValue) : [];
        const merged = normalizeTuiNotifications([...notificationsValues, ...originalValues]);
        const serializedValues = serializeTomlStringArray(merged);
        const rendered = `${parsed.indent}${DOTTED_TUI_NOTIFICATIONS_KEY} = [${serializedValues}]${parsed.comment ? ` ${parsed.comment}` : ""}`;

        if (notificationsLineIndex < 0) {
          notificationsLineIndex = i;
          notificationsIndent = parsed.indent;
          notificationsComment = parsed.comment;
          notificationsValues = merged;
          const originalBlock = lines.slice(i, parsed.endIndex + 1);
          lines.splice(i, parsed.endIndex - i + 1, rendered);
          if (originalBlock.length !== 1 || originalBlock[0] !== rendered) changed = true;
        } else {
          // 中文说明：重复 key 会导致 TOML 解析失败，合并到首条并删除后续重复项。
          notificationsValues = merged;
          lines[notificationsLineIndex] = `${notificationsIndent}${DOTTED_TUI_NOTIFICATIONS_KEY} = [${serializeTomlStringArray(notificationsValues)}]${notificationsComment ? ` ${notificationsComment}` : ""}`;
          lines.splice(i, parsed.endIndex - i + 1);
          i -= 1;
          changed = true;
        }
        tuiFound = true;
        notificationsFound = true;
        continue;
      }

      const { code, comment } = splitInlineComment(lines[i] ?? "");
      const methodMatch = code.match(/^(\s*)(tui\.notification_method)(\s*=\s*)(.*)$/i);
      if (methodMatch) {
        const indent = methodMatch[1] ?? "";
        const rendered = `${indent}${DOTTED_TUI_NOTIFICATION_METHOD_KEY} = "${REQUIRED_NOTIFICATION_METHOD}"${comment ? ` ${comment}` : ""}`;
        if (methodLineIndex < 0) {
          methodLineIndex = i;
          methodIndent = indent;
          methodComment = comment;
          if (lines[i] !== rendered) {
            lines[i] = rendered;
            changed = true;
          }
        } else {
          // 中文说明：重复 key 会导致 TOML 解析失败，保留首条并删除后续重复项。
          lines.splice(i, 1);
          i -= 1;
          changed = true;
        }
        tuiFound = true;
        notificationMethodFound = true;
        continue;
      }
    }

    // 仅当 root 级已经有 tui.* dotted 配置时，才在 root 级补齐缺失项，避免把新 key 插入到某个 section 内。
    const insertIndex = (() => {
      for (let i = 0; i < lines.length; i++) {
        const m = String(lines[i] || "").match(/^(\s*\[([^\]\[]+)\])(\s*)(.*)$/);
        if (m) return i;
      }
      return lines.length;
    })();

    const rootIndent = notificationsLineIndex >= 0 ? notificationsIndent : (methodLineIndex >= 0 ? methodIndent : "");
    const needsBlankBeforeInsert = insertIndex > 0 && lines[insertIndex - 1].trim() !== "";

    if (!notificationsFound) {
      const merged = normalizeTuiNotifications(notificationsValues);
      const rendered = `${rootIndent}${DOTTED_TUI_NOTIFICATIONS_KEY} = [${serializeTomlStringArray(merged)}]`;
      const toInsert = needsBlankBeforeInsert ? ["", rendered] : [rendered];
      lines.splice(insertIndex, 0, ...toInsert);
      changed = true;
      tuiFound = true;
      notificationsFound = true;
    }

    if (!notificationMethodFound) {
      const rendered = `${rootIndent}${DOTTED_TUI_NOTIFICATION_METHOD_KEY} = "${REQUIRED_NOTIFICATION_METHOD}"`;
      const idx = (() => {
        // 若刚插入了 notifications，并且 insertIndex 处有空行，则把 method 放在 notifications 后面更直观。
        const base = insertIndex + (needsBlankBeforeInsert ? 1 : 0);
        for (let i = base; i < Math.min(lines.length, base + 6); i++) {
          if (String(lines[i] || "").includes(DOTTED_TUI_NOTIFICATIONS_KEY)) return i + 1;
        }
        return insertIndex;
      })();
      if (idx === insertIndex && needsBlankBeforeInsert && lines[insertIndex] !== "") {
        lines.splice(insertIndex, 0, "");
      }
      lines.splice(idx, 0, rendered);
      changed = true;
      tuiFound = true;
      notificationMethodFound = true;
    }

    return { updated: lines.join("\n"), changed };
  }

  let inTui = false;
  let processedNotificationsInCurrentTui = false;
  let processedMethodInCurrentTui = false;
  let mergedFromRootDotted = false;

  for (let i = 0; i < lines.length; i++) {
    const sectionMatch = lines[i].match(/^(\s*\[([^\]\[]+)\])(\s*)(.*)$/);
    if (sectionMatch) {
      const section = sectionMatch[2].trim().toLowerCase();
      if (section === "tui") {
        tuiFound = true;
        inTui = true;
        processedNotificationsInCurrentTui = false;
        processedMethodInCurrentTui = false;
        mergedFromRootDotted = false;

        const headerPart = sectionMatch[1];
        const suffix = lines[i].slice(headerPart.length);
        const { code: suffixCode } = splitInlineComment(suffix);
        if (suffixCode.trim() !== "") {
          lines[i] = headerPart;
          lines.splice(i + 1, 0, suffix);
          changed = true;
        }
      } else {
        inTui = false;
      }
      continue;
    }

    if (!inTui) continue;

    const { code, comment } = splitInlineComment(lines[i]);

    const notificationsParsed = parseTomlArrayAssignment(lines, i, /^(\s*)(notifications)(\s*=\s*)(.*)$/i);
    if (notificationsParsed) {
      if (processedNotificationsInCurrentTui) {
        lines.splice(i, notificationsParsed.endIndex - i + 1);
        i -= 1;
        changed = true;
        continue;
      }

      processedNotificationsInCurrentTui = true;
      notificationsFound = true;

      const originalValues = notificationsParsed.hasArray ? extractArrayValues(notificationsParsed.rawValue) : [];
      const merged = normalizeTuiNotifications([...originalValues, ...(mergedFromRootDotted ? [] : dottedMergeFromRoot)]);
      mergedFromRootDotted = true;

      const serializedValues = serializeTomlStringArray(merged);
      const newLine = `${notificationsParsed.indent}${NOTIFICATIONS_KEY} = [${serializedValues}]${notificationsParsed.comment ? ` ${notificationsParsed.comment}` : ""}`;
      const originalBlock = lines.slice(i, notificationsParsed.endIndex + 1);
      lines.splice(i, notificationsParsed.endIndex - i + 1, newLine);
      if (originalBlock.length !== 1 || originalBlock[0] !== newLine) changed = true;
      continue;
    }

    const methodMatch = code.match(/^(\s*)(notification_method)(\s*=\s*)(.*)$/i);
    if (methodMatch) {
      if (processedMethodInCurrentTui) {
        lines.splice(i, 1);
        i -= 1;
        changed = true;
        continue;
      }
      processedMethodInCurrentTui = true;
      notificationMethodFound = true;
      const indent = methodMatch[1] ?? "";
      const rendered = `${indent}${NOTIFICATION_METHOD_KEY} = "${REQUIRED_NOTIFICATION_METHOD}"${comment ? ` ${comment}` : ""}`;
      if (lines[i] !== rendered) {
        lines[i] = rendered;
        changed = true;
      }
      continue;
    }
  }

  if (!tuiFound) {
    const needsLeadingBlank = lines.length > 0 && lines[lines.length - 1].trim() !== "";
    if (needsLeadingBlank) lines.push("");
    lines.push("[tui]");
    lines.push(`${NOTIFICATION_METHOD_KEY} = "${REQUIRED_NOTIFICATION_METHOD}"`);
    lines.push(`${NOTIFICATIONS_KEY} = ["${REQUIRED_NOTIFICATION}"]`);
    changed = true;
  } else if (!notificationsFound || !notificationMethodFound) {
    const { start, end } = findTuiSectionBounds(lines);
    if (start >= 0) {
      let insertIndex = start + 1;
      while (insertIndex < end && lines[insertIndex].trim() === "") insertIndex += 1;
      while (insertIndex < end && lines[insertIndex].trim().startsWith("#")) insertIndex += 1;

      let indent = "";
      for (let probe = start + 1; probe < end; probe++) {
        const probeLine = lines[probe];
        if (!probeLine || probeLine.trim() === "" || probeLine.trim().startsWith("#")) continue;
        const matchIndent = probeLine.match(/^\s*/);
        indent = matchIndent ? matchIndent[0] : "";
        break;
      }

      const inserts: string[] = [];
      if (!notificationMethodFound) inserts.push(`${indent}${NOTIFICATION_METHOD_KEY} = "${REQUIRED_NOTIFICATION_METHOD}"`);
      if (!notificationsFound) {
        const merged = normalizeTuiNotifications(dottedMergeFromRoot);
        inserts.push(`${indent}${NOTIFICATIONS_KEY} = [${serializeTomlStringArray(merged)}]`);
      }
      if (inserts.length > 0) {
        lines.splice(insertIndex, 0, ...inserts);
        changed = true;
      }
    }
  }

  const updated = lines.join("\n");
  return { updated, changed };
}

/**
 * 中文说明：根据配置路径生成 Codex notify hook 的脚本与命令参数。
 * - Windows 本地目录：写入 .ps1，使用 powershell 执行。
 * - WSL UNC / 非 Windows：写入 .sh，使用 sh 执行。
 */
function resolveCodexNotifyCommandSpec(configPath: string): CodexNotifyCommandSpec | null {
  const safeConfigPath = String(configPath || "").trim();
  if (!safeConfigPath) return null;
  const configDir = path.dirname(safeConfigPath);
  if (!configDir) return null;

  if (process.platform === "win32") {
    const uncInfo = uncToWsl(configDir);
    if (uncInfo?.wslPath) {
      const scriptPath = path.join(configDir, CODEX_NOTIFY_SH_FILENAME);
      const wslScriptPath = path.posix.join(uncInfo.wslPath, CODEX_NOTIFY_SH_FILENAME);
      return {
        scriptPath,
        scriptBody: CODEX_NOTIFY_SH_SCRIPT,
        commandArgv: ["sh", wslScriptPath],
      };
    }
    const scriptPath = path.join(configDir, CODEX_NOTIFY_PS1_FILENAME);
    return {
      scriptPath,
      scriptBody: CODEX_NOTIFY_PS1_SCRIPT,
      commandArgv: ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
    };
  }

  const scriptPath = path.join(configDir, CODEX_NOTIFY_SH_FILENAME);
  return {
    scriptPath,
    scriptBody: CODEX_NOTIFY_SH_SCRIPT,
    commandArgv: ["sh", scriptPath],
  };
}

/**
 * 中文说明：仅在内容变化时写入文本文件，避免无意义覆盖。
 */
function writeTextFileIfChanged(filePath: string, content: string): { ok: boolean; changed: boolean } {
  try {
    if (fs.existsSync(filePath)) {
      const current = fs.readFileSync(filePath, "utf8");
      if (current === content) return { ok: true, changed: false };
    }
  } catch {}
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, "utf8");
    return { ok: true, changed: true };
  } catch {
    return { ok: false, changed: false };
  }
}

/**
 * 中文说明：确保 Codex notify hook 脚本存在且内容最新。
 */
function ensureCodexNotifyScript(spec: CodexNotifyCommandSpec, source?: string): boolean {
  const result = writeTextFileIfChanged(spec.scriptPath, spec.scriptBody);
  if (!result.ok) {
    try { perfLogger.log(`[codex.config] write notify script failed path=${spec.scriptPath} source=${source || "n/a"}`); } catch {}
    return false;
  }
  if (result.changed) {
    try { perfLogger.log(`[codex.config] ensure notify script path=${spec.scriptPath} source=${source || "n/a"} changed=1`); } catch {}
  }
  return true;
}

/**
 * 中文说明：确保 root 级 notify 命令为 CodexFlow 预期值，并清理重复键。
 */
function updateRootNotifyCommand(normalized: string, commandArgv: string[]): NormalizeResult {
  const lines = normalized.length > 0 ? normalized.split("\n") : [];
  const renderedValue = `[${serializeTomlStringArray(commandArgv)}]`;
  let changed = false;
  let found = false;
  let sawAnySection = false;

  for (let i = 0; i < lines.length; i++) {
    const sectionMatch = String(lines[i] || "").match(/^(\s*\[([^\]\[]+)\])(\s*)(.*)$/);
    if (sectionMatch) {
      sawAnySection = true;
      continue;
    }
    if (sawAnySection) continue;

    const parsed = parseTomlArrayAssignment(lines, i, /^(\s*)(notify)(\s*=\s*)(.*)$/i);
    if (parsed) {
      const rendered = `${parsed.indent}${ROOT_NOTIFY_KEY} = ${renderedValue}${parsed.comment ? ` ${parsed.comment}` : ""}`;
      if (!found) {
        const originalBlock = lines.slice(i, parsed.endIndex + 1);
        lines.splice(i, parsed.endIndex - i + 1, rendered);
        if (originalBlock.length !== 1 || originalBlock[0] !== rendered) changed = true;
        found = true;
      } else {
        lines.splice(i, parsed.endIndex - i + 1);
        i -= 1;
        changed = true;
      }
      continue;
    }

    const { code, comment } = splitInlineComment(lines[i] ?? "");
    const notifyMatch = code.match(/^(\s*)(notify)(\s*=\s*)(.*)$/i);
    if (!notifyMatch) continue;
    const indent = notifyMatch[1] ?? "";
    const rendered = `${indent}${ROOT_NOTIFY_KEY} = ${renderedValue}${comment ? ` ${comment}` : ""}`;
    if (!found) {
      if (lines[i] !== rendered) {
        lines[i] = rendered;
        changed = true;
      }
      found = true;
    } else {
      lines.splice(i, 1);
      i -= 1;
      changed = true;
    }
  }

  if (!found) {
    let insertIndex = lines.length;
    for (let i = 0; i < lines.length; i++) {
      if (/^(\s*\[([^\]\[]+)\])(\s*)(.*)$/.test(String(lines[i] || ""))) {
        insertIndex = i;
        break;
      }
    }
    const inserts = [`${ROOT_NOTIFY_KEY} = ${renderedValue}`];
    if (insertIndex < lines.length && lines[insertIndex].trim() !== "") inserts.push("");
    lines.splice(insertIndex, 0, ...inserts);
    changed = true;
  }

  return { updated: lines.join("\n"), changed };
}

function ensureNotificationsAtConfigPath(configPath: string, source?: string): boolean {
  if (!configPath) return false;
  try { fs.mkdirSync(path.dirname(configPath), { recursive: true }); } catch {}

  let original = "";
  let existed = false;
  try {
    if (fs.existsSync(configPath)) {
      original = fs.readFileSync(configPath, "utf8");
      existed = true;
    }
  } catch (error) {
    try { perfLogger.log(`[codex.config] read failed path=${configPath} source=${source || "n/a"} error=${String(error)}`); } catch {}
    return false;
  }

  const notifySpec = resolveCodexNotifyCommandSpec(configPath);
  const notifyScriptReady = notifySpec ? ensureCodexNotifyScript(notifySpec, source) : false;

  const { normalized, newline } = normalizeLineEndings(original);
  const tuiResult = updateNotificationsSection(normalized);
  let updated = tuiResult.updated;
  let changed = tuiResult.changed;
  if (notifySpec && notifyScriptReady) {
    const notifyResult = updateRootNotifyCommand(updated, notifySpec.commandArgv);
    updated = notifyResult.updated;
    changed = changed || notifyResult.changed;
  }
  if (!changed && existed) return false;

  let finalContent = updated;
  if (!finalContent.endsWith("\n")) finalContent += "\n";
  const serialized = newline === "\r\n" ? finalContent.replace(/\n/g, "\r\n") : finalContent;
  try {
    fs.writeFileSync(configPath, serialized, "utf8");
    try {
      perfLogger.log(`[codex.config] ensure notifications path=${configPath} source=${source || "n/a"} changed=${changed ? "1" : "0"}`);
    } catch {}
    return true;
  } catch (error) {
    try { perfLogger.log(`[codex.config] write failed path=${configPath} source=${source || "n/a"} error=${String(error)}`); } catch {}
    return false;
  }
}

let inflight: Promise<void> | null = null;

export async function ensureAllCodexNotifications(): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    const configTargets = new Map<string, { path: string; source: string }>();
    const register = (dir: string | undefined, source: string) => {
      if (!dir) return;
      const configPath = path.join(dir, "config.toml");
      const key = configPath.replace(/\\/g, "/").toLowerCase();
      if (!configTargets.has(key)) {
        configTargets.set(key, { path: configPath, source });
      }
    };

    try {
      const windowsDir = path.join(os.homedir(), ".codex");
      register(windowsDir, "windows");
    } catch {}

    try {
      const roots = await getCodexRootsFastAsync();
      if (roots?.windowsCodex) register(roots.windowsCodex, "windows");
      for (const item of roots?.wsl || []) {
        if (item.codexUNC) register(item.codexUNC, `wsl:${item.distro || "unknown"}`);
      }
    } catch (error) {
      try { perfLogger.log(`[codex.config] enumerate codex roots failed: ${String(error)}`); } catch {}
    }

    for (const target of configTargets.values()) {
      try { ensureNotificationsAtConfigPath(target.path, target.source); } catch {}
    }
  })().finally(() => { inflight = null; });
  return inflight;
}
