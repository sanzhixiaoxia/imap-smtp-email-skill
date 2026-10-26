#!/usr/bin/env node
'use strict';

/**
 * SMTP CLI 入口（薄壳）：加载配置 → 建服务 → 注册命令 → 交给 CLI 框架。
 */

const fs = require('node:fs');
const { loadConfig, listAccounts } = require('./config');
const { SmtpService, validateReadPath } = require('./smtp-service');
const { createLogger } = require('./logger');
const { displayAccounts } = require('./accounts-display');
const { runCli, extractAccount, printUsage } = require('./cli');
const { formatError, MailError, ERROR_CODES } = require('./errors');
const { runDoctor, formatDoctorReport } = require('./doctor');

const BOOL_FLAGS = ['html'];

function resolveAttachments(service, attachArg) {
  if (!attachArg) return [];
  return attachArg
    .split(',')
    .map((f) => f.trim())
    .filter(Boolean)
    .map((f) => {
      validateReadPath(f, service.config.allowedReadDirs);
      if (!fs.existsSync(f)) {
        throw new MailError(ERROR_CODES.IO_ERROR, `附件文件不存在: ${f}`);
      }
      return f;
    });
}

function resolveBody(service, options) {
  if (options['body-file']) {
    validateReadPath(options['body-file'], service.config.allowedReadDirs);
    const content = fs.readFileSync(options['body-file'], 'utf8');
    return options['body-file'].endsWith('.html') || options.html
      ? { html: content }
      : { text: content };
  }
  if (options['html-file']) {
    validateReadPath(options['html-file'], service.config.allowedReadDirs);
    return { html: fs.readFileSync(options['html-file'], 'utf8') };
  }
  if (options.body) return { text: options.body };
  return {};
}

function buildCommands({ service }) {
  return {
    send: {
      description: '发送邮件（--to/--subject 必填，支持 --html/--cc/--bcc/--attach）',
      handler: async ({ options }) => {
        let subject = options.subject;
        if (options['subject-file']) {
          validateReadPath(options['subject-file'], service.config.allowedReadDirs);
          subject = fs.readFileSync(options['subject-file'], 'utf8').trim();
        }
        return service.send({
          to: options.to,
          subject,
          ...resolveBody(service, options),
          cc: options.cc,
          bcc: options.bcc,
          from: options.from,
          attachments: resolveAttachments(service, options.attach),
        });
      },
    },
    test: {
      description: '测试 SMTP 连通性（会给自己发一封测试邮件）',
      handler: async () => service.sendTest(),
    },
    'list-accounts': {
      description: '列出所有已配置账户',
      raw: true,
      handler: () => {
        const { accounts, configPath } = listAccounts();
        displayAccounts(accounts, configPath);
      },
    },
    doctor: {
      description: '体检：逐账户测试 IMAP/SMTP 连通性（不发送邮件）',
      raw: true,
      handler: async () => {
        const report = await runDoctor();
        console.log(formatDoctorReport(report));
        if (!report.ok) process.exitCode = 1;
      },
    },
  };
}

async function main() {
  const { accountName, argv } = extractAccount(process.argv);

  // 帮助与未知命令在加载配置之前处理：没配账户也能看到用法
  const commands = buildCommands({ service: null });
  const cmd = argv[2];
  if (argv.includes('--help') || argv.includes('-h') || cmd === 'help') {
    printUsage('scripts/smtp.js', commands);
    process.exit(0);
    return;
  }
  if (cmd && !cmd.startsWith('-') && !commands[cmd]) {
    console.error(`未知命令: ${cmd}`);
    printUsage('scripts/smtp.js', commands);
    process.exit(1);
    return;
  }

  const loaded = loadConfig({ account: accountName });
  if (!loaded.ok) {
    console.error(formatError(loaded.error));
    process.exit(1);
    return;
  }

  const logger = createLogger({ verbose: argv.includes('--verbose') });
  const service = new SmtpService(loaded.config, { logger });

  await runCli({
    script: 'scripts/smtp.js',
    boolFlags: BOOL_FLAGS,
    argv,
    commands: buildCommands({ service }),
  });
}

main();
