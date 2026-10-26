'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  runCli, extractAccount, emitResult, hasEmailItems, emailItems, VALID_FORMATS,
} = require('../scripts/cli');
const { MailError, ERROR_CODES } = require('../scripts/errors');

// 临时接管 console.log/console.error，返回捕获器
function capture() {
  const out = { stdout: [], stderr: [] };
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a) => out.stdout.push(a.join(' '));
  console.error = (...a) => out.stderr.push(a.join(' '));
  return {
    out,
    restore() {
      console.log = origLog;
      console.error = origErr;
    },
  };
}

// --- extractAccount ---

test('extractAccount: 剥离 --account <name>', () => {
  const { accountName, argv } = extractAccount(['node', 'imap.js', '--account', 'work', 'check']);
  assert.equal(accountName, 'work');
  assert.deepEqual(argv, ['node', 'imap.js', 'check']);
});

test('extractAccount: 无 --account 时原样返回', () => {
  const argv = ['node', 'imap.js', 'check', '--unseen'];
  const r = extractAccount(argv);
  assert.equal(r.accountName, null);
  assert.deepEqual(r.argv, argv);
});

test('extractAccount: --account 位于末尾无取值时忽略', () => {
  const r = extractAccount(['node', 'imap.js', 'check', '--account']);
  assert.equal(r.accountName, null);
  assert.equal(r.argv.length, 4); // 原样保留
});

// --- emitResult ---

function fakeEmailResult() {
  return {
    results: [
      {
        uid: 1, mailbox: 'INBOX', date: new Date(2026, 9, 18, 14, 2),
        from: 'a@163.com', to: 'boss@163.com', subject: '报价单',
        flags: [], attachments: [], snippet: '见附件',
      },
    ],
    meta: { command: 'check', account: 'default' },
  };
}

test('emitResult: 默认 json 输出信封', () => {
  const cap = capture();
  try {
    emitResult(fakeEmailResult(), {});
  } finally {
    cap.restore();
  }
  const parsed = JSON.parse(cap.out.stdout.join('\n'));
  assert.equal(parsed.meta.command, 'check');
  assert.equal(parsed.results[0].uid, 1);
});

test('emitResult: --save 写入文件且不打印 JSON 到 stdout', () => {
  const cap = capture();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-cli-'));
  const file = path.join(dir, 'sub', 'out.json');
  try {
    emitResult(fakeEmailResult(), { save: file, format: 'json' });
  } finally {
    cap.restore();
  }
  assert.equal(cap.out.stdout.length, 0);
  assert.match(cap.out.stderr.join('\n'), /结果已保存到/);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.results[0].subject, '报价单');
});

test('emitResult: csv 格式输出表头', () => {
  const cap = capture();
  try {
    emitResult(fakeEmailResult(), { format: 'csv' });
  } finally {
    cap.restore();
  }
  const csv = cap.out.stdout.join('\n');
  assert.match(csv, /^uid,mailbox,date,from,to,subject,unseen,attachments,snippet/);
  assert.match(csv, /报价单/);
});

test('emitResult: table 格式走对齐表格', () => {
  const cap = capture();
  try {
    emitResult(fakeEmailResult(), { format: 'table' });
  } finally {
    cap.restore();
  }
  const table = cap.out.stdout.join('\n');
  assert.match(table, /UID/);
  assert.match(table, /报价单/);
});

test('emitResult: text 格式逐封输出', () => {
  const cap = capture();
  try {
    emitResult(fakeEmailResult(), { format: 'text' });
  } finally {
    cap.restore();
  }
  const text = cap.out.stdout.join('\n');
  assert.match(text, /报价单/);
});

test('emitResult: 非邮件结果（如 {success:true}）任何格式都走 JSON', () => {
  const cap = capture();
  try {
    emitResult({ success: true }, { format: 'table' });
  } finally {
    cap.restore();
  }
  const parsed = JSON.parse(cap.out.stdout.join('\n'));
  assert.equal(parsed.success, true);
});

test('hasEmailItems/emailItems: 识别信封与单封邮件', () => {
  assert.equal(hasEmailItems(fakeEmailResult()), true);
  assert.equal(hasEmailItems({ success: true }), false);
  assert.equal(emailItems(fakeEmailResult()).length, 1);
  assert.equal(emailItems({ from: 'a@b.c' }).length, 1);
});

test('VALID_FORMATS: 包含四种输出格式', () => {
  assert.deepEqual(VALID_FORMATS, ['json', 'table', 'text', 'csv']);
});

// --- runCli ---

function makeCommands(overrides = {}) {
  return {
    ping: {
      description: '测试命令',
      handler: async ({ options }) => ({ pong: true, ...(options.limit ? { limit: options.limit } : {}) }),
      ...overrides.ping,
    },
    boom: {
      description: '必抛错的命令',
      handler: async () => {
        throw new MailError(ERROR_CODES.AUTH_FAILED, 'Invalid credentials');
      },
      ...overrides.boom,
    },
  };
}

test('runCli: 正常命令返回结果并输出 JSON', async () => {
  const cap = capture();
  let exitCode = null;
  try {
    await runCli({
      script: 'imap.js',
      argv: ['node', 'imap.js', 'ping'],
      commands: makeCommands(),
      exit: (c) => { exitCode = c; },
    });
  } finally {
    cap.restore();
  }
  assert.equal(exitCode, null);
  const parsed = JSON.parse(cap.out.stdout.join('\n'));
  assert.equal(parsed.pong, true);
});

test('runCli: raw 命令不经过 emitResult', async () => {
  const cap = capture();
  let exitCode = null;
  try {
    await runCli({
      script: 'imap.js',
      argv: ['node', 'imap.js', 'ping'],
      commands: makeCommands({ ping: { raw: true } }),
      exit: (c) => { exitCode = c; },
    });
  } finally {
    cap.restore();
  }
  assert.equal(exitCode, null);
  assert.equal(cap.out.stdout.length, 0);
});

test('runCli: --help 打印用法并 exit 0', async () => {
  const cap = capture();
  let exitCode = null;
  try {
    await runCli({
      script: 'imap.js',
      argv: ['node', 'imap.js', '--help'],
      commands: makeCommands(),
      exit: (c) => { exitCode = c; },
    });
  } finally {
    cap.restore();
  }
  assert.equal(exitCode, 0);
  const usage = cap.out.stderr.join('\n');
  assert.match(usage, /用法: node imap\.js/);
  assert.match(usage, /ping/);
});

test('runCli: help 命令同样打印用法', async () => {
  const cap = capture();
  let exitCode = null;
  try {
    await runCli({
      script: 'imap.js',
      argv: ['node', 'imap.js', 'help'],
      commands: makeCommands(),
      exit: (c) => { exitCode = c; },
    });
  } finally {
    cap.restore();
  }
  assert.equal(exitCode, 0);
  assert.match(cap.out.stderr.join('\n'), /可用命令/);
});

test('runCli: 未知命令 exit 1', async () => {
  const cap = capture();
  let exitCode = null;
  try {
    await runCli({
      script: 'imap.js',
      argv: ['node', 'imap.js', 'nope'],
      commands: makeCommands(),
      exit: (c) => { exitCode = c; },
    });
  } finally {
    cap.restore();
  }
  assert.equal(exitCode, 1);
  assert.match(cap.out.stderr.join('\n'), /未知命令: nope/);
});

test('runCli: 非法 --format exit 1', async () => {
  const cap = capture();
  let exitCode = null;
  try {
    await runCli({
      script: 'imap.js',
      argv: ['node', 'imap.js', 'ping', '--format', 'yaml'],
      commands: makeCommands(),
      exit: (c) => { exitCode = c; },
    });
  } finally {
    cap.restore();
  }
  assert.equal(exitCode, 1);
  assert.match(cap.out.stderr.join('\n'), /未知输出格式 "yaml"/);
});

test('runCli: 合法 --format 透传给 handler', async () => {
  const cap = capture();
  try {
    await runCli({
      script: 'imap.js',
      argv: ['node', 'imap.js', 'ping', '--limit', '5'],
      commands: makeCommands(),
      exit: () => {},
    });
  } finally {
    cap.restore();
  }
  const parsed = JSON.parse(cap.out.stdout.join('\n'));
  assert.equal(parsed.limit, '5');
});

test('runCli: 命令抛错 → 中文错误输出并 exit 1', async () => {
  const cap = capture();
  let exitCode = null;
  try {
    await runCli({
      script: 'imap.js',
      argv: ['node', 'imap.js', 'boom'],
      commands: makeCommands(),
      exit: (c) => { exitCode = c; },
    });
  } finally {
    cap.restore();
  }
  assert.equal(exitCode, 1);
  // MailError 原样透传（code/message 保留），不带 provider 时不追加 hint
  const errOut = cap.out.stderr.join('\n');
  assert.match(errOut, /错误\[AUTH_FAILED\]: Invalid credentials/);
  assert.equal(cap.out.stderr.join('\n').includes('提示:'), false);
});
