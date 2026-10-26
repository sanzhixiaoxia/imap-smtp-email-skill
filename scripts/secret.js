'use strict';

/**
 * 凭证加解密（AES-256-GCM，Node 内置 crypto，无额外依赖）。
 *
 * 目标：配置文件 ~/.config/mail-skills/.env 里的密码不再以明文落盘，
 * 而是存成 `enc:v1:<base64(iv|tag|ciphertext)>`。文件被误读/误传/备份时，
 * 泄露的只是密文而非凭证。
 *
 * 密钥存放：~/.config/mail-skills/.key（权限 600），首次使用时自动生成。
 * 密钥与密文同机同目录，加密收益是「防误泄/防旁路读取」而非对抗本机 root——
 * 与系统 keychain 类似的信任边界。若需更强保护，可将密钥移到外部挂载/环境变量。
 *
 * 解密兼容：加载时若值以 `enc:v1:` 开头则解密，否则按明文原样返回（向后兼容旧配置）。
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const PREFIX = 'enc:v1:';
const ALGO = 'aes-256-gcm';
const KEY_BYTES = 32;

const DEFAULT_KEY_DIR = path.join(os.homedir(), '.config', 'mail-skills');
const DEFAULT_KEY_PATH = path.join(DEFAULT_KEY_DIR, '.key');

/** 任意字符串 → 32 字节密钥（SHA-256）。 */
function deriveKey(passphrase) {
  return crypto.createHash('sha256').update(String(passphrase), 'utf8').digest();
}

/**
 * 读取或创建密钥文件。keyPath 可由 MAIL_SKILLS_KEY 环境变量或参数覆盖。
 * @returns {{key: Buffer, path: string, created: boolean}}
 */
function loadOrCreateKey(options = {}) {
  // 优先级：显式传入 keyPath > MAIL_SKILLS_KEY 环境变量 > 默认路径。
  // 注意：显式参数必须优先于环境变量，否则「写入用 A 密钥、读取用 B 密钥」会解密失败。
  const keyPath = options.keyPath
    || process.env.MAIL_SKILLS_KEY
    || DEFAULT_KEY_PATH;

  if (fs.existsSync(keyPath)) {
    const raw = fs.readFileSync(keyPath, 'utf8').trim();
    if (!raw) throw new Error(`密钥文件为空: ${keyPath}`);
    // 支持两种：hex 密钥，或任意口令（deriveKey）
    const key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : deriveKey(raw);
    return { key, path: keyPath, created: false };
  }

  const key = crypto.randomBytes(KEY_BYTES);
  fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(keyPath, key.toString('hex'), { mode: 0o600 });
  return { key, path: keyPath, created: true };
}

/**
 * 加密一段明文。
 * @param {string} plaintext
 * @param {{key?: Buffer, keyPath?: string}} options
 * @returns {string} enc:v1:<base64(iv|tag|ciphertext)>
 */
function encrypt(plaintext, options = {}) {
  const key = options.key || loadOrCreateKey({ keyPath: options.keyPath }).key;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ct]).toString('base64');
}

/**
 * 解密一个值。非 enc:v1: 前缀的值按明文原样返回（兼容旧配置）。
 * @param {string} value
 * @param {{key?: Buffer, keyPath?: string}} options
 * @returns {string}
 */
function decrypt(value, options = {}) {
  if (value == null) return value;
  const str = String(value);
  if (!str.startsWith(PREFIX)) return str; // 明文兼容

  const buf = Buffer.from(str.slice(PREFIX.length), 'base64');
  if (buf.length < 12 + 16 + 1) throw new Error('密文格式无效');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const key = options.key || loadOrCreateKey({ keyPath: options.keyPath }).key;
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/** 是否为加密串。 */
function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

module.exports = {
  PREFIX,
  ALGO,
  DEFAULT_KEY_PATH,
  deriveKey,
  loadOrCreateKey,
  encrypt,
  decrypt,
  isEncrypted,
};
