#!/usr/bin/env node
'use strict';

/**
 * 统一 CLI 入口（推荐）：一个 `mail.js` 汇聚收发/配置/体检全部能力。
 * 相比 imap.js + smtp.js 的分离入口，这里一条命令即可完成常用操作：
 *   node scripts/mail.js configure --provider 163 --user xx@163.com --password 授权码
 *   node scripts/mail.js check --new
 *   node scripts/mail.js send --to a@b.c --subject Hi --body Hello
 * imap.js / smtp.js 仍保留为兼容入口，内部复用同一套服务层。
 */

const fs = require('node:fs');
const { loadConfig, listAccounts } = require('./config');
const { MailService } = require('./mail-service');
const { SmtpService, validateReadPath } = require('./smtp-service');
const { StateStore } = require('./state-store');
const { createLogger } = require('./logger');
const { displayAccounts } = require('./accounts-display');
const { runCli, extractAccount, printUsage } = require('./cli');
const { formatError, MailError, ERROR_CODES } = require('./errors');
const { runDoctor, formatDoctorReport } = require('./doctor');
const { buildAccount, writeConfig } = require('./configure');
const { PROVIDERS, providerNames } = require('./providers');

// 布尔开关：不吞下一个 token
const BOOL_FLAGS = ['unseen', 'new', 'since-last', 'flat', 'html', 'force', 'no-verify'];

// --- SMTP 辅助（与 smtp.js 保持一致） ---
function resolveAttachments(service, attachArg) {
  if (!attachArg) return [];
  return String(attachArg)
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

/**
 * 构建全部命令。
 * @param {{imap: MailService|null, smtp: SmtpService|null}} services
 */
function buildCommands({ imap, smtp }) {
  return {
    // ---- 配置（无需已加载配置，独立处理） ----
    configure: {
      description: '非交互式写入账户配置（一条命令，无需 setup.sh 菜单）',
      raw: true,
      handler: async ({ options }) => {
        const account = buildAccount({
          provider: options.provider,
          user: options.user,
          password: options.password,
          name: options.name,
          imapHost: options['imap-host'],
          smtpHost: options['smtp-host'],
          imapPort: options['imap-port'],
          smtpPort: options['smtp-port'],
          imapTls: options['imap-tls'],
          smtpSecure: options['smtp-secure'],
          noVerify: !!options['no-verify'],
        });
        // 若指定密钥路径，同步到环境变量，保证写入密钥 == 后续读取密钥
        if (options['key-path']) {
          process.env.MAIL_SKILLS_KEY = options['key-path'];
        }
        const result = writeConfig(account, {
          configPath: options['config-path'],
          keyPath: options['key-path'],
          force: !!options.force,
        });
        console.log(`✓ 配置已写入: ${result.path}`);
        console.log(`  账户: ${result.accountName} (${account.provider} / ${account.user})`);
        console.log('');
        console.log('下一步: node scripts/mail.js check --new');
      },
    },
    providers: {
      description: '列出所有内置 provider（邮箱服务商）',
      raw: true,
      handler: () => {
        console.log('内置 provider（可直接用作 --provider 取值）:\n');
        for (const name of providerNames()) {
          const p = PROVIDERS[name];
          const imapHost = (p.imap && p.imap.host) || '-';
          const smtpHost = (p.smtp && p.smtp.host) || '-';
          console.log(`  ${name.padEnd(26)} IMAP: ${imapHost.padEnd(26)} SMTP: ${smtpHost}`);
        }
        console.log('\n  custom                  自定义服务器（需 --imap-host 等）');
      },
    },

    // ---- 收取 ----
    check: {
      description: '收取邮件（--new=24h+未读；--since-last=自从上次检查）',
      handler: async ({ options }) => imap.check({
        mailbox: options.mailbox,
        limit: options.limit,
        unreadOnly: !!options.unseen || !!options.new,
        recentTime: options.recent || (options.new ? '24h' : null),
        sinceLast: !!options['since-last'],
        offset: options.offset,
        bodyChars: options['body-chars'],
      }),
    },
    fetch: {
      description: '按 UID 拉取全文（支持 fetch <uid> [uid2...]）',
      handler: async ({ positional, options }) => imap.fetch(positional, {
        mailbox: options.mailbox,
        bodyChars: options['body-chars'],
      }),
    },
    download: {
      description: '下载附件（按 UID，或不带 UID 按 --recent/--new 批量）',
      handler: async ({ positional, options }) => imap.download({
        uids: positional,
        mailbox: options.mailbox,
        dir: options.dir,
        file: options.file,
        recent: options.recent,
        new: !!options.new,
        since: options.since,
        unseen: !!options.unseen,
        limit: options.limit,
        flat: !!options.flat,
      }),
    },
    search: {
      description: '搜索邮件（--from/--subject/--since/--recent/--unseen...）',
      handler: async ({ options }) => imap.search({
        mailbox: options.mailbox,
        limit: options.limit,
        offset: options.offset,
        from: options.from,
        subject: options.subject,
        recent: options.recent,
        new: !!options.new,
        since: options.since,
        before: options.before,
        unseen: !!options.unseen,
        seen: !!options.seen,
        sort: options.sort,
        bodyChars: options['body-chars'],
      }),
    },
    'mark-read': {
      description: '标记已读（支持多个 UID）',
      handler: async ({ positional, options }) => imap.markRead(positional, options.mailbox),
    },
    'mark-unread': {
      description: '标记未读（支持多个 UID）',
      handler: async ({ positional, options }) => imap.markUnread(positional, options.mailbox),
    },
    'list-mailboxes': {
      description: '列出全部文件夹（含每夹邮件数/未读数）',
      handler: async () => imap.listMailboxes(),
    },

    // ---- 发送 ----
    send: {
      description: '发送邮件（--to/--subject 必填，支持 --html/--cc/--bcc/--attach）',
      handler: async ({ options }) => {
        let subject = options.subject;
        if (options['subject-file']) {
          validateReadPath(options['subject-file'], smtp.config.allowedReadDirs);
          subject = fs.readFileSync(options['subject-file'], 'utf8').trim();
        }
        return smtp.send({
          to: options.to,
          subject,
          ...resolveBody(smtp, options),
          cc: options.cc,
          bcc: options.bcc,
          from: options.from,
          attachments: resolveAttachments(smtp, options.attach),
        });
      },
    },
    'send-test': {
      description: '测试 SMTP 连通性（会给自己发一封测试邮件）',
      handler: async () => smtp.sendTest(),
    },

    // ---- 通用 ----
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

// 需要服务的命令（configure/providers/list-accounts/doctor/help 之外）
const IMAP_COMMANDS = new Set(['check', 'fetch', 'download', 'search', 'mark-read', 'mark-unread', 'list-mailboxes']);
const SMTP_COMMANDS = new Set(['send', 'send-test']);

async function main() {
  const { accountName, argv } = extractAccount(process.argv);
  const commands = buildCommands({ imap: null, smtp: null });
  const cmd = argv[2];

  // 帮助与未知命令在加载配置之前处理
  if (argv.includes('--help') || argv.includes('-h') || cmd === 'help') {
    printUsage('scripts/mail.js', commands);
    process.exit(0);
    return;
  }
  if (cmd && !cmd.startsWith('-') && !commands[cmd]) {
    console.error(`未知命令: ${cmd}`);
    printUsage('scripts/mail.js', commands);
    process.exit(1);
    return;
  }

  // configure / providers / list-accounts 不依赖 IMAP/SMTP 服务，可独立运行
  const noServiceNeeded = new Set(['configure', 'providers', 'list-accounts']);

  let imap = null;
  let smtp = null;
  if (!noServiceNeeded.has(cmd)) {
    const loaded = loadConfig({ account: accountName });
    if (!loaded.ok) {
      console.error(formatError(loaded.error));
      process.exit(1);
      return;
    }
    const logger = createLogger({ verbose: argv.includes('--verbose') });
    if (IMAP_COMMANDS.has(cmd)) {
      imap = new MailService(loaded.config, { logger, state: new StateStore() });
    }
    if (SMTP_COMMANDS.has(cmd)) {
      smtp = new SmtpService(loaded.config, { logger });
    }
    // doctor 需要 config 但内部自建服务
  }

  await runCli({
    script: 'scripts/mail.js',
    boolFlags: BOOL_FLAGS,
    argv,
    commands: buildCommands({ imap, smtp }),
  });
}

main();
