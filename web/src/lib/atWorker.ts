// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

/* eslint-disable no-restricted-globals */
// Web Worker：对 Files 候选执行模糊匹配与排序（fuzzysort + 自定义权重）
import fuzzysort from 'fuzzysort';

type Cand = { rel: string; isDir: boolean };
type Rank = { rel: string; isDir: boolean; score: number };

let loaded = false;
let cands: Cand[] = [];
let candsMap: Map<string, Cand> = new Map();
let dirty = false; // 当通过 patch 修改了 map，但未重建数组

function normalize(s: string): string { return String(s || '').replace(/\\/g, '/').toLowerCase(); }

function basename(p: string): string { const i = p.lastIndexOf('/'); return i >= 0 ? p.slice(i + 1) : p; }

function scoreOne(item: Cand, query: string): number {
  const rel = item.rel;
  const base = basename(rel);
  const tRel = normalize(rel);
  const tBase = normalize(base);
  const q = normalize(query);
  if (!q) return 0;
  let s = 0;
  // 前缀/包含
  if (tBase.startsWith(q)) s += 1200;
  if (tRel.startsWith(q)) s += 900;
  if (tRel.includes(q)) s += 500;
  // fuzzysort：对 basename 与 rel 取最大
  if (q.length > 2) {
    try {
      const a = fuzzysort.single(q, base);
      const b = fuzzysort.single(q, rel);
      const fs = Math.max(a ? a.score : -9999, b ? b.score : -9999);
      if (fs > -9999) s += Math.max(0, 5000 + fs); // 变换为正分
    } catch {}
  }
  // 路径段顺序匹配
  if (q.includes('/')) {
    const segs = q.split('/').filter(Boolean);
    let start = 0; let ok = 0;
    for (const seg of segs) {
      const i = tRel.indexOf(seg, start);
      if (i >= 0) { ok += 1; start = i + seg.length; }
      else break;
    }
    s += ok * 180;
    if (item.isDir) s += 160; // 含 / 时目录加权
  } else {
    if (!item.isDir) s += 60; // 默认文件略优
  }
  // 更短路径略优
  s -= rel.length * 0.3;
  return s;
}

function search(q: string, limit = 30): Rank[] {
  if (!loaded || !cands.length) return [];
  if (!q) {
    // 无查询：简单按相对路径短优先，目录与文件混排
    const source = dirty ? Array.from(candsMap.values()) : cands;
    if (dirty) { cands = source; dirty = false; }
    const seeded = source.slice(0, Math.min(200, source.length)).map((it) => ({ rel: it.rel, isDir: it.isDir, score: 0 }));
    return seeded.slice(0, limit);
  }
  const source = dirty ? Array.from(candsMap.values()) : cands;
  if (dirty) { cands = source; dirty = false; }
  const ranked: Rank[] = source.map((it) => ({ rel: it.rel, isDir: it.isDir, score: scoreOne(it, q) }));
  ranked.sort((a, b) => b.score - a.score);
  return ranked.slice(0, limit);
}

self.onmessage = (ev: MessageEvent) => {
  const data = ev.data || {};
  if (data && data.type === 'load') {
    try {
      const arr: Cand[] = Array.isArray(data.candidates) ? data.candidates : [];
      cands = arr.map((x) => ({ rel: String(x.rel || '').replace(/\\/g, '/'), isDir: !!x.isDir }));
      candsMap = new Map(cands.map((it) => [ `${it.isDir ? 'D' : 'F'}:${it.rel}`, it ]));
      loaded = true;
      // @ts-ignore
      (self as any).postMessage({ type: 'loaded', total: cands.length });
    } catch {
      loaded = false; cands = [];
      candsMap = new Map();
      // @ts-ignore
      (self as any).postMessage({ type: 'loaded', total: 0 });
    }
    return;
  }
  if (data && data.type === 'patch') {
    try {
      const adds: any[] = Array.isArray(data.adds) ? data.adds : [];
      const removes: any[] = Array.isArray(data.removes) ? data.removes : [];
      let changed = false;
      for (const a of adds) {
        const it = { rel: String(a.rel || '').replace(/\\/g, '/'), isDir: !!a.isDir } as Cand;
        const k = `${it.isDir ? 'D' : 'F'}:${it.rel}`;
        if (!candsMap.has(k)) { candsMap.set(k, it); changed = true; }
      }
      for (const r of removes) {
        const k = `${r && r.isDir ? 'D' : 'F'}:${String(r?.rel || '').replace(/\\/g, '/')}`;
        if (candsMap.has(k)) { candsMap.delete(k); changed = true; }
      }
      if (changed) { dirty = true; }
      // @ts-ignore
      (self as any).postMessage({ type: 'patched', adds: adds.length, removes: removes.length, total: candsMap.size });
    } catch {
      // ignore
    }
    return;
  }
  if (data && data.type === 'query') {
    const q = String(data.q || '');
    const lim = Number(data.limit || 30);
    const items = search(q, lim);
    // @ts-ignore
    (self as any).postMessage({ type: 'result', q, items });
    return;
  }
};
