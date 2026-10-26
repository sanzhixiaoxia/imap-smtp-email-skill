'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SmtpService, validateReadPath } = require('../scripts/smtp-service');
const { MailError, ERROR_CODES } = require('../scripts/errors');

const NOOP_LOGGER = { debug() {}, time: () => () => {}, info() {}, warn() {}, error() {} };

function makeConfig(overrides = {}) {
  return {
    accountName: 'default',
    imap: { host: 'imap.163.com', port: 993, user: 'me@163.com', pass: 'x' },
    smtp: {
      host: 'smtp.163.com',
      port: 465,
      user: 'me@163.com',
      pass: 'auth-code',
      from: 'me@163.com',
      secure: true,
      retries: 1,
      rejectUnauthorized: true,
    },
    allowedReadDirs: [],
    ...overrides,
  };
}

/**
 * 假 nodemailer transport。
 * failTimes: 前 N 次 sendMail 抛错（用于测重试）。
 */
function makeTransport({ failTimes = 0, verifyError = null } = {}) {
  let sends = 0;
  return {
    get sends() { return sends; },
    async verify() {
      if (verifyError) throw verifyError;
      return true;
    },
    async sendMail(mailOptions) {
      sends += 1;
      if (sends <= failTimes) {
        throw new Error('Greeting never received');
      }
      return { messageId: '<abc@163.com>', response: '250 Mail OK queued' };
    },
  };
}

function makeService(config, transport) {
  return new SmtpService(config, {
    logger: NOOP_LOGGER,
    transportFactory: () => transport,
  });
}

// --- verify ---

test('verify: 连通正常返回 success', async () => {
  const svc = makeService(makeConfig(), makeTransport());
  const out = await svc.verify();
  assert.deepEqual(out, { success: true, host: 'smtp.163.com', port: 465 });
});

test('verify: 鉴权失败 → AUTH_FAILED 且带网易授权码 hint', async () => {
  const svc = makeService(makeConfig(), makeTransport({ verifyError: new Error('Invalid login: 535 Error') }));
  await assert.rejects(() => svc.verify(), (err) => {
    assert.ok(err instanceof MailError);
    assert.equal(err.code, ERROR_CODES.AUTH_FAILED);
    assert.match(err.hint, /授权码/);
    return true;
  });
});

test('verify: 网络错误 → CONNECTION_FAILED', async () => {
  const svc = makeService(makeConfig(), makeTransport({ verifyError: new Error('ETIMEDOUT smtp.163.com') }));
  await assert.rejects(() => svc.verify(), (err) => err.code === ERROR_CODES.CONNECTION_FAILED);
});

// --- send ---

test('send: 成功返回 messageId 与 attempts', async () => {
  const transport = makeTransport();
  const svc = makeService(makeConfig(), transport);
  const out = await svc.send({ to: 'boss@163.com', subject: '报价', body: '请查收' });
  assert.equal(out.success, true);
  assert.equal(out.messageId, '<abc@163.com>');
  assert.equal(out.attempts, 1);
  assert.equal(out.to, 'boss@163.com');
  assert.equal(transport.sends, 1);
});

test('send: 首次失败自动重试，attempts=2', async () => {
  const transport = makeTransport({ failTimes: 1 });
  const svc = makeService(makeConfig(), transport);
  const out = await svc.send({ to: 'boss@163.com', subject: 'retry', body: 'x' });
  assert.equal(out.attempts, 2);
  assert.equal(transport.sends, 2);
});

test('send: 重试耗尽后抛出分类错误', async () => {
  const transport = makeTransport({ failTimes: 9 });
  const svc = makeService(makeConfig({ smtp: { ...makeConfig().smtp, retries: 0 } }), transport);
  await assert.rejects(() => svc.send({ to: 'a@b.c', subject: 'x' }), (err) => {
    assert.ok(err instanceof MailError);
    return true;
  });
  assert.equal(transport.sends, 1); // retries=0 → 只发一次
});

test('send: 缺少 --to → INVALID_INPUT', async () => {
  const svc = makeService(makeConfig(), makeTransport());
  await assert.rejects(() => svc.send({ subject: 'x' }), (err) => err.code === ERROR_CODES.INVALID_INPUT);
});

test('send: 缺少主题 → INVALID_INPUT', async () => {
  const svc = makeService(makeConfig(), makeTransport());
  await assert.rejects(() => svc.send({ to: 'a@b.c' }), (err) => err.code === ERROR_CODES.INVALID_INPUT);
});

test('send: from 缺省回落到 smtp.user', async () => {
  let captured = null;
  const transport = {
    async verify() { return true; },
    async sendMail(opts) { captured = opts; return { messageId: '<x>' }; },
  };
  const svc = makeService(makeConfig({ smtp: { ...makeConfig().smtp, from: undefined } }), transport);
  await svc.send({ to: 'a@b.c', subject: 'x', body: 'y' });
  assert.equal(captured.from, 'me@163.com');
});

test('send: 显式 --from 覆盖默认', async () => {
  let captured = null;
  const transport = {
    async verify() { return true; },
    async sendMail(opts) { captured = opts; return { messageId: '<x>' }; },
  };
  const svc = makeService(makeConfig(), transport);
  await svc.send({ to: 'a@b.c', subject: 'x', body: 'y', from: 'alias@163.com' });
  assert.equal(captured.from, 'alias@163.com');
});

test('send: 附件路径透传给 nodemailer', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-att-'));
  const file = path.join(dir, 'quote.pdf');
  fs.writeFileSync(file, '%PDF-1.4');
  let captured = null;
  const transport = {
    async verify() { return true; },
    async sendMail(opts) { captured = opts; return { messageId: '<x>' }; },
  };
  const svc = makeService(makeConfig({ allowedReadDirs: [dir] }), transport);
  await svc.send({ to: 'a@b.c', subject: 's', body: 'b', attachments: [file] });
  assert.equal(captured.attachments.length, 1);
  assert.equal(captured.attachments[0].filename, 'quote.pdf');
  assert.equal(captured.attachments[0].path, file);
});

// --- sendTest ---

test('sendTest: verify + 给自己发一封，成功返回 messageId', async () => {
  const transport = makeTransport();
  const svc = makeService(makeConfig(), transport);
  const out = await svc.sendTest();
  assert.equal(out.success, true);
  assert.equal(out.messageId, '<abc@163.com>');
  assert.equal(transport.sends, 1);
});

test('sendTest: verify 失败时不发送邮件', async () => {
  const transport = makeTransport({ verifyError: new Error('auth failed') });
  const svc = makeService(makeConfig(), transport);
  await assert.rejects(() => svc.sendTest(), (err) => err.code === ERROR_CODES.AUTH_FAILED);
  assert.equal(transport.sends, 0);
});

// --- validateReadPath ---

test('validateReadPath: 白名单内返回真实路径', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mail-rp-')));
  const file = path.join(dir, 'a.txt');
  fs.writeFileSync(file, 'x');
  assert.equal(validateReadPath(file, [dir]), file);
});

test('validateReadPath: 白名单外拒绝 → IO_ERROR', () => {
  assert.throws(() => validateReadPath('/etc/passwd', [os.tmpdir()]), (err) => {
    assert.ok(err instanceof MailError);
    assert.equal(err.code, ERROR_CODES.IO_ERROR);
    return true;
  });
});

test('validateReadPath: 空白名单禁用文件读取', () => {
  assert.throws(() => validateReadPath('/tmp/x.txt', []), /ALLOWED_READ_DIRS/);
  assert.throws(() => validateReadPath('/tmp/x.txt', undefined), /ALLOWED_READ_DIRS/);
});

test('validateReadPath: ~ 展开到家目录', () => {
  const home = os.homedir();
  assert.equal(validateReadPath('~/a.txt', [home]), path.join(home, 'a.txt'));
  // 白名单写成 ~ 形式时同样匹配
  assert.equal(validateReadPath(path.join(home, 'b.txt'), ['~']), path.join(home, 'b.txt'));
});

// --- 配置缺失 ---

test('_transport: SMTP 配置不全 → CONFIG_INVALID', async () => {
  const svc = new SmtpService(makeConfig({
    smtp: { host: null, port: 465, user: null, pass: null },
  }), { logger: NOOP_LOGGER });
  await assert.rejects(() => svc.verify(), (err) => err.code === ERROR_CODES.CONFIG_INVALID);
});
