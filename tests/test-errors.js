'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MailError, ERROR_CODES, classifyError, formatError, authHint, NETEASE_PERSONAL_PROVIDERS,
} = require('../scripts/errors');

test('classifyError: MailError 原样返回', () => {
  const e = new MailError(ERROR_CODES.AUTH_FAILED, 'x');
  assert.equal(classifyError(e, '163'), e);
});

test('classifyError: 鉴权失败 → AUTH_FAILED + 授权码提示', () => {
  const e = classifyError(new Error('Invalid credentials (failure)'), '163');
  assert.equal(e.code, ERROR_CODES.AUTH_FAILED);
  assert.match(e.hint, /授权码/);
  assert.ok(e instanceof MailError);
});

test('classifyError: gmail → 应用专用密码提示', () => {
  const e = classifyError(new Error('Authentication failed'), 'gmail');
  assert.equal(e.code, ERROR_CODES.AUTH_FAILED);
  assert.match(e.hint, /应用专用密码/);
});

test('classifyError: qq → 授权码提示', () => {
  const e = classifyError(new Error('login error'), 'qq');
  assert.match(e.hint, /授权码/);
});

test('classifyError: nodemailer 常见鉴权措辞均归 AUTH_FAILED', () => {
  // 真实环境见过的报错文本，不应落到 UNKNOWN
  for (const msg of [
    'Invalid credentials (failure)',
    'Invalid login: 535 Error: authentication failed',
    '535 Authentication failed',
    'Authentication failed',
    'Login failed',
  ]) {
    assert.equal(classifyError(new Error(msg), '163').code, ERROR_CODES.AUTH_FAILED, msg);
  }
});

test('classifyError: 未知 provider 鉴权失败无 hint', () => {
  const e = classifyError(new Error('auth failed'), 'fastmail');
  assert.equal(e.code, ERROR_CODES.AUTH_FAILED);
  assert.ok(!e.hint); // fastmail 无专属提示，hint 不设置
});

test('classifyError: 文件夹不存在 → MAILBOX_NOT_FOUND + 中文提示', () => {
  const e = classifyError(new Error("Mailbox doesn't exist"), '163');
  assert.equal(e.code, ERROR_CODES.MAILBOX_NOT_FOUND);
  assert.match(e.hint, /list-mailboxes/);
  assert.match(e.hint, /垃圾邮件/);
});

test('classifyError: 网络类 → CONNECTION_FAILED', () => {
  for (const msg of ['connection timed out', 'ECONNREFUSED', 'self-signed certificate', 'socket hang up']) {
    assert.equal(classifyError(new Error(msg), '163').code, ERROR_CODES.CONNECTION_FAILED, msg);
  }
});

test('classifyError: 无法识别 → UNKNOWN', () => {
  assert.equal(classifyError(new Error('boom'), '163').code, ERROR_CODES.UNKNOWN);
});

test('formatError: 单行错误码 + 提示行', () => {
  const out = formatError(new Error('Invalid credentials'), '163');
  assert.match(out, /^错误\[AUTH_FAILED\]: Invalid credentials/);
  assert.match(out, /\n提示: /);
});

test('authHint: 网易系列全部有提示', () => {
  for (const p of NETEASE_PERSONAL_PROVIDERS) {
    assert.match(authHint(p), /授权码/);
  }
});

test('MailError: 保留 code/hint/cause', () => {
  const cause = new Error('root');
  const e = new MailError(ERROR_CODES.IO_ERROR, 'io', { hint: 'h', cause });
  assert.equal(e.code, ERROR_CODES.IO_ERROR);
  assert.equal(e.hint, 'h');
  assert.equal(e.cause, cause);
  assert.equal(e.name, 'MailError');
  assert.ok(e instanceof Error);
});
