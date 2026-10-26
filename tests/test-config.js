'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig, listAccounts, resolveEnvSource } = require('../scripts/config');
const { ERROR_CODES } = require('../scripts/errors');

function tmpEnv(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-cfg-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, content);
  return { dir, file, env: { ...process.env, MAIL_SKILLS_ENV: file } };
}

const SHARED_163 = [
  'PROVIDER=163',
  'USERNAME=me@163.com',
  'PASSWORD=auth-code-123',
  'ALLOWED_READ_DIRS=~/Downloads',
  'ALLOWED_WRITE_DIRS=~/Downloads',
].join('\n');

test('loadConfig: shared 格式默认账户', () => {
  const { env } = tmpEnv(SHARED_163);
  const { ok, config, source } = loadConfig({ env });
  assert.equal(ok, true);
  assert.equal(config.imap.host, 'imap.163.com');
  assert.equal(config.imap.port, 993);
  assert.equal(config.imap.user, 'me@163.com');
  assert.equal(config.smtp.host, 'smtp.163.com');
  assert.equal(config.smtp.port, 465);
  assert.equal(config.imap.retries, 1); // 默认重试 1 次
  assert.equal(config.smtp.retries, 1);
  assert.equal(config.accountName, 'default');
  assert.equal(config.imap.mailbox, 'INBOX');
  assert.equal(source, resolveEnvSource(env).path);
});

test('loadConfig: 命名账户（前缀大写）', () => {
  const { env } = tmpEnv(`${SHARED_163}\n\nWORK_PROVIDER=gmail\nWORK_USERNAME=me@work.com\nWORK_PASSWORD=app-pass`);
  const { ok, config } = loadConfig({ account: 'work', env });
  assert.equal(ok, true);
  assert.equal(config.imap.host, 'imap.gmail.com');
  assert.equal(config.imap.user, 'me@work.com');
  assert.equal(config.accountName, 'work');
});

test('loadConfig: 账户不存在 → CONFIG_INVALID', () => {
  const { env } = tmpEnv(SHARED_163);
  const { ok, error } = loadConfig({ account: 'nope', env });
  assert.equal(ok, false);
  assert.equal(error.code, ERROR_CODES.CONFIG_INVALID);
  assert.match(error.message, /nope/);
});

test('loadConfig: 缺 PROVIDER → CONFIG_INVALID', () => {
  const { env } = tmpEnv('USERNAME=me@163.com\nPASSWORD=x');
  const { ok, error } = loadConfig({ env });
  assert.equal(ok, false);
  assert.equal(error.code, ERROR_CODES.CONFIG_INVALID);
});

test('loadConfig: 配置文件不存在 → CONFIG_MISSING', () => {
  const env = { ...process.env, MAIL_SKILLS_ENV: path.join(os.tmpdir(), 'definitely-not-exist-xyz', '.env') };
  const { ok, error } = loadConfig({ env });
  assert.equal(ok, false);
  assert.equal(error.code, ERROR_CODES.CONFIG_MISSING);
  assert.match(error.hint, /setup\.sh/);
});

test('loadConfig: legacy 格式', () => {
  const legacy = [
    'IMAP_HOST=imap.163.com',
    'IMAP_PORT=993',
    'IMAP_USER=me@163.com',
    'IMAP_PASS=code',
    'IMAP_TLS=true',
    'SMTP_HOST=smtp.163.com',
    'SMTP_PORT=465',
    'SMTP_SECURE=true',
    'SMTP_USER=me@163.com',
    'SMTP_PASS=code',
  ].join('\n');
  const { env } = tmpEnv(legacy);
  const { ok, config } = loadConfig({ env });
  assert.equal(ok, true);
  assert.equal(config.imap.host, 'imap.163.com');
  assert.equal(config.imap.user, 'me@163.com');
  assert.equal(config.smtp.secure, true);
  assert.equal(config.imap.retries, 1);
});

test('loadConfig: IMAP_RETRIES / SMTP_RETRIES / 端口覆盖', () => {
  const { env } = tmpEnv(`${SHARED_163}\nIMAP_RETRIES=3\nSMTP_RETRIES=0\nIMAP_PORT=1143\nSMTP_PORT=25`);
  const { config } = loadConfig({ env });
  assert.equal(config.imap.retries, 3);
  assert.equal(config.smtp.retries, 0);
  assert.equal(config.imap.port, 1143);
  assert.equal(config.smtp.port, 25);
});

test('loadConfig: custom provider', () => {
  const custom = [
    'PROVIDER=custom',
    'USERNAME=me@corp.com',
    'PASSWORD=secret',
    'IMAP_HOST=imap.corp.com',
    'IMAP_PORT=993',
    'SMTP_HOST=smtp.corp.com',
    'SMTP_PORT=587',
  ].join('\n');
  const { env } = tmpEnv(custom);
  const { ok, config } = loadConfig({ env });
  assert.equal(ok, true);
  assert.equal(config.imap.host, 'imap.corp.com');
  assert.equal(config.smtp.port, 587);
  assert.equal(config.smtp.secure, false);
});

test('loadConfig: 未知 provider → CONFIG_INVALID', () => {
  const { env } = tmpEnv('PROVIDER=not-a-provider\nUSERNAME=a@b.c\nPASSWORD=x');
  const { ok, error } = loadConfig({ env });
  assert.equal(ok, false);
  assert.equal(error.code, ERROR_CODES.CONFIG_INVALID);
});

test('listAccounts: shared 多账户', () => {
  const { env, file } = tmpEnv(`${SHARED_163}\n\nWORK_PROVIDER=gmail\nWORK_USERNAME=me@work.com\nWORK_PASSWORD=app-pass`);
  const { accounts, configPath } = listAccounts(env);
  assert.equal(configPath, file);
  assert.deepEqual(accounts.map((a) => a.name).sort(), ['default', 'work']);
  const work = accounts.find((a) => a.name === 'work');
  assert.equal(work.imapHost, 'imap.gmail.com');
  assert.equal(work.isComplete, true);
});

test('listAccounts: 无配置时返回空', () => {
  const env = { ...process.env, MAIL_SKILLS_ENV: path.join(os.tmpdir(), 'nope-xyz', '.env') };
  const { accounts } = listAccounts(env);
  assert.deepEqual(accounts, []);
});

test('resolveEnvSource: MAIL_SKILLS_ENV 优先', () => {
  const { env, file } = tmpEnv(SHARED_163);
  const source = resolveEnvSource(env);
  assert.equal(source.path, file);
  assert.equal(source.type, 'shared');
});

test('resolveEnvSource: 空文件被跳过', () => {
  const { env, file } = tmpEnv('');
  // 空文件 → 继续找后面的候选；在干净 HOME 下应为 null
  const homeBackup = process.env.HOME;
  process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-home-'));
  try {
    const source = resolveEnvSource(env);
    // 技能目录内没有 .env，所以最终为 null（空文件不算配置）
    assert.equal(source, null);
  } finally {
    process.env.HOME = homeBackup;
    assert.ok(file); // 临时文件已创建
  }
});
