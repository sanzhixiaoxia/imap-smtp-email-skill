'use strict';

/**
 * 非交互式配置写入（纯逻辑，可测试）。
 * 目标：让 Agent / 自动化一条命令写好配置，无需走 setup.sh 的交互菜单。
 * 写入 shared 格式（PROVIDER/USERNAME/PASSWORD 或 [ACCOUNT_] 前缀），
 * 与 config.js 的 buildFromShared 解析规则严格对应。
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { PROVIDERS } = require('./providers');
const { MailError, ERROR_CODES } = require('./errors');

const SHARED_CONFIG_DIR = path.join(os.homedir(), '.config', 'mail-skills');
const DEFAULT_CONFIG_PATH = path.join(SHARED_CONFIG_DIR, '.env');

/**
 * 校验并规范化单个账户参数。
 * @param {{provider, user, password, name, imapHost, smtpHost,
 *          imapPort, smtpPort, imapTls, smtpSecure, noVerify}} input
 * @returns {object} 规范化后的账户字段
 * @throws {MailError} 参数缺失/未知 provider
 */
function buildAccount(input) {
  const provider = String(input.provider || '').trim();
  const user = String(input.user || '').trim();
  const password = String(input.password || '');

  if (!provider) throw new MailError(ERROR_CODES.INVALID_INPUT, '缺少 --provider');
  if (!user) throw new MailError(ERROR_CODES.INVALID_INPUT, '缺少 --user（邮箱地址）');
  if (!password) throw new MailError(ERROR_CODES.INVALID_INPUT, '缺少 --password（授权码/应用密码）');

  const isCustom = provider === 'custom';
  const preset = PROVIDERS[provider];
  if (!isCustom && (!preset || !preset.imap || !preset.smtp)) {
    const known = Object.keys(PROVIDERS).filter((k) => PROVIDERS[k].imap && PROVIDERS[k].smtp).concat('custom');
    throw new MailError(ERROR_CODES.INVALID_INPUT, `未知 provider "${provider}"`, {
      hint: `可用值: ${known.join(', ')}`,
    });
  }
  if (isCustom && !input.imapHost) {
    throw new MailError(ERROR_CODES.INVALID_INPUT, 'custom provider 需要 --imap-host');
  }

  const name = input.name ? String(input.name).trim() : null;
  if (name && !/^[a-zA-Z0-9]+$/.test(name)) {
    throw new MailError(ERROR_CODES.INVALID_INPUT, `账户名 "${name}" 只能包含字母和数字`);
  }

  return {
    provider,
    user,
    password,
    name,
    imapHost: isCustom ? String(input.imapHost).trim() : undefined,
    smtpHost: isCustom ? (input.smtpHost ? String(input.smtpHost).trim() : undefined) : undefined,
    imapPort: input.imapPort ? parseInt(input.imapPort, 10) : undefined,
    smtpPort: input.smtpPort ? parseInt(input.smtpPort, 10) : undefined,
    imapTls: input.imapTls === undefined ? undefined : String(input.imapTls) !== 'false',
    smtpSecure: input.smtpSecure === undefined ? undefined : String(input.smtpSecure) === 'true',
    noVerify: !!input.noVerify,
  };
}

/**
 * 把账户渲染成 env 块文本。
 */
function renderAccountBlock(account) {
  const prefix = account.name ? `${account.name.toUpperCase()}_` : '';
  const lines = [
    `# ${account.name || 'Default'} account`,
    `${prefix}PROVIDER=${account.provider}`,
    `${prefix}USERNAME=${account.user}`,
    `${prefix}PASSWORD=${account.password}`,
  ];
  if (account.provider === 'custom') {
    lines.push(`${prefix}IMAP_HOST=${account.imapHost}`);
    if (account.imapPort) lines.push(`${prefix}IMAP_PORT=${account.imapPort}`);
    if (account.imapTls !== undefined) lines.push(`${prefix}IMAP_TLS=${account.imapTls}`);
    if (account.smtpHost) lines.push(`${prefix}SMTP_HOST=${account.smtpHost}`);
    if (account.smtpPort) lines.push(`${prefix}SMTP_PORT=${account.smtpPort}`);
    if (account.smtpSecure !== undefined) lines.push(`${prefix}SMTP_SECURE=${account.smtpSecure}`);
  }
  if (account.noVerify) {
    lines.push(`${prefix}IMAP_REJECT_UNAUTHORIZED=false`);
    lines.push(`${prefix}SMTP_REJECT_UNAUTHORIZED=false`);
  }
  return lines.join('\n');
}

/**
 * 写入配置文件。
 * - default 模式（无 name）：替换默认账户块，保留命名账户；首次创建写入文件白名单。
 * - add 模式（有 name）：追加账户块；保留已有内容与白名单。
 * - 同名已存在且未 force：报错提示用 --force 覆盖。
 *
 * @param {object} account 规范化账户（buildAccount 返回）
 * @param {{configPath?: string, force?: boolean}} options
 * @returns {{path, created, mode, accountName}}
 */
function writeConfig(account, options = {}) {
  const configPath = options.configPath || DEFAULT_CONFIG_PATH;
  const force = !!options.force;
  const exists = fs.existsSync(configPath);
  const existing = exists ? fs.readFileSync(configPath, 'utf8') : '';

  // 探测同名覆盖
  const marker = account.name
    ? new RegExp(`^${account.name.toUpperCase()}_PROVIDER=`, 'm')
    : /^PROVIDER=/m;
  if (existing && marker.test(existing) && !force) {
    const who = account.name ? `账户 "${account.name}"` : '默认账户';
    throw new MailError(ERROR_CODES.INVALID_INPUT, `${who} 已存在`, {
      hint: '如需覆盖请加 --force；或换一个 --name 新增账户',
    });
  }

  const block = renderAccountBlock(account);
  const lines = [];
  let mode;

  if (!exists) {
    mode = 'create';
    lines.push(block);
    lines.push('');
    lines.push('# File access whitelist (security)');
    lines.push(`ALLOWED_READ_DIRS=${path.join(os.homedir(), 'Downloads')},${path.join(os.homedir(), 'Documents')}`);
    lines.push(`ALLOWED_WRITE_DIRS=${path.join(os.homedir(), 'Downloads')}`);
  } else if (account.name) {
    // 命名账户：追加到末尾
    mode = 'add';
    const cleaned = existing.replace(new RegExp(`# ${account.name} account[\\s\\S]*?(?=\\n[A-Z0-9_]+_|$)`, 'g'), '');
    lines.push(cleaned.replace(/\n+$/, ''));
    lines.push(block);
  } else {
    // 默认账户：替换首个默认块（PROVIDER= 之前的部分 + 从 PROVIDER 到下一个命名账户前）
    mode = force ? 'overwrite' : 'reconfigure';
    const kept = existing.split('\n').filter((l) => !/^(PROVIDER|USERNAME|PASSWORD|IMAP_|SMTP_)/.test(l) && !/^# Default account/.test(l));
    // 保留命名账户与白名单（它们不匹配上述前缀）
    const namedAndWhitelist = kept.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '');
    lines.push(block);
    lines.push('');
    lines.push(namedAndWhitelist.replace(/\n+$/, ''));
  }

  const content = lines.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';

  fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(configPath, content, { mode: 0o600 });

  return {
    path: configPath,
    created: !exists,
    mode,
    accountName: account.name || 'default',
  };
}

module.exports = {
  buildAccount,
  renderAccountBlock,
  writeConfig,
  DEFAULT_CONFIG_PATH,
  SHARED_CONFIG_DIR,
};
