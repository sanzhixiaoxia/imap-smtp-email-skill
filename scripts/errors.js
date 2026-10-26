'use strict';

/**
 * 统一错误模型。
 * 所有失败都归类为带 code 的 MailError，meta/输出可被 agent 机器消费；
 * 附带中文 hint，人读也能立刻行动。
 */

const ERROR_CODES = {
  CONFIG_MISSING: 'CONFIG_MISSING',   // 找不到配置文件
  CONFIG_INVALID: 'CONFIG_INVALID',   // 配置存在但缺字段/账户不存在
  AUTH_FAILED: 'AUTH_FAILED',         // 鉴权失败
  CONNECTION_FAILED: 'CONNECTION_FAILED',
  MAILBOX_NOT_FOUND: 'MAILBOX_NOT_FOUND',
  INVALID_INPUT: 'INVALID_INPUT',     // 命令行参数非法
  IO_ERROR: 'IO_ERROR',               // 文件读写失败
  UNKNOWN: 'UNKNOWN',
};

// 网易个人邮箱系列（授权码体系 + 文本 SEARCH 静默失效）
const NETEASE_PERSONAL_PROVIDERS = ['163', 'vip.163', '126', 'vip.126', '188', 'vip.188', 'yeah'];

class MailError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'MailError';
    this.code = code;
    if (options.hint) this.hint = options.hint;
    if (options.cause) this.cause = options.cause;
  }
}

function authHint(provider) {
  if (NETEASE_PERSONAL_PROVIDERS.includes(provider)) {
    return '网易邮箱(163/126/188/yeah)必须使用「授权码」而非登录密码，且需先在网页版 设置 → POP3/SMTP/IMAP 中开启 IMAP 服务。';
  }
  if (provider === 'qq' || provider === 'exmail.qq') {
    return 'QQ 邮箱必须使用「授权码」（非登录密码），并先在设置中开启 IMAP 服务。';
  }
  if (provider === 'gmail') {
    return 'Gmail 不接受账号密码，需生成「应用专用密码」(https://myaccount.google.com/apppasswords) 并开启两步验证。';
  }
  return null;
}

/**
 * 把任意 Error 归类为 MailError（带 code + 中文 hint）。
 * provider 用于生成针对性的鉴权提示。
 */
function classifyError(err, provider = null) {
  if (err instanceof MailError) return err;
  const msg = (err && err.message) || String(err);

  // 覆盖各家库的鉴权报错措辞：node-imap "Invalid credentials (failure)"、
  // nodemailer "Invalid login: 535 ..."、"535 Authentication failed" 等
  if (/(auth|credential|invalid credentials|login error|password error|invalid login|authentication failed|login failed|logon failure|\b535\b)/i.test(msg)) {
    return new MailError(ERROR_CODES.AUTH_FAILED, msg, { hint: authHint(provider), cause: err });
  }
  if (/mailbox/i.test(msg) && /(not exist|doesn't exist|no such|nonexistent|failed to open|cannot open)/i.test(msg)) {
    return new MailError(ERROR_CODES.MAILBOX_NOT_FOUND, msg, {
      hint: '文件夹不存在或无法打开。可用 list-mailboxes 查看全部文件夹；163 的中文文件夹（如「已发送」「垃圾邮件」）可直接作为 --mailbox 传入。',
      cause: err,
    });
  }
  if (/(timeout|timed out|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|self-signed|certificate|socket hang|connection (failed|refused|reset|closed))/i.test(msg)) {
    return new MailError(ERROR_CODES.CONNECTION_FAILED, msg, { cause: err });
  }
  return new MailError(ERROR_CODES.UNKNOWN, msg, { cause: err });
}

// 终端输出用：错误[CODE]: 信息 + 提示行
function formatError(err, provider = null) {
  const e = err instanceof MailError ? err : classifyError(err, provider);
  const lines = [`错误[${e.code}]: ${e.message}`];
  if (e.hint) lines.push(`提示: ${e.hint}`);
  return lines.join('\n');
}

module.exports = {
  MailError,
  ERROR_CODES,
  NETEASE_PERSONAL_PROVIDERS,
  classifyError,
  formatError,
  authHint,
};
