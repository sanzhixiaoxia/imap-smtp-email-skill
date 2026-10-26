#!/usr/bin/env node
'use strict';

/**
 * IMAP CLI 入口（薄壳）：加载配置 → 建服务 → 注册命令 → 交给 CLI 框架。
 */

const { loadConfig, listAccounts } = require('./config');
const { MailService } = require('./mail-service');
const { StateStore } = require('./state-store');
const { createLogger } = require('./logger');
const { displayAccounts } = require('./accounts-display');
const { runCli, extractAccount, printUsage } = require('./cli');
const { formatError } = require('./errors');
const { runDoctor, formatDoctorReport } = require('./doctor');

// 布尔开关：不吞下一个 token
const BOOL_FLAGS = ['unseen', 'new', 'since-last', 'flat'];

function buildCommands({ service }) {
  return {
    check: {
      description: '收取邮件（--new=24h+未读；--since-last=自从上次检查）',
      handler: async ({ options }) => service.check({
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
      handler: async ({ positional, options }) => service.fetch(positional, {
        mailbox: options.mailbox,
        bodyChars: options['body-chars'],
      }),
    },
    download: {
      description: '下载附件（按 UID，或不带 UID 按 --recent/--new 批量）',
      handler: async ({ positional, options }) => service.download({
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
      handler: async ({ options }) => service.search({
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
      handler: async ({ positional, options }) => service.markRead(positional, options.mailbox),
    },
    'mark-unread': {
      description: '标记未读（支持多个 UID）',
      handler: async ({ positional, options }) => service.markUnread(positional, options.mailbox),
    },
    'list-mailboxes': {
      description: '列出全部文件夹（含每夹邮件数/未读数）',
      handler: async () => service.listMailboxes(),
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
    printUsage('scripts/imap.js', commands);
    process.exit(0);
    return;
  }
  if (cmd && !cmd.startsWith('-') && !commands[cmd]) {
    console.error(`未知命令: ${cmd}`);
    printUsage('scripts/imap.js', commands);
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
  const service = new MailService(loaded.config, {
    logger,
    state: new StateStore(),
  });

  await runCli({
    script: 'scripts/imap.js',
    boolFlags: BOOL_FLAGS,
    argv,
    commands: buildCommands({ service }),
  });
}

main();
