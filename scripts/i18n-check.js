#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

// 简易 i18n 键校验脚本：比较 base 语言(en) 与其它语言的键集合差异
// 使用：
//  - 报告但不失败：npm run i18n:report
//  - 发现缺失键时失败退出：npm run i18n:check
// 环境变量：
//  - BASE_LNG=xx  指定基准语言（默认 en）

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const LOCALES_DIR = path.join(ROOT, 'web', 'src', 'locales');
const BASE_LNG = (process.env.BASE_LNG || 'en').trim();
const STRICT = process.env.STRICT !== '0';

function readJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { throw new Error(`JSON parse failed: ${p} -> ${e.message}`); }
}

function flatten(obj, prefix = '') {
  const out = {};
  const isObj = (v) => Object.prototype.toString.call(v) === '[object Object]';
  for (const k of Object.keys(obj || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    const v = obj[k];
    if (isObj(v)) Object.assign(out, flatten(v, key));
    else out[key] = true;
  }
  return out;
}

function getLanguages() {
  if (!fs.existsSync(LOCALES_DIR)) return [];
  return fs.readdirSync(LOCALES_DIR).filter((d) => fs.statSync(path.join(LOCALES_DIR, d)).isDirectory());
}

function getNamespaces(lng) {
  const dir = path.join(LOCALES_DIR, lng);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
}

function loadKeys(lng, ns) {
  const p = path.join(LOCALES_DIR, lng, `${ns}.json`);
  if (!fs.existsSync(p)) return {};
  const json = readJSON(p);
  return flatten(json);
}

function main() {
  if (!fs.existsSync(LOCALES_DIR)) {
    console.log(`[i18n] locales dir not found: ${LOCALES_DIR}`);
    process.exit(0);
  }
  const langs = getLanguages();
  if (langs.length === 0) {
    console.log('[i18n] no languages under web/src/locales');
    process.exit(0);
  }
  if (!langs.includes(BASE_LNG)) {
    console.log(`[i18n] base language '${BASE_LNG}' not found; found: ${langs.join(', ')}`);
    process.exit(1);
  }
  const baseNs = getNamespaces(BASE_LNG);
  let hasMissing = false;
  let hasExtra = false;
  for (const lng of langs) {
    if (lng === BASE_LNG) continue;
    const nsList = Array.from(new Set([...baseNs, ...getNamespaces(lng)])).sort();
    for (const ns of nsList) {
      const a = loadKeys(BASE_LNG, ns);
      const b = loadKeys(lng, ns);
      const missing = Object.keys(a).filter((k) => !b[k]);
      const extra = Object.keys(b).filter((k) => !a[k]);
      if (missing.length > 0) {
        hasMissing = true;
        console.log(`\n[${lng}] namespace '${ns}' MISSING keys (${missing.length}):`);
        missing.slice(0, 100).forEach((k) => console.log('  - ' + k));
        if (missing.length > 100) console.log(`  ... and ${missing.length - 100} more`);
      }
      if (extra.length > 0) {
        hasExtra = true;
        console.log(`\n[${lng}] namespace '${ns}' EXTRA keys (${extra.length}):`);
        extra.slice(0, 100).forEach((k) => console.log('  + ' + k));
        if (extra.length > 100) console.log(`  ... and ${extra.length - 100} more`);
      }
    }
  }
  if (STRICT && hasMissing) {
    console.error('\n[i18n] check failed: missing keys detected.');
    process.exit(2);
  }
  if (!hasMissing && !hasExtra) console.log('[i18n] all good: no differences found');
}

try { main(); } catch (e) { console.error('[i18n] error:', e?.message || e); process.exit(1); }

