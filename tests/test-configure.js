'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildAccount, renderAccountBlock, writeConfig } = require('../scripts/configure');

function tmpEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailcfg-'));
  return path.join(dir, '.env');
}

// --- buildAccount ---

test('buildAccount: 缺 provider → INVALID_INPUT', () => {
  assert.throws(() => buildAccount({ user: 'a@b.c', password: 'p' }), (e) => e.code === 'INVALID_INPUT');
});

test('buildAccount: 缺 user → INVALID_INPUT', () => {
  assert.throws(() => buildAccount({ provider: '163', password: 'p' }), (e) => e.code === 'INVALID_INPUT');
});

test('buildAccount: 缺 password → INVALID_INPUT', () => {
  assert.throws(() => buildAccount({ provider: '163', user: 'a@b.c' }), (e) => e.code === 'INVALID_INPUT');
});

test('buildAccount: 未知 provider 抛错并提示可用值', () => {
  try {
    buildAccount({ provider: 'hotmail', user: 'a@b.c', password: 'p' });
    assert.fail('应抛出');
  } catch (e) {
    assert.equal(e.code, 'INVALID_INPUT');
    assert.match(e.hint, /163/);
    assert.match(e.hint, /custom/);
  }
});

test('buildAccount: custom 缺 imap-host 抛错', () => {
  assert.throws(() => buildAccount({ provider: 'custom', user: 'a@b.c', password: 'p' }), (e) => e.code === 'INVALID_INPUT');
});

test('buildAccount: 合法 provider 规范化字段', () => {
  const a = buildAccount({ provider: '163', user: 'x@163.com', password: 'code' });
  assert.equal(a.provider, '163');
  assert.equal(a.user, 'x@163.com');
  assert.equal(a.name, null);
});

test('buildAccount: 非法账户名抛错', () => {
  assert.throws(
    () => buildAccount({ provider: '163', user: 'a@b.c', password: 'p', name: 'my account!' }),
    (e) => e.code === 'INVALID_INPUT'
  );
});

test('buildAccount: noVerify 转为布尔', () => {
  const a = buildAccount({ provider: '163', user: 'a@b.c', password: 'p', noVerify: true });
  assert.equal(a.noVerify, true);
});

// --- renderAccountBlock ---

test('renderAccountBlock: 默认账户无前缀，密码加密落盘', () => {
  const a = buildAccount({ provider: '163', user: 'x@163.com', password: 'code' });
  const block = renderAccountBlock(a);
  assert.match(block, /^PROVIDER=163$/m);
  assert.match(block, /^USERNAME=x@163\.com$/m);
  // 密码加密存储，不出现明文
  assert.ok(!block.includes('PASSWORD=code'));
  assert.match(block, /^PASSWORD=enc:v1:/m);
});

test('renderAccountBlock: 默认账户无前缀（noEncrypt 明文兼容）', () => {
  const a = buildAccount({ provider: '163', user: 'x@163.com', password: 'code' });
  const block = renderAccountBlock(a, { noEncrypt: true });
  assert.match(block, /^PROVIDER=163$/m);
  assert.match(block, /^USERNAME=x@163\.com$/m);
  assert.match(block, /^PASSWORD=code$/m);
});

test('renderAccountBlock: 命名账户带大写前缀', () => {
  const a = buildAccount({ provider: 'gmail', user: 'x@gmail.com', password: 'p', name: 'work' });
  const block = renderAccountBlock(a);
  assert.match(block, /^WORK_PROVIDER=gmail$/m);
  assert.match(block, /^WORK_USERNAME=x@gmail\.com$/m);
});

test('renderAccountBlock: custom 输出 host/port', () => {
  const a = buildAccount({
    provider: 'custom', user: 'a@b.c', password: 'p',
    imapHost: 'imap.ex.com', smtpHost: 'smtp.ex.com', imapPort: 1143,
  });
  const block = renderAccountBlock(a);
  assert.match(block, /^IMAP_HOST=imap\.ex\.com$/m);
  assert.match(block, /^IMAP_PORT=1143$/m);
  assert.match(block, /^SMTP_HOST=smtp\.ex\.com$/m);
});

test('renderAccountBlock: noVerify 写入两行 REJECT_UNAUTHORIZED', () => {
  const a = buildAccount({ provider: '163', user: 'a@b.c', password: 'p', noVerify: true });
  const block = renderAccountBlock(a);
  assert.match(block, /^IMAP_REJECT_UNAUTHORIZED=false$/m);
  assert.match(block, /^SMTP_REJECT_UNAUTHORIZED=false$/m);
});

// --- writeConfig ---

test('writeConfig: 创建新文件含默认账户与白名单', () => {
  const cfg = tmpEnv();
  const a = buildAccount({ provider: '163', user: 'a@163.com', password: 'p' });
  const r = writeConfig(a, { configPath: cfg });
  assert.equal(r.created, true);
  assert.equal(r.mode, 'create');
  const text = fs.readFileSync(cfg, 'utf8');
  assert.match(text, /^PROVIDER=163$/m);
  assert.match(text, /^ALLOWED_WRITE_DIRS=/m);
});

test('writeConfig: 追加命名账户保留默认账户', () => {
  const cfg = tmpEnv();
  writeConfig(buildAccount({ provider: '163', user: 'a@163.com', password: 'p1' }), { configPath: cfg });
  writeConfig(buildAccount({ provider: 'gmail', user: 'b@gmail.com', password: 'p2', name: 'work' }), { configPath: cfg });
  const text = fs.readFileSync(cfg, 'utf8');
  assert.match(text, /^PROVIDER=163$/m);
  assert.match(text, /^WORK_PROVIDER=gmail$/m);
  assert.match(text, /^ALLOWED_WRITE_DIRS=/m);
});

test('writeConfig: 重复默认账户拒绝，force 可覆盖', () => {
  const cfg = tmpEnv();
  writeConfig(buildAccount({ provider: '163', user: 'a@163.com', password: 'p1' }), { configPath: cfg });
  assert.throws(
    () => writeConfig(buildAccount({ provider: '163', user: 'b@163.com', password: 'p2' }), { configPath: cfg }),
    (e) => e.code === 'INVALID_INPUT' && /已存在/.test(e.message)
  );
  // force 覆盖成功
  writeConfig(buildAccount({ provider: '163', user: 'b@163.com', password: 'p2' }), { configPath: cfg, force: true });
  const text = fs.readFileSync(cfg, 'utf8');
  assert.match(text, /^USERNAME=b@163\.com$/m);
});

test('writeConfig: 重复命名账户拒绝', () => {
  const cfg = tmpEnv();
  writeConfig(buildAccount({ provider: 'gmail', user: 'x@gmail.com', password: 'p', name: 'work' }), { configPath: cfg });
  assert.throws(
    () => writeConfig(buildAccount({ provider: 'gmail', user: 'y@gmail.com', password: 'q', name: 'work' }), { configPath: cfg }),
    (e) => e.code === 'INVALID_INPUT'
  );
});

test('writeConfig: 输出文件权限 600', () => {
  const cfg = tmpEnv();
  writeConfig(buildAccount({ provider: '163', user: 'a@163.com', password: 'p' }), { configPath: cfg });
  const mode = fs.statSync(cfg).mode & 0o777;
  assert.equal(mode, 0o600);
});
