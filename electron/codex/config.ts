// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { perfLogger } from "../log";
import { getCodexRootsFastAsync } from "../wsl";

const REQUIRED_NOTIFICATION = "agent-turn-complete";
const NOTIFICATIONS_KEY = "notifications";

type NormalizeResult = { updated: string; changed: boolean };

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

  let inTui = false;
  let processedInCurrentTui = false;

  for (let i = 0; i < lines.length; i++) {
    const sectionMatch = lines[i].match(/^(\s*\[([^\]\[]+)\])(\s*)(.*)$/);
    if (sectionMatch) {
      const section = sectionMatch[2].trim().toLowerCase();
      if (section === "tui") {
        tuiFound = true;
        inTui = true;
        processedInCurrentTui = false;

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
    const assignmentMatch = code.match(/^(\s*)(notifications)(\s*=\s*)(.*)$/i);
    if (!assignmentMatch) continue;

    if (processedInCurrentTui) {
      lines.splice(i, 1);
      i -= 1;
      changed = true;
      continue;
    }

    processedInCurrentTui = true;
    notificationsFound = true;

    const indent = assignmentMatch[1] ?? "";
    const valueFragment = assignmentMatch[4] ?? "";

    const fragments: string[] = [valueFragment];
    let endIndex = i;
    const state: ArrayScanState = { depth: 0, hasBracket: false, inSingle: false, inDouble: false, escaped: false, done: false };
    feedArrayState(state, valueFragment);

    while (!state.done && state.hasBracket && endIndex + 1 < lines.length) {
      endIndex += 1;
      const { code: nextCode } = splitInlineComment(lines[endIndex]);
      fragments.push(nextCode);
      feedArrayState(state, nextCode);
    }

    if (!state.hasBracket) {
      const probeFragments: string[] = [];
      const probeState: ArrayScanState = { ...state };
      let probeIndex = endIndex;
      // 寻找下一行是否为数组起始，兼容 `notifications =` 换行写法
      while (!probeState.done && probeIndex + 1 < lines.length) {
        const nextIndex = probeIndex + 1;
        const { code: nextCode } = splitInlineComment(lines[nextIndex]);
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

    if (!state.hasBracket) {
      const rendered = `${indent}${NOTIFICATIONS_KEY} = ["${REQUIRED_NOTIFICATION}"]${comment ? ` ${comment}` : ""}`;
      lines.splice(i, endIndex - i + 1, rendered);
      changed = true;
      continue;
    }

    const originalValues = extractArrayValues(rawValue);
    const deduped = dedupePreservingOrder(originalValues);
    const priorLength = deduped.length;
    if (!deduped.includes(REQUIRED_NOTIFICATION)) {
      deduped.push(REQUIRED_NOTIFICATION);
    }
    const valuesChanged = deduped.length !== priorLength || deduped.length !== originalValues.length;

    if (!valuesChanged) {
      i = endIndex;
      continue;
    }

    const serializedValues = deduped.map((value) => JSON.stringify(value)).join(", ");
    const newLine = `${indent}${NOTIFICATIONS_KEY} = [${serializedValues}]${comment ? ` ${comment}` : ""}`;
    lines.splice(i, endIndex - i + 1, newLine);
    changed = true;
  }

  if (!tuiFound) {
    const needsLeadingBlank = lines.length > 0 && lines[lines.length - 1].trim() !== "";
    if (needsLeadingBlank) lines.push("");
    lines.push("[tui]");
    lines.push(`${NOTIFICATIONS_KEY} = ["${REQUIRED_NOTIFICATION}"]`);
    changed = true;
  } else if (!notificationsFound) {
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

      lines.splice(insertIndex, 0, `${indent}${NOTIFICATIONS_KEY} = ["${REQUIRED_NOTIFICATION}"]`);
      changed = true;
    }
  }

  const updated = lines.join("\n");
  return { updated, changed };
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

  const { normalized, newline } = normalizeLineEndings(original);
  const { updated, changed } = updateNotificationsSection(normalized);
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
