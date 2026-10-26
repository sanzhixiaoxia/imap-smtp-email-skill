'use strict';

/**
 * doctor 命令：逐账户体检 IMAP/SMTP 连通性。
 * SMTP 只做 verify，不发送任何邮件。imap.js 与 smtp.js 共用。
 */

const { loadConfig, listAccounts } = require('./config');
const { MailService } = require('./mail-service');
const { SmtpService } = require('./smtp-service');
const { createLogger } = require('./logger');

function padDisplay(str, len) {
  const s = String(str == null ? '' : str);
  // 粗略按字符数补齐（状态列内容为 ASCII）
  return s.length >= len ? s : s + ' '.repeat(len - s.length);
}

/**
 * @returns {Promise<{ok: boolean, rows: Array}>}
 */
async function runDoctor({ logger } = {}) {
  const log = logger || createLogger();
  const { accounts, configPath } = listAccounts();
  if (!accounts.length) {
    return { ok: false, rows: [], configPath, error: '没有配置任何账户' };
  }

  const rows = [];
  let ok = true;
  for (const account of accounts) {
    const name = account.name === 'default' ? null : account.name;
    const loaded = loadConfig({ account: name });
    if (!loaded.ok) {
      rows.push({ account: account.name, email: account.email, imap: `✗ ${loaded.error.code}`, smtp: '—' });
      ok = false;
      continue;
    }

    let imapStatus = '✓';
    try {
      const service = new MailService(loaded.config, { logger: log });
      await service.listMailboxes();
    } catch (err) {
      imapStatus = `✗ ${err.code || 'ERROR'}`;
      ok = false;
    }

    let smtpStatus = '✓';
    try {
      const smtpService = new SmtpService(loaded.config, { logger: log });
      await smtpService.verify();
    } catch (err) {
      smtpStatus = `✗ ${err.code || 'ERROR'}`;
      ok = false;
    }

    rows.push({
      account: account.name,
      email: loaded.config.imap.user,
      imap: imapStatus,
      smtp: smtpStatus,
    });
  }
  return { ok, rows, configPath };
}

function formatDoctorReport(report) {
  if (report.error) {
    return `体检失败: ${report.error}（${report.configPath || '未找到配置文件'}）`;
  }
  const nameLen = Math.max(7, ...report.rows.map((r) => r.account.length));
  const emailLen = Math.max(5, ...report.rows.map((r) => r.email.length));
  const lines = [
    `账户体检（${report.configPath}）—— SMTP 仅校验连通性，不发送邮件`,
    '',
    `  ${padDisplay('Account', nameLen)}  ${padDisplay('Email', emailLen)}  IMAP  SMTP`,
    `  ${'─'.repeat(nameLen)}  ${'─'.repeat(emailLen)}  ────  ────`,
  ];
  for (const r of report.rows) {
    lines.push(`  ${padDisplay(r.account, nameLen)}  ${padDisplay(r.email, emailLen)}  ${padDisplay(r.imap, 5)}  ${r.smtp}`);
  }
  lines.push('');
  lines.push(report.ok ? '全部账户正常 ✓' : '存在异常账户，详见上表（错误码含义见 SKILL.md）');
  return lines.join('\n');
}

module.exports = { runDoctor, formatDoctorReport };
