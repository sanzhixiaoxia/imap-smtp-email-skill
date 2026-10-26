'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  displayWidth, padDisplay, truncateDisplay, formatDate, formatSize,
  formatResultsTable, formatEmailText,
} = require('../scripts/format');

test('displayWidth: 中文按双倍宽度计', () => {
  assert.equal(displayWidth('abc'), 3);
  assert.equal(displayWidth('中文'), 4);
  assert.equal(displayWidth('a中b'), 4);
  assert.equal(displayWidth(''), 0);
  assert.equal(displayWidth(null), 0);
});

test('padDisplay: 按显示宽度补齐，超宽不截断', () => {
  assert.equal(padDisplay('ab', 5), 'ab   ');
  assert.equal(padDisplay('中文', 5), '中文 '); // 宽 4，补 1 格
  assert.equal(padDisplay('toolong', 3), 'toolong');
});

test('truncateDisplay: 按显示宽度截断并加省略号', () => {
  assert.equal(truncateDisplay('abc', 10), 'abc');
  assert.equal(truncateDisplay('abcdefgh', 4), 'abc…');
  assert.equal(displayWidth(truncateDisplay('中文测试内容', 5)), 5);
});

test('formatDate: 本地时区 YYYY-MM-DD HH:mm', () => {
  const d = new Date(2026, 9, 18, 14, 5);
  assert.equal(formatDate(d), '2026-10-18 14:05');
  assert.equal(formatDate(null), '-');
  assert.equal(formatDate('invalid'), '-');
  assert.equal(formatDate('2026-10-18T14:05:00'), '2026-10-18 14:05');
});

test('formatSize: B / KB / MB', () => {
  assert.equal(formatSize(512), '512 B');
  assert.equal(formatSize(2048), '2.0 KB');
  assert.equal(formatSize(5 * 1024 * 1024), '5.0 MB');
  assert.equal(formatSize(null), '');
});

test('formatResultsTable: 表头 + 未读/附件标记', () => {
  const out = formatResultsTable([
    {
      uid: 12345,
      date: new Date(2026, 9, 18, 14, 2),
      from: 'Zhang San <zhangsan@163.com>',
      subject: '关于秋季报价的确认',
      flags: [], // 未读
      attachments: [{ filename: 'a.pdf' }],
    },
    {
      uid: 12300,
      date: new Date(2026, 9, 17, 9, 30),
      from: 'lisi@qq.com',
      subject: 'Re: meeting',
      flags: ['\\Seen'],
    },
  ]);
  assert.match(out, /^UID/);
  assert.match(out, /未读/);
  assert.match(out, /关于秋季报价的确认/);
  assert.match(out, /12300/);
  // 第二封已读、无附件：该行不应再出现未读标记
  const readLine = out.split('\n').find((l) => l.includes('12300'));
  assert.ok(readLine);
  assert.doesNotMatch(readLine, /未读/);
});

test('formatResultsTable: 空列表有占位', () => {
  assert.match(formatResultsTable([]), /无邮件/);
  assert.match(formatResultsTable(null), /无邮件/);
});

test('formatEmailText: 包含收发信息、附件与正文', () => {
  const out = formatEmailText({
    uid: 999,
    from: 'a@163.com',
    to: 'b@163.com',
    date: new Date(2026, 9, 18, 10, 0),
    headerDate: new Date(2026, 9, 18, 9, 0),
    subject: '报价单',
    text: '请查收附件。',
    attachments: [{ filename: 'quote.pdf', size: 20480 }],
  });
  assert.match(out, /UID 999/);
  assert.match(out, /发件人:\s+a@163\.com/);
  assert.match(out, /主题:\s+报价单/);
  assert.match(out, /quote\.pdf \(20\.0 KB\)/);
  assert.match(out, /请查收附件。/);
});

test('formatEmailText: 无纯文本正文时给出引导', () => {
  const out = formatEmailText({ uid: 1, subject: 'x', html: '<p>hi</p>' });
  assert.match(out, /HTML/);
});
