'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { toCsv, escapeCell, emailsToCsv, EMAIL_COLUMNS } = require('../scripts/csv');

test('escapeCell: 含逗号/引号/换行时加引号并转义', () => {
  assert.equal(escapeCell('plain'), 'plain');
  assert.equal(escapeCell('a,b'), '"a,b"');
  assert.equal(escapeCell('say "hi"'), '"say ""hi"""');
  assert.equal(escapeCell('line1\nline2'), '"line1\nline2"');
  assert.equal(escapeCell(null), '');
  assert.equal(escapeCell(42), '42');
});

test('toCsv: 表头 + 数据行', () => {
  const csv = toCsv(
    [{ a: 1, b: 'x' }, { a: 2, b: 'y,z' }],
    [{ key: 'a', header: 'A' }, { key: 'b', header: 'B' }],
  );
  assert.equal(csv, 'A,B\n1,x\n2,"y,z"');
});

test('toCsv: 空数据只有表头', () => {
  const csv = toCsv([], [{ key: 'a', header: 'A' }]);
  assert.equal(csv, 'A');
});

test('toCsv: value 函数列', () => {
  const csv = toCsv([{ n: 3 }], [{ key: 'n', header: 'N', value: (r) => r.n * 2 }]);
  assert.equal(csv, 'N\n6');
});

test('emailsToCsv: 邮件列表标准列', () => {
  const csv = emailsToCsv([
    {
      uid: 100,
      mailbox: 'INBOX',
      date: new Date(2026, 9, 18, 14, 2),
      from: 'a@163.com',
      to: 'b@163.com',
      subject: '报价, 确认',
      flags: [], // 未读
      attachments: [{ filename: 'q.pdf' }],
      snippet: '见附件',
    },
    {
      uid: 99,
      date: new Date(2026, 9, 17, 9, 0),
      from: 'c@qq.com',
      subject: 'Re: hi',
      flags: ['\\Seen'],
    },
  ]);
  const lines = csv.split('\n');
  assert.equal(lines[0], 'uid,mailbox,date,from,to,subject,unseen,attachments,snippet');
  assert.match(lines[1], /^100,INBOX,2026-10-18T/);
  assert.match(lines[1], /"报价, 确认"/); // 主题含逗号必须转义
  assert.match(lines[1], /,1,q\.pdf,见附件$/); // 未读=1
  assert.match(lines[2], /,0,,$/); // 已读=0、无附件
});

test('emailsToCsv: 空列表返回表头', () => {
  assert.equal(emailsToCsv([]), EMAIL_COLUMNS.map((c) => c.header).join(','));
  assert.equal(emailsToCsv(null), EMAIL_COLUMNS.map((c) => c.header).join(','));
});
