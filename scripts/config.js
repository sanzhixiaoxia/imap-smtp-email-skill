'use strict';

/**
 * 配置加载层（纯函数，无副作用）。
 * 不读 process.argv、不退出进程、不打印 —— 由调用方决定如何处理失败，
 * 因此可完整单元测试。
 *
 * 解析顺序：MAIL_SKILLS_ENV 覆盖 > legacy > shared > 技能目录 .env
 * 格式由内容推断：含 PROVIDER 键 → shared；否则 → legacy。
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const dotenv = require('dotenv');
const { PROVIDERS } = require('./providers');
const { MailError, ERROR_CODES } = require('./errors');
const { decrypt } = require('./secret');

/** 解密凭证字段：enc:v1: 前缀则解密，明文则原样返回。失败时给出可读错误。 */
function reveal(value, fieldName, keyPath) {
  if (value == null) return value;
  try {
    return decrypt(value, keyPath ? { keyPath } : {});
  } catch (e) {
    throw new MailError(ERROR_CODES.CONFIG_INVALID, `${fieldName} 解密失败`, {
      hint: `密文与密钥不匹配（${e.message}）。密钥存于 ~/.config/mail-skills/.key；如密钥丢失请用 configure 重新写入账户。`,
    });
  }
}

const LEGACY_ENV_PATH = path.join(os.homedir(), '.config', 'imap-smtp-email', '.env');
const SHARED_ENV_PATH = path.join(os.homedir(), '.config', 'mail-skills', '.env');
const FALLBACK_ENV_PATH = path.resolve(__dirname, '..', '.env');

function parseEnvFile(filePath) {
  try {
    const parsed = dotenv.config({ path: filePath }).parsed;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function hasKeyMatching(env, re) {
  return Object.keys(env).some((k) => re.test(k));
}

/**
 * 定位并解析配置文件。
 * @returns {{path: string, env: object, type: 'shared'|'legacy'}|null}
 */
function resolveEnvSource(env = process.env) {
  // 显式指定 MAIL_SKILLS_ENV 时只认它：不存在则不回落（避免静默用到别的配置）
  if (env.MAIL_SKILLS_ENV) {
    const p = path.resolve(env.MAIL_SKILLS_ENV);
    if (!fs.existsSync(p)) return null;
    const parsed = parseEnvFile(p);
    if (Object.keys(parsed).length === 0) return null;
    const type = hasKeyMatching(parsed, /(^|_)PROVIDER$/) ? 'shared' : 'legacy';
    return { path: p, env: parsed, type };
  }

  const candidates = [LEGACY_ENV_PATH, SHARED_ENV_PATH, FALLBACK_ENV_PATH];
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    const parsed = parseEnvFile(p);
    if (Object.keys(parsed).length === 0) continue; // 空文件视为不存在，继续找
    const type = hasKeyMatching(parsed, /(^|_)PROVIDER$/) ? 'shared' : 'legacy';
    return { path: p, env: parsed, type };
  }
  return null;
}

function intOrNull(value) {
  const n = parseInt(value, 10);
  return Number.isNaN(n) ? null : n;
}

function retriesOf(env, prefix, fallback = 1) {
  const n = intOrNull(env[`${prefix}RETRIES`]);
  return n == null ? fallback : Math.max(0, n);
}

// shared 格式（PROVIDER/USERNAME/PASSWORD）
function buildFromShared(env, prefix, keyPath) {
  const p = prefix ? `${prefix}_` : '';
  const provider = env[`${p}PROVIDER`];
  if (!provider) return null;
  const username = env[`${p}USERNAME`];
  const password = reveal(env[`${p}PASSWORD`], `${p}PASSWORD`, keyPath);
  if (!username || !password) return null;

  let imapPreset;
  let smtpPreset;
  if (provider === 'custom') {
    const imapHost = env[`${p}IMAP_HOST`];
    if (!imapHost) return null;
    imapPreset = {
      host: imapHost,
      port: intOrNull(env[`${p}IMAP_PORT`]) || 993,
      tls: env[`${p}IMAP_TLS`] !== 'false',
      rejectUnauthorized: env[`${p}IMAP_REJECT_UNAUTHORIZED`] !== 'false',
    };
    smtpPreset = {
      host: env[`${p}SMTP_HOST`],
      port: intOrNull(env[`${p}SMTP_PORT`]) || 587,
      secure: env[`${p}SMTP_SECURE`] === 'true',
      rejectUnauthorized: env[`${p}SMTP_REJECT_UNAUTHORIZED`] !== 'false',
    };
    if (!smtpPreset.host) return null;
  } else {
    const preset = PROVIDERS[provider];
    if (!preset || !preset.imap || !preset.smtp) return null;
    imapPreset = preset.imap;
    smtpPreset = preset.smtp;
  }

  return {
    provider,
    imap: {
      host: imapPreset.host,
      // 已知 provider 也允许用 <PREFIX>IMAP_PORT 覆盖端口（代理场景）
      port: intOrNull(env[`${p}IMAP_PORT`]) || imapPreset.port,
      user: username,
      pass: password,
      tls: imapPreset.tls,
      rejectUnauthorized: env[`${p}IMAP_REJECT_UNAUTHORIZED`] !== undefined
        ? env[`${p}IMAP_REJECT_UNAUTHORIZED`] !== 'false'
        : imapPreset.rejectUnauthorized,
      mailbox: env[`${p}IMAP_MAILBOX`] || 'INBOX',
      retries: retriesOf(env, `${p}IMAP_`),
    },
    smtp: {
      host: smtpPreset.host,
      port: intOrNull(env[`${p}SMTP_PORT`]) || smtpPreset.port,
      user: username,
      pass: password,
      secure: smtpPreset.secure,
      from: username,
      rejectUnauthorized: env[`${p}SMTP_REJECT_UNAUTHORIZED`] !== undefined
        ? env[`${p}SMTP_REJECT_UNAUTHORIZED`] !== 'false'
        : smtpPreset.rejectUnauthorized,
      retries: retriesOf(env, `${p}SMTP_`),
    },
    allowedReadDirs: splitDirs(env.ALLOWED_READ_DIRS, ['~/Downloads', '~/Documents']),
    allowedWriteDirs: splitDirs(env.ALLOWED_WRITE_DIRS, ['~/Downloads']),
  };
}

// legacy 格式（IMAP_HOST/IMAP_USER/...）
function buildFromLegacy(env, prefix, keyPath) {
  const p = prefix ? `${prefix}_` : '';
  if (prefix && !env[`${p}IMAP_HOST`]) return null;

  return {
    provider: 'legacy',
    imap: {
      host: env[`${p}IMAP_HOST`] || '127.0.0.1',
      port: intOrNull(env[`${p}IMAP_PORT`]) || 1143,
      user: env[`${p}IMAP_USER`],
      pass: reveal(env[`${p}IMAP_PASS`], `${p}IMAP_PASS`, keyPath),
      tls: env[`${p}IMAP_TLS`] === 'true',
      rejectUnauthorized: env[`${p}IMAP_REJECT_UNAUTHORIZED`] !== 'false',
      mailbox: env[`${p}IMAP_MAILBOX`] || 'INBOX',
      retries: retriesOf(env, `${p}IMAP_`),
    },
    smtp: {
      host: env[`${p}SMTP_HOST`],
      port: intOrNull(env[`${p}SMTP_PORT`]) || 587,
      user: env[`${p}SMTP_USER`],
      pass: reveal(env[`${p}SMTP_PASS`], `${p}SMTP_PASS`, keyPath),
      secure: env[`${p}SMTP_SECURE`] === 'true',
      from: env[`${p}SMTP_FROM`] || env[`${p}SMTP_USER`],
      rejectUnauthorized: env[`${p}SMTP_REJECT_UNAUTHORIZED`] !== 'false',
      retries: retriesOf(env, `${p}SMTP_`),
    },
    allowedReadDirs: splitDirs(env.ALLOWED_READ_DIRS, []),
    allowedWriteDirs: splitDirs(env.ALLOWED_WRITE_DIRS, []),
  };
}

function splitDirs(raw, defaults) {
  const value = raw && raw.trim() ? raw : defaults.join(',');
  return value.split(',').map((d) => d.trim()).filter(Boolean);
}

/**
 * 加载配置。
 * @param {{account?: string|null, env?: object}} options
 * @returns {{ok: true, config: object, source: string}
 *          |{ok: false, error: MailError}}
 */
function loadConfig(options = {}) {
  const env = options.env || process.env;
  const account = options.account || null;

  const source = resolveEnvSource(env);
  if (!source) {
    return {
      ok: false,
      error: new MailError(ERROR_CODES.CONFIG_MISSING, '未找到邮箱配置文件', {
        hint: '请先运行 "bash setup.sh" 完成配置（配置写入 ~/.config/mail-skills/.env）',
      }),
    };
  }

  const prefix = account ? String(account).toUpperCase() : null;
  const keyPath = env.MAIL_SKILLS_KEY || undefined;
  let config;
  try {
    config = source.type === 'shared'
      ? buildFromShared(source.env, prefix, keyPath)
      : buildFromLegacy(source.env, prefix, keyPath);
  } catch (e) {
    // 解密失败等凭证错误：以规范 MailError 返回，不抛裸异常
    return { ok: false, error: e instanceof MailError ? e : new MailError(ERROR_CODES.CONFIG_INVALID, e.message) };
  }

  if (!config) {
    const message = account
      ? `账户 "${account}" 不存在或配置不完整（${source.path}）`
      : `默认账户配置不完整（${source.path}）`;
    return {
      ok: false,
      error: new MailError(ERROR_CODES.CONFIG_INVALID, message, {
        hint: 'shared 格式需要 PROVIDER + USERNAME + PASSWORD；legacy 格式需要 IMAP_HOST + IMAP_USER + IMAP_PASS',
      }),
    };
  }

  if (!config.imap.user || !config.imap.pass) {
    return {
      ok: false,
      error: new MailError(ERROR_CODES.CONFIG_INVALID, 'IMAP 用户名或密码为空', {
        hint: '检查配置中的 USERNAME/PASSWORD（shared）或 IMAP_USER/IMAP_PASS（legacy）',
      }),
    };
  }

  config.accountName = account ? String(account).toLowerCase() : 'default';
  config.sourcePath = source.path;
  return { ok: true, config, source: source.path };
}

// --- 账户清单（纯数据，不退出进程） ---

function accountObject(env, prefix, name) {
  const p = prefix;
  return {
    name,
    email: env[`${p}IMAP_USER`] || env[`${p}SMTP_FROM`] || '-',
    imapHost: env[`${p}IMAP_HOST`] || '-',
    smtpHost: env[`${p}SMTP_HOST`] || '-',
    isComplete: !!(env[`${p}IMAP_HOST`] && env[`${p}IMAP_USER`] && env[`${p}IMAP_PASS`] && env[`${p}SMTP_HOST`]),
  };
}

function sharedAccountObject(env, prefix, name) {
  const p = prefix;
  const provider = env[`${p}PROVIDER`];
  const preset = PROVIDERS[provider];
  return {
    name,
    email: env[`${p}USERNAME`] || '-',
    imapHost: (preset && preset.imap) ? preset.imap.host : (env[`${p}IMAP_HOST`] || '-'),
    smtpHost: (preset && preset.smtp) ? preset.smtp.host : (env[`${p}SMTP_HOST`] || '-'),
    isComplete: provider === 'custom'
      ? !!(env[`${p}USERNAME`] && env[`${p}PASSWORD`] && env[`${p}IMAP_HOST`] && env[`${p}SMTP_HOST`])
      : !!(env[`${p}USERNAME`] && env[`${p}PASSWORD`] && preset && preset.imap && preset.smtp),
  };
}

function scanLegacyAccounts(env) {
  const accounts = [];
  const seen = new Set();
  if (env.IMAP_HOST) {
    accounts.push(accountObject(env, '', 'default'));
    seen.add('default');
  }
  for (const key of Object.keys(env)) {
    const match = key.match(/^([A-Z0-9]+)_IMAP_HOST$/);
    if (match) {
      const name = match[1].toLowerCase();
      if (!seen.has(name)) {
        accounts.push(accountObject(env, `${match[1]}_`, name));
        seen.add(name);
      }
    }
  }
  return accounts;
}

function scanSharedAccounts(env) {
  const accounts = [];
  const seen = new Set();
  if (env.PROVIDER) {
    accounts.push(sharedAccountObject(env, '', 'default'));
    seen.add('default');
  }
  for (const key of Object.keys(env)) {
    const match = key.match(/^([A-Z0-9]+)_PROVIDER$/);
    if (match) {
      const name = match[1].toLowerCase();
      if (!seen.has(name)) {
        accounts.push(sharedAccountObject(env, `${match[1]}_`, name));
        seen.add(name);
      }
    }
  }
  return accounts;
}

/**
 * 列出所有来源里的全部账户（legacy 优先，shared 补充去重）。
 * @returns {{accounts: Array, configPath: string|null}}
 */
function listAccounts(env = process.env) {
  const all = [];
  const seen = new Set();
  let configPath = null;

  const legacyPath = env.MAIL_SKILLS_ENV ? null : LEGACY_ENV_PATH;
  if (legacyPath && fs.existsSync(legacyPath)) {
    configPath = legacyPath;
    for (const a of scanLegacyAccounts(parseEnvFile(legacyPath))) {
      seen.add(a.name);
      all.push(a);
    }
  }

  const sharedPath = env.MAIL_SKILLS_ENV ? path.resolve(env.MAIL_SKILLS_ENV) : SHARED_ENV_PATH;
  if (sharedPath && fs.existsSync(sharedPath)) {
    if (!configPath) configPath = sharedPath;
    for (const a of scanSharedAccounts(parseEnvFile(sharedPath))) {
      if (!seen.has(a.name)) {
        seen.add(a.name);
        all.push(a);
      }
    }
  }

  if (!configPath && fs.existsSync(FALLBACK_ENV_PATH)) {
    configPath = FALLBACK_ENV_PATH;
    for (const a of scanLegacyAccounts(parseEnvFile(FALLBACK_ENV_PATH))) {
      if (!seen.has(a.name)) {
        seen.add(a.name);
        all.push(a);
      }
    }
  }

  return { accounts: all, configPath };
}

module.exports = {
  loadConfig,
  listAccounts,
  resolveEnvSource,
  LEGACY_ENV_PATH,
  SHARED_ENV_PATH,
  FALLBACK_ENV_PATH,
};
