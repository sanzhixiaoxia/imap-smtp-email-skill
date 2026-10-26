'use strict';

/**
 * SMTP 服务层：发送（带重试）、连通性校验。
 * 附件/正文文件的读取受 ALLOWED_READ_DIRS 白名单约束。
 */

const nodemailer = require('nodemailer');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { detectProvider } = require('./providers');
const { MailError, ERROR_CODES, classifyError } = require('./errors');
const { createLogger } = require('./logger');
const { intOr } = require('./utils');

function validateReadPath(inputPath, allowedReadDirs) {
  // 先展开 ~（realpathSync 不展开），否则 --attach ~/Downloads/x 会被误拒
  const expanded = String(inputPath).replace(/^~/, os.homedir());
  let realPath;
  try {
    realPath = fs.realpathSync(expanded);
  } catch {
    realPath = path.resolve(expanded);
  }
  if (!allowedReadDirs || !allowedReadDirs.length) {
    throw new MailError(ERROR_CODES.CONFIG_INVALID, 'ALLOWED_READ_DIRS 未配置，文件读取已禁用', {
      hint: '在 .env 中设置 ALLOWED_READ_DIRS（例如 ~/Downloads）',
    });
  }
  const allowedDirs = allowedReadDirs.map((d) => path.resolve(d.replace(/^~/, os.homedir())));
  const allowed = allowedDirs.some((dir) => realPath === dir || realPath.startsWith(dir + path.sep));
  if (!allowed) {
    throw new MailError(ERROR_CODES.IO_ERROR, `拒绝读取: '${inputPath}' 不在 ALLOWED_READ_DIRS 白名单内`, {
      hint: `当前白名单: ${allowedDirs.join(', ')}`,
    });
  }
  return realPath;
}

class SmtpService {
  /**
   * @param {object} config loadConfig() 返回的 config 对象
   * @param {{logger?: object, transportFactory?: Function}} options
   */
  constructor(config, options = {}) {
    this.config = config;
    this.logger = options.logger || createLogger();
    this.transportFactory = options.transportFactory || null;
  }

  get provider() {
    return detectProvider(this.config.imap.host);
  }

  _transport() {
    if (this.transportFactory) return this.transportFactory();
    const smtp = this.config.smtp;
    if (!smtp.host || !smtp.user || !smtp.pass) {
      throw new MailError(ERROR_CODES.CONFIG_INVALID, '缺少 SMTP 配置', {
        hint: '检查配置中的 USERNAME/PASSWORD 与 PROVIDER（或 SMTP_HOST/SMTP_USER/SMTP_PASS）',
      });
    }
    return nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      auth: { user: smtp.user, pass: smtp.pass },
      tls: { rejectUnauthorized: smtp.rejectUnauthorized },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
    });
  }

  _classify(err) {
    return classifyError(err, this.provider);
  }

  /** 只校验连通性，不发送任何邮件 */
  async verify() {
    const transporter = this._transport();
    try {
      await transporter.verify();
      return { success: true, host: this.config.smtp.host, port: this.config.smtp.port };
    } catch (err) {
      throw this._classify(err);
    }
  }

  /**
   * 发送邮件（失败自动重试，次数见 SMTP_RETRIES，默认 1）。
   * options: {to, subject, text, html, cc, bcc, from, attachments:[localPath]}
   */
  async send(options = {}) {
    const t0 = Date.now();
    if (!options.to) {
      throw new MailError(ERROR_CODES.INVALID_INPUT, '缺少收件人: --to <email>');
    }
    if (!options.subject && !options['subject-file']) {
      throw new MailError(ERROR_CODES.INVALID_INPUT, '缺少主题: --subject <text> 或 --subject-file <file>');
    }

    const mailOptions = {
      from: options.from || this.config.smtp.from || this.config.smtp.user,
      to: options.to,
      cc: options.cc || undefined,
      bcc: options.bcc || undefined,
      subject: options.subject || '(no subject)',
      text: options.text || undefined,
      html: options.html || undefined,
      attachments: (options.attachments || []).map((p) => ({
        filename: path.basename(p),
        path: p,
      })),
    };
    if (!mailOptions.text && !mailOptions.html) {
      mailOptions.text = options.body || '';
    }

    const retries = Math.max(0, intOr(this.config.smtp.retries, 1));
    const transporter = this._transport();
    let lastErr;
    for (let attempt = 1; attempt <= retries + 1; attempt++) {
      try {
        this.logger.debug(`smtp send attempt ${attempt}/${retries + 1} → ${this.config.smtp.host}:${this.config.smtp.port}`);
        const info = await transporter.sendMail(mailOptions);
        return {
          success: true,
          messageId: info.messageId,
          response: info.response,
          to: mailOptions.to,
          attempts: attempt,
          elapsedMs: Date.now() - t0,
        };
      } catch (err) {
        lastErr = this._classify(err);
        if (attempt <= retries) {
          await new Promise((r) => setTimeout(r, 800 * attempt));
        }
      }
    }
    throw lastErr;
  }

  /** 连通性测试：verify + 给自己发一封测试邮件 */
  async sendTest() {
    const transporter = this._transport();
    try {
      await transporter.verify();
      const info = await transporter.sendMail({
        from: this.config.smtp.from || this.config.smtp.user,
        to: this.config.smtp.user,
        subject: 'SMTP Connection Test',
        text: 'This is a test email from the IMAP/SMTP email skill.',
        html: '<p>This is a <strong>test email</strong> from the IMAP/SMTP email skill.</p>',
      });
      return { success: true, message: 'SMTP connection successful', messageId: info.messageId };
    } catch (err) {
      throw this._classify(err);
    }
  }
}

module.exports = { SmtpService, validateReadPath };
