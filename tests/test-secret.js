'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  encrypt, decrypt, isEncrypted, loadOrCreateKey, deriveKey, PREFIX,
} = require('../scripts/secret');
const { buildAccount, renderAccountBlock, writeConfig } = require('../scripts/configure');
const { loadConfig } = require('../scripts/config');

function tmpKey() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mailsec-')), '.key');
}
function tmpEnv() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mailcfg-')), '.env');
}

// --- 加解密往返 ---

test('encrypt/decrypt: 往返一致', () => {
  const key = deriveKey('test-key');
  const pass = 'my-secret-授权码-123';
  const enc = encrypt(pass, { key });
  assert.ok(isEncrypted(enc));
  assert.notEqual(enc, pass);
  assert.match(enc, /^enc:v1:/);
  assert.equal(decrypt(enc, { key }), pass);
});

test('decrypt: 明文值原样返回（向后兼容）', () => {
  assert.equal(decrypt('plain-password', { key: deriveKey('k') }), 'plain-password');
  assert.equal(decrypt('授权码明文', { key: deriveKey('k') }), '授权码明文');
});

test('decrypt: 非 enc 前缀不当密文处理', () => {
  assert.equal(isEncrypted('abc'), false);
  assert.equal(decrypt('abc', { key: deriveKey('x') }), 'abc');
});

test('encrypt: 同一明文两次加密密文不同（随机 IV）', () => {
  const key = deriveKey('k');
  assert.notEqual(encrypt('p', { key }), encrypt('p', { key }));
});

// --- 密钥管理 ---

test('loadOrCreateKey: 首次生成并持久化', () => {
  const keyPath = tmpKey();
  assert.equal(fs.existsSync(keyPath), false);
  const r1 = loadOrCreateKey({ keyPath });
  assert.equal(r1.created, true);
  assert.equal(r1.key.length, 32);
  assert.ok(fs.existsSync(keyPath));
  // 权限 600
  assert.equal(fs.statSync(keyPath).mode & 0o777, 0o600);
  // 二次读取同一密钥
  const r2 = loadOrCreateKey({ keyPath });
  assert.equal(r2.created, false);
  assert.ok(r1.key.equals(r2.key));
});

test('encrypt/decrypt: 用同一密钥文件跨调用一致', () => {
  const keyPath = tmpKey();
  const enc = encrypt('secret', { keyPath });
  assert.equal(decrypt(enc, { keyPath }), 'secret');
});

// --- 篡改检测 ---

test('decrypt: 密文被篡改应抛错（GCM 认证）', () => {
  const key = deriveKey('k');
  const enc = encrypt('secret', { key });
  const buf = Buffer.from(enc.slice(PREFIX.length), 'base64');
  buf[buf.length - 1] ^= 0xff; // 翻转最后一字节
  const tampered = PREFIX + buf.toString('base64');
  assert.throws(() => decrypt(tampered, { key }));
});

test('decrypt: 用错误密钥解密应抛错', () => {
  const enc = encrypt('secret', { key: deriveKey('key-a') });
  assert.throws(() => decrypt(enc, { key: deriveKey('key-b') }));
});

// --- 与 configure/loadConfig 集成 ---

test('configure 写盘为密文，loadConfig 能还原明文', () => {
  const cfg = tmpEnv();
  const keyPath = tmpKey();
  const account = buildAccount({ provider: '163', user: 'a@163.com', password: 'REAL-CODE-999' });

  // 渲染块含密文而非明文
  const block = renderAccountBlock(account, { keyPath });
  assert.ok(block.includes(`PASSWORD=${PREFIX}`));
  assert.ok(!block.includes('REAL-CODE-999'));

  writeConfig(account, { configPath: cfg, keyPath });

  // 磁盘上是密文
  const onDisk = fs.readFileSync(cfg, 'utf8');
  assert.ok(onDisk.includes(PREFIX));
  assert.ok(!onDisk.includes('REAL-CODE-999'));

  // 加载还原明文
  const loaded = loadConfig({ env: { MAIL_SKILLS_ENV: cfg, MAIL_SKILLS_KEY: keyPath } });
  assert.equal(loaded.ok, true);
  assert.equal(loaded.config.imap.pass, 'REAL-CODE-999');
  assert.equal(loaded.config.smtp.pass, 'REAL-CODE-999');
});

test('configure 支持 noEncrypt 明文落盘（兼容旧用法）', () => {
  const block = renderAccountBlock(
    buildAccount({ provider: '163', user: 'a@163.com', password: 'plain' }),
    { noEncrypt: true }
  );
  assert.ok(block.includes('PASSWORD=plain'));
});

test('明文旧配置 loadConfig 仍可读（向后兼容）', () => {
  const cfg = tmpEnv();
  fs.writeFileSync(cfg, 'PROVIDER=163\nUSERNAME=a@163.com\nPASSWORD=oldplain\n');
  const loaded = loadConfig({ env: { MAIL_SKILLS_ENV: cfg, MAIL_SKILLS_KEY: tmpKey() } });
  assert.equal(loaded.ok, true);
  assert.equal(loaded.config.imap.pass, 'oldplain');
});

test('密文密钥不匹配 loadConfig 返回 CONFIG_INVALID 而非裸抛', () => {
  const cfg = tmpEnv();
  const keyA = tmpKey();
  const keyB = tmpKey();
  const account = buildAccount({ provider: '163', user: 'a@163.com', password: 'p' });
  writeConfig(account, { configPath: cfg, keyPath: keyA });
  // 用另一把密钥解密 → 失败
  const loaded = loadConfig({ env: { MAIL_SKILLS_ENV: cfg, MAIL_SKILLS_KEY: keyB } });
  assert.equal(loaded.ok, false);
  assert.equal(loaded.error.code, 'CONFIG_INVALID');
  assert.match(loaded.error.message, /解密失败|INVALID/);
});
