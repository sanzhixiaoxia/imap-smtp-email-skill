#!/usr/bin/env node

/**
 * 共享纯函数工具集。
 * 本模块不依赖 config.js，可独立单元测试。
 */

const path = require('path');

// 解析 --recent 用的相对时间（30m / 2h / 7d）为 Date
function parseRelativeTime(timeStr) {
  const match = String(timeStr).match(/^(\d+)(m|h|d)$/);
  if (!match) {
    throw new Error('Invalid time format. Use: 30m, 2h, 7d');
  }
  const value = parseInt(match[1], 10);
  const unit = match[2];
  const now = Date.now();
  if (unit === 'm') return new Date(now - value * 60 * 1000);
  if (unit === 'h') return new Date(now - value * 60 * 60 * 1000);
  return new Date(now - value * 24 * 60 * 60 * 1000);
}

// 归一化 --since / --before 入参为 Date。
// 注意：纯日期串必须按「本地零点」构造——new Date('2026-10-18') 是 UTC 零点，
// 在东八区会变成当天 08:00，虽然日期不变，但跨时区环境下边界不稳定。
function normalizeDate(value) {
  if (value instanceof Date) return value;
  const s = String(value).trim();
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    const invalid = new Error(`Invalid date: ${value}. Use YYYY-MM-DD`);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) throw invalid;
    const dt = new Date(y, mo - 1, d);
    // 防止 2026-02-30 这类日期被 JS 静默滚到 3 月
    if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) throw invalid;
    return dt;
  }
  const d = new Date(s);
  if (isNaN(d.getTime())) {
    throw new Error(`Invalid date: ${value}. Use YYYY-MM-DD`);
  }
  return d;
}

// 截断超长正文，截断时追加引导提示
function truncateStr(s, max) {
  if (!max || max <= 0 || s == null) return s;
  const str = String(s);
  if (str.length <= max) return str;
  return str.slice(0, max) + '…[正文已截断，完整内容请用 fetch <uid> 获取]';
}

function intOr(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isNaN(n) ? fallback : n;
}

// 附件名路径穿越防护：去掉目录成分与 ..
function sanitizeFilename(filename) {
  return path.basename(String(filename || ''))
    .replace(/\.\./g, '')
    .replace(/^[./\\]/, '') || 'attachment';
}

// 极简 argv 解析器。boolFlags 中的布尔开关不会吞掉下一个 token
// （修复 `--unseen 10` 把 "10" 当成 unseen 取值的问题）。
// argv 默认取 process.argv，测试可显式传入。
// 首个 token 即为选项时（如 `--help`）command 记 null，选项从 index 0 开始解析。
function parseArgs(argv = process.argv, boolFlags = new Set()) {
  const args = argv.slice(2);
  const firstIsFlag = args.length > 0 && args[0].startsWith('--');
  const command = firstIsFlag ? null : args[0];
  const options = {};
  const positional = [];
  for (let i = firstIsFlag ? 0 : 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (boolFlags.has(key)) {
        options[key] = true;
        continue;
      }
      const value = args[i + 1];
      options[key] = value === undefined ? true : value;
      if (value !== undefined && !value.startsWith('--')) i++;
    } else {
      positional.push(arg);
    }
  }
  return { command, options, positional };
}

module.exports = {
  parseRelativeTime,
  normalizeDate,
  truncateStr,
  intOr,
  sanitizeFilename,
  parseArgs,
};
