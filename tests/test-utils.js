'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseRelativeTime, normalizeDate, truncateStr, intOr,
  sanitizeFilename, parseArgs,
} = require('../scripts/utils');

test('parseRelativeTime: 30m / 2h / 7d 换算正确', () => {
  const now = Date.now();
  const tol = 1500; // 允许执行耗时
  assert.ok(Math.abs(parseRelativeTime('30m').getTime() - (now - 30 * 60 * 1000)) < tol);
  assert.ok(Math.abs(parseRelativeTime('2h').getTime() - (now - 2 * 60 * 60 * 1000)) < tol);
  assert.ok(Math.abs(parseRelativeTime('7d').getTime() - (now - 7 * 24 * 60 * 60 * 1000)) < tol);
});

test('parseRelativeTime: 非法格式抛错', () => {
  assert.throws(() => parseRelativeTime('2x'), /Invalid time format/);
  assert.throws(() => parseRelativeTime('abc'), /Invalid time format/);
  assert.throws(() => parseRelativeTime(''), /Invalid time format/);
});

test('normalizeDate: 纯日期串按本地零点构造', () => {
  const d = normalizeDate('2026-10-18');
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 9);
  assert.equal(d.getDate(), 18);
  assert.equal(d.getHours(), 0);
  assert.equal(d.getMinutes(), 0);
});

test('normalizeDate: Date 原样透传', () => {
  const src = new Date(2026, 0, 2, 3, 4, 5);
  assert.equal(normalizeDate(src), src);
});

test('normalizeDate: 溢出日期（2026-02-30）与垃圾值都抛错', () => {
  assert.throws(() => normalizeDate('not-a-date'), /Invalid date/);
  assert.throws(() => normalizeDate('2026-13-45'), /Invalid date/);
  assert.throws(() => normalizeDate('2026-02-30'), /Invalid date/); // JS 会静默滚到 3 月，必须拦截
});

test('truncateStr: 未超长原样返回，超长追加提示', () => {
  assert.equal(truncateStr('abc', 10), 'abc');
  assert.equal(truncateStr('abc', 0), 'abc'); // 0 = 不截断
  assert.equal(truncateStr(null, 5), null);
  const cut = truncateStr('0123456789', 4);
  assert.ok(cut.startsWith('0123'));
  assert.match(cut, /已截断/);
});

test('intOr: 非法值回落默认值', () => {
  assert.equal(intOr('5', 10), 5);
  assert.equal(intOr(undefined, 10), 10);
  assert.equal(intOr('abc', 10), 10);
});

test('sanitizeFilename: 路径穿越被剥掉', () => {
  assert.equal(sanitizeFilename('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeFilename('/var/log/x.log'), 'x.log');
  assert.equal(sanitizeFilename('..'), 'attachment');
  assert.equal(sanitizeFilename(''), 'attachment');
  assert.equal(sanitizeFilename(null), 'attachment');
  assert.equal(sanitizeFilename('报价单.pdf'), '报价单.pdf');
});

test('parseArgs: 布尔开关不吞下一个 token', () => {
  const { command, options, positional } = parseArgs(
    ['node', 'imap.js', 'check', '--unseen', '--limit', '5'],
    new Set(['unseen']),
  );
  assert.equal(command, 'check');
  assert.equal(options.unseen, true);
  assert.equal(options.limit, '5');
  assert.deepEqual(positional, []);
});

test('parseArgs: 位置参数与带值选项混排', () => {
  const { command, options, positional } = parseArgs(
    ['node', 'imap.js', 'mark-read', '101', '102', '--mailbox', 'Archive'],
    new Set(['unseen']),
  );
  assert.equal(command, 'mark-read');
  assert.deepEqual(positional, ['101', '102']);
  assert.equal(options.mailbox, 'Archive');
});

test('parseArgs: 选项后无值时记为 true', () => {
  const { options } = parseArgs(['node', 'imap.js', 'check', '--unseen'], new Set(['unseen']));
  assert.equal(options.unseen, true);
});

test('parseArgs: 无布尔开关集时选项正常吞值', () => {
  const { options } = parseArgs(['node', 'x.js', 'search', '--from', 'a@b.com']);
  assert.equal(options.from, 'a@b.com');
});

test('parseArgs: 首位是选项时 command 为 null（--help 不被当命令）', () => {
  const { command, options } = parseArgs(['node', 'imap.js', '--help'], new Set(['help']));
  assert.equal(command, null);
  assert.equal(options.help, true);
});

test('parseArgs: 首位是选项时其他选项照样解析', () => {
  const { command, options, positional } = parseArgs(
    ['node', 'imap.js', '--format', 'csv', 'check', '--unseen'],
    new Set(['unseen']),
  );
  // 首位是 --format，因此 command 记 null，check 落入 positional
  assert.equal(command, null);
  assert.equal(options.format, 'csv');
  assert.equal(options.unseen, true);
  assert.deepEqual(positional, ['check']);
});
