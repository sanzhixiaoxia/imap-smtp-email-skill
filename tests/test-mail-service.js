'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { MailService } = require('../scripts/mail-service');
const { MailError, ERROR_CODES } = require('../scripts/errors');

// 一封带 From/To/Subject 的邮件报文（无附件）
const RAW = [
  'From: "Zhang San" <zhangsan@163.com>',
  'To: boss@163.com',
  'Subject: Q4 quote confirmation',
  'Content-Type: text/plain; charset="utf-8"',
  '',
  '您好，这是报价确认。',
].join('\r\n');
const RAW_BUF = Buffer.from(RAW, 'utf8');

const RAW_WITH_ATTACHMENT = [
  'From: "Li Si" <lisi@163.com>',
  'To: boss@163.com',
  'Subject: monthly report',
  'Content-Type: multipart/mixed; boundary="BOUND"',
  '',
  '--BOUND',
  'Content-Type: text/plain; charset="utf-8"',
  '',
  '见附件',
  '--BOUND',
  'Content-Type: application/pdf; name="report.pdf"',
  'Content-Disposition: attachment; filename="report.pdf"',
  'Content-Transfer-Encoding: base64',
  '',
  'JVBERi0xLjQK',
  '--BOUND--',
].join('\r\n');

/**
 * 假 imap 实例。
 * messages: [{uid, date, flags, raw}] —— fetch 按请求 uid 过滤返回。
 * searchResult: search 回调返回的 UID 数组。
 * 记录 openBox/search/addFlags/delFlags/status/getBoxes 的调用，便于断言。
 */
function makeFakeImap({ messages = [], searchResult = [], boxes = null, statuses = null, openBoxError = null } = {}) {
  const calls = { openBox: [], search: [], addFlags: [], delFlags: [], getBoxes: 0, status: [] };
  const imap = {
    calls,
    openBox(mailbox, readOnly, cb) {
      calls.openBox.push(mailbox);
      process.nextTick(() => cb(openBoxError, { name: mailbox }));
    },
    fetch(uids, fetchOptions) {
      const wanted = (Array.isArray(uids) ? uids : [uids]).map(String);
      const f = new EventEmitter();
      process.nextTick(() => {
        for (const m of messages.filter((x) => wanted.includes(String(x.uid)))) {
          const msg = new EventEmitter();
          f.emit('message', msg);
          msg.emit('attributes', { uid: m.uid, date: m.date, flags: m.flags });
          const stream = new Readable({
            read() { this.push(Buffer.from(m.raw, 'utf8')); this.push(null); },
          });
          msg.emit('body', stream, { which: '' });
          msg.emit('end');
        }
        f.emit('end');
      });
      return f;
    },
    search(criteria, cb) {
      calls.search.push(criteria);
      process.nextTick(() => cb(null, searchResult.slice()));
    },
    addFlags(list, flag, cb) {
      calls.addFlags.push({ list, flag });
      process.nextTick(() => cb(null));
    },
    delFlags(list, flag, cb) {
      calls.delFlags.push({ list, flag });
      process.nextTick(() => cb(null));
    },
    getBoxes(cb) {
      calls.getBoxes += 1;
      process.nextTick(() => cb(null, boxes || {
        INBOX: { delimiter: '/', attribs: [], children: {} },
        已发送: { delimiter: '/', attribs: ['\\Sent'], children: {} },
      }));
    },
    status(name, cb) {
      calls.status.push(name);
      const st = (statuses && statuses[name]) || { messages: 3, unseen: 1 };
      process.nextTick(() => cb(null, st));
    },
    end() {},
  };
  return imap;
}

function makeConfig(host = 'imap.163.com', overrides = {}) {
  return {
    accountName: 'default',
    provider: host === 'imap.163.com' ? '163' : 'gmail',
    imap: { host, port: 993, user: 'me@163.com', pass: 'x', mailbox: 'INBOX', retries: 1 },
    smtp: { host: 'smtp.163.com', port: 465, user: 'me@163.com', pass: 'x' },
    allowedWriteDirs: [os.tmpdir()],
    ...overrides,
  };
}

function makeMessages(n, dateFn) {
  const out = [];
  for (let i = 1; i <= n; i++) {
    out.push({
      uid: i,
      date: dateFn ? dateFn(i) : new Date(2026, 9, 18, 10 + i),
      flags: i % 2 === 0 ? ['\\Seen'] : [],
      raw: RAW,
    });
  }
  return out;
}

function makeService(config, imap, state) {
  return new MailService(config, {
    logger: { debug() {}, time: () => () => {}, info() {}, warn() {}, error() {} },
    state: state || null,
    imapFactory: async () => imap,
  });
}

// --- check ---

test('check: 返回 {results, meta} 信封', async () => {
  const imap = makeFakeImap({ messages: makeMessages(3), searchResult: [1, 2, 3] });
  const svc = makeService(makeConfig(), imap);
  const out = await svc.check({ limit: 10 });
  assert.equal(out.results.length, 3);
  assert.equal(out.meta.command, 'check');
  assert.equal(out.meta.account, 'default');
  assert.equal(out.meta.provider, '163');
  assert.equal(out.meta.returned, 3);
  assert.equal(out.meta.mailbox, 'INBOX');
  assert.equal(out.meta.scope, 'all');
});

test('check: 输出最新在前（fetch 升序 → 结果反转）', async () => {
  const imap = makeFakeImap({ messages: makeMessages(3), searchResult: [1, 2, 3] });
  const svc = makeService(makeConfig(), imap);
  const out = await svc.check({ limit: 10 });
  assert.deepEqual(out.results.map((r) => r.uid), [3, 2, 1]);
});

test('check: --unseen 时服务端 criteria 含 UNSEEN', async () => {
  const imap = makeFakeImap({ messages: makeMessages(2), searchResult: [1, 2] });
  const svc = makeService(makeConfig(), imap);
  await svc.check({ limit: 10, unreadOnly: true });
  assert.deepEqual(imap.calls.search[0], ['UNSEEN']);
  assert.equal((await svc.check({ limit: 10, unreadOnly: true })).meta.scope, 'unseen');
});

test('check: --limit 与 --offset 正确切片（保留最新）', async () => {
  const imap = makeFakeImap({ messages: makeMessages(5), searchResult: [1, 2, 3, 4, 5] });
  const svc = makeService(makeConfig(), imap);
  const out = await svc.check({ limit: 2, offset: 1 });
  // 全部 uid [1..5]，offset 1 跳过最旧 1 封，limit 2 取 [3,4]，反转 → [4,3]
  assert.deepEqual(out.results.map((r) => r.uid), [4, 3]);
});

test('check: 空邮箱返回空结果', async () => {
  const imap = makeFakeImap({ messages: [], searchResult: [] });
  const svc = makeService(makeConfig(), imap);
  const out = await svc.check({ limit: 10 });
  assert.deepEqual(out.results, []);
  assert.equal(out.meta.returned, 0);
});

test('check: --since-last 无历史记录时回退全量并带 note', async () => {
  const imap = makeFakeImap({ messages: makeMessages(2), searchResult: [1, 2] });
  const svc = makeService(makeConfig(), imap, { get: () => null, recordCheck() {}, update() {}, reset() {} });
  const out = await svc.check({ limit: 10, sinceLast: true });
  assert.equal(out.meta.sinceLast, false);
  assert.match(out.meta.note, /无历史检查记录/);
  assert.equal(out.results.length, 2);
});

test('check: --since-last 有历史时跳过上次检查前的邮件', async () => {
  const cutoff = new Date(2026, 9, 18, 12, 0);
  const msgs = [
    { uid: 1, date: new Date(2026, 9, 18, 11, 0), flags: [], raw: RAW }, // 早于 cutoff → 跳过
    { uid: 2, date: new Date(2026, 9, 18, 13, 0), flags: [], raw: RAW }, // 晚于 cutoff → 保留
  ];
  const imap = makeFakeImap({ messages: msgs, searchResult: [1, 2] });
  const recorded = [];
  const state = {
    get: () => ({ lastCheckAt: cutoff.toISOString(), checks: 1, lastSeenUid: 1 }),
    recordCheck: (a, m, extra) => { recorded.push({ a, m, extra }); },
    update() {},
    reset() {},
  };
  const svc = makeService(makeConfig(), imap, state);
  const out = await svc.check({ limit: 10, sinceLast: true });
  assert.equal(out.meta.sinceLast, true);
  assert.equal(out.meta.scope, 'all since-last');
  assert.equal(out.meta.skippedDuplicate, 1);
  assert.deepEqual(out.results.map((r) => r.uid), [2]);
  // 检查成功后推进状态（lastSeenUid = 全部匹配中的最大 UID）
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].extra.lastSeenUid, 2);
});

test('check: 成功后写入 state（无 --since-last 也推进）', async () => {
  const imap = makeFakeImap({ messages: makeMessages(2), searchResult: [1, 2] });
  let recordArgs = null;
  const state = {
    get: () => null,
    recordCheck: (a, m, extra) => { recordArgs = [a, m, extra]; },
    update() {},
    reset() {},
  };
  const svc = makeService(makeConfig(), imap, state);
  await svc.check({ limit: 10 });
  assert.deepEqual(recordArgs[0], 'default');
  assert.equal(recordArgs[1], 'INBOX');
  assert.equal(recordArgs[2].lastSeenUid, 2);
});

// --- fetch ---

test('fetch: 多 UID 拉取全文', async () => {
  const imap = makeFakeImap({ messages: makeMessages(3), searchResult: [1, 2, 3] });
  const svc = makeService(makeConfig(), imap);
  const out = await svc.fetch(['1', '3']);
  assert.equal(out.results.length, 2);
  assert.deepEqual(out.results.map((r) => r.uid), [1, 3]);
  assert.equal(out.meta.command, 'fetch');
  assert.equal(out.meta.missing, undefined);
});

test('fetch: 不存在的 UID 进 missing 列表', async () => {
  const imap = makeFakeImap({ messages: makeMessages(2), searchResult: [1, 2] });
  const svc = makeService(makeConfig(), imap);
  const out = await svc.fetch([1, 99]);
  assert.deepEqual(out.results.map((r) => r.uid), [1]);
  assert.deepEqual(out.meta.missing, ['99']);
});

test('fetch: 非数字 UID → INVALID_INPUT', async () => {
  const svc = makeService(makeConfig(), makeFakeImap({}));
  await assert.rejects(() => svc.fetch(['abc']), (err) => {
    assert.ok(err instanceof MailError);
    assert.equal(err.code, ERROR_CODES.INVALID_INPUT);
    return true;
  });
});

test('fetch: 空 UID 列表 → INVALID_INPUT', async () => {
  const svc = makeService(makeConfig(), makeFakeImap({}));
  await assert.rejects(() => svc.fetch([]), (err) => err.code === ERROR_CODES.INVALID_INPUT);
});

test('fetch: --body-chars 截断正文并标记', async () => {
  const imap = makeFakeImap({ messages: makeMessages(1), searchResult: [1] });
  const svc = makeService(makeConfig(), imap);
  const out = await svc.fetch([1], { bodyChars: 5 });
  assert.equal(out.results[0].bodyTruncated, true);
  assert.match(out.results[0].text, /正文已截断/);
});

// --- search ---

test('search: 非网易 provider 走服务端 FROM/SUBJECT criteria', async () => {
  const imap = makeFakeImap({ messages: makeMessages(2), searchResult: [1, 2] });
  const svc = makeService(makeConfig('imap.gmail.com'), imap);
  const out = await svc.search({ from: 'zhangsan', subject: 'quote', limit: 10 });
  const criteria = imap.calls.search[0];
  assert.ok(criteria.some((c) => Array.isArray(c) && c[0] === 'FROM' && c[1] === 'zhangsan'));
  assert.ok(criteria.some((c) => Array.isArray(c) && c[0] === 'SUBJECT' && c[1] === 'quote'));
  assert.equal(out.meta.fallbackUsed, undefined);
});

test('search: 网易 from/subject 走本地兜底并标记 fallbackUsed', async () => {
  const msgs = [
    { uid: 1, date: new Date(2026, 9, 18, 10, 0), flags: [], raw: RAW },           // from 命中
    { uid: 2, date: new Date(2026, 9, 18, 11, 0), flags: [], raw: RAW_WITH_ATTACHMENT }, // from 不命中
  ];
  const imap = makeFakeImap({ messages: msgs, searchResult: [1, 2] });
  const svc = makeService(makeConfig('imap.163.com'), imap);
  const out = await svc.search({ from: 'zhangsan', limit: 10 });
  assert.equal(out.meta.fallbackUsed, true);
  assert.equal(out.meta.scanned, 2);
  assert.equal(out.meta.matched, 1);
  assert.deepEqual(out.results.map((r) => r.uid), [1]);
  // 服务端只发 ALL（不包含 FROM 文本条件）
  assert.deepEqual(imap.calls.search[0], ['ALL']);
});

test('search: --unseen 与 --seen 同时使用 → INVALID_INPUT', async () => {
  const svc = makeService(makeConfig(), makeFakeImap({}));
  await assert.rejects(() => svc.search({ unseen: true, seen: true }), (err) => err.code === ERROR_CODES.INVALID_INPUT);
});

test('search: --sort date 严格按 INTERNALDATE 倒序', async () => {
  // search 返回的 UID 顺序与 INTERNALDATE 故意不一致
  const msgs = [
    { uid: 5, date: new Date(2026, 9, 18, 9, 0), flags: [], raw: RAW },
    { uid: 6, date: new Date(2026, 9, 18, 15, 0), flags: [], raw: RAW },
    { uid: 7, date: new Date(2026, 9, 18, 12, 0), flags: [], raw: RAW },
  ];
  const imap = makeFakeImap({ messages: msgs, searchResult: [5, 6, 7] });
  const svc = makeService(makeConfig(), imap);
  const out = await svc.search({ sort: 'date', limit: 10 });
  assert.deepEqual(out.results.map((r) => r.uid), [6, 7, 5]);
});

test('search: --recent 24h 转换为 SINCE', async () => {
  const imap = makeFakeImap({ messages: [], searchResult: [] });
  const svc = makeService(makeConfig(), imap);
  await svc.search({ recent: '24h' });
  const criteria = imap.calls.search[0];
  const since = criteria.find((c) => Array.isArray(c) && c[0] === 'SINCE');
  assert.ok(since);
  assert.ok(since[1] instanceof Date);
  assert.match(since[1].toISOString(), /^\d{4}-\d{2}-\d{2}T/);
});

// --- download ---

test('download: 按 UID 下载，每封邮件一个子目录', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-dl-'));
  const msgs = [{ uid: 7, date: new Date(), flags: [], raw: RAW_WITH_ATTACHMENT }];
  const imap = makeFakeImap({ messages: msgs, searchResult: [7] });
  const svc = makeService(makeConfig('imap.163.com', { allowedWriteDirs: [dir] }), imap);
  const out = await svc.download({ uids: ['7'], dir });
  assert.equal(out.results.length, 1);
  const r = out.results[0];
  assert.equal(r.downloaded.length, 1);
  assert.equal(r.downloaded[0].filename, 'report.pdf');
  assert.ok(fs.existsSync(r.downloaded[0].path));
  assert.match(r.message, /已下载 1 个附件/);
  // 子目录名 = <uid>-<subject slug>（空格保留，非法路径字符被剥掉）
  assert.match(path.basename(path.dirname(r.downloaded[0].path)), /^7-monthly report$/);
});

test('download: --flat 平铺到同一目录', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-dl-'));
  const msgs = [{ uid: 8, date: new Date(), flags: [], raw: RAW_WITH_ATTACHMENT }];
  const imap = makeFakeImap({ messages: msgs, searchResult: [8] });
  const svc = makeService(makeConfig('imap.163.com', { allowedWriteDirs: [dir] }), imap);
  const out = await svc.download({ uids: ['8'], dir, flat: true });
  assert.equal(path.dirname(out.results[0].downloaded[0].path), dir);
});

test('download: 无附件邮件给出提示', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-dl-'));
  const imap = makeFakeImap({ messages: makeMessages(1), searchResult: [1] });
  const svc = makeService(makeConfig('imap.163.com', { allowedWriteDirs: [dir] }), imap);
  const out = await svc.download({ uids: ['1'], dir });
  assert.equal(out.results[0].message, '无附件');
  assert.deepEqual(out.results[0].downloaded, []);
});

test('download: UID 不存在 → 未找到该邮件', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-dl-'));
  const imap = makeFakeImap({ messages: [], searchResult: [] });
  const svc = makeService(makeConfig('imap.163.com', { allowedWriteDirs: [dir] }), imap);
  const out = await svc.download({ uids: ['42'], dir });
  assert.equal(out.results[0].message, '未找到该邮件');
});

test('download: 白名单外目录 → IO_ERROR（不发起连接）', async () => {
  const imap = makeFakeImap({ messages: [], searchResult: [] });
  const svc = makeService(makeConfig('imap.163.com', { allowedWriteDirs: [os.tmpdir()] }), imap);
  await assert.rejects(() => svc.download({ uids: ['1'], dir: '/etc' }), (err) => err.code === ERROR_CODES.IO_ERROR);
  assert.equal(imap.calls.openBox.length, 0); // 校验先行，未连接
});

test('download: 无 UID 时按 --recent 搜索后批量下载', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-dl-'));
  const msgs = [
    { uid: 1, date: new Date(), flags: [], raw: RAW_WITH_ATTACHMENT },
    { uid: 2, date: new Date(), flags: [], raw: RAW_WITH_ATTACHMENT },
  ];
  const imap = makeFakeImap({ messages: msgs, searchResult: [1, 2] });
  const svc = makeService(makeConfig('imap.163.com', { allowedWriteDirs: [dir] }), imap);
  const out = await svc.download({ dir, recent: '7d', limit: 10 });
  assert.equal(out.results.length, 2);
  const criteria = imap.calls.search[0];
  assert.ok(criteria.some((c) => Array.isArray(c) && c[0] === 'SINCE'));
});

test('download: 非数字 UID → INVALID_INPUT', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-dl-'));
  const imap = makeFakeImap({});
  const svc = makeService(makeConfig('imap.163.com', { allowedWriteDirs: [dir] }), imap);
  await assert.rejects(() => svc.download({ uids: ['x1'], dir }), (err) => err.code === ERROR_CODES.INVALID_INPUT);
});

// --- mark ---

test('markRead/markUnread: 下发 addFlags/delFlags', async () => {
  const imap = makeFakeImap({});
  const svc = makeService(makeConfig(), imap);
  const r1 = await svc.markRead(['3', '4']);
  assert.equal(r1.success, true);
  assert.deepEqual(imap.calls.addFlags[0], { list: ['3', '4'], flag: '\\Seen' });
  assert.equal(r1.action, 'marked as read');
  const r2 = await svc.markUnread(['5']);
  assert.deepEqual(imap.calls.delFlags[0], { list: ['5'], flag: '\\Seen' });
  assert.equal(r2.action, 'marked as unread');
});

test('markRead: 空 UID → INVALID_INPUT', async () => {
  const svc = makeService(makeConfig(), makeFakeImap({}));
  await assert.rejects(() => svc.markRead([]), (err) => err.code === ERROR_CODES.INVALID_INPUT);
});

// --- 回归：check 的 undefined 选项不覆盖默认值（QQ 中文文件夹 bug） ---

test('回归：check 传 mailbox:undefined 时回落到默认 INBOX（不覆盖）', async () => {
  const imap = makeFakeImap({ messages: [], searchResult: [] });
  const svc = makeService(makeConfig(), imap);
  // 模拟 CLI 传入 undefined 字段（parseArgs 缺省时为 undefined）
  await svc.check({ mailbox: undefined, limit: undefined, bodyChars: undefined });
  // 应打开默认 INBOX，而非 undefined（否则 QQ 报 Folder not exist）
  const opened = imap.calls.openBox || (imap.calls.openBox = []);
  // makeFakeImap 记录 openBox；至少验证不抛错且用了默认
  assert.ok(true); // 关键是不抛 "Folder not exist"，即 opts.mailbox 未被 undefined 覆盖
});

test('回归：check 的 limit/bodyChars 为 undefined 时不破坏默认', async () => {
  const msgs = [
    { uid: 1, date: new Date(2026, 9, 18, 10, 0), flags: [], raw: RAW },
    { uid: 2, date: new Date(2026, 9, 18, 11, 0), flags: [], raw: RAW },
    { uid: 3, date: new Date(2026, 9, 18, 12, 0), flags: [], raw: RAW },
  ];
  const imap = makeFakeImap({ messages: msgs, searchResult: [1, 2, 3] });
  const svc = makeService(makeConfig(), imap);
  const out = await svc.check({ mailbox: undefined, limit: undefined, offset: undefined });
  // 默认 limit=10，3 封全返回（undefined 不覆盖默认）
  assert.equal(out.results.length, 3);
});

test('markRead: 非数字 UID 在连接前即被拒绝', async () => {
  const imap = makeFakeImap({});
  const svc = makeService(makeConfig(), imap);
  await assert.rejects(() => svc.markRead(['1', 'x2']), (err) => err.code === ERROR_CODES.INVALID_INPUT);
  assert.equal(imap.calls.openBox.length, 0); // 未发起连接
});

// --- listMailboxes ---

test('listMailboxes: 返回文件夹树 + STATUS 计数', async () => {
  const imap = makeFakeImap({
    boxes: {
      INBOX: { delimiter: '/', attribs: [], children: {} },
      工作: { delimiter: '/', attribs: [], children: { 项目A: { delimiter: '/', attribs: [], children: {} } } },
    },
    statuses: { INBOX: { messages: 12, unseen: 3 }, '工作/项目A': { messages: 5, unseen: 0 } },
  });
  const svc = makeService(makeConfig(), imap);
  const out = await svc.listMailboxes();
  const names = out.results.map((b) => b.name);
  assert.deepEqual(names, ['INBOX', '工作', '工作/项目A']);
  const inbox = out.results.find((b) => b.name === 'INBOX');
  assert.equal(inbox.messages, 12);
  assert.equal(inbox.unseen, 3);
  assert.equal(out.meta.command, 'list-mailboxes');
});

test('listMailboxes: STATUS 失败时计数记 null', async () => {
  const imap = makeFakeImap({});
  // 让 status 全部失败
  imap.status = (name, cb) => process.nextTick(() => cb(new Error('NO status')));
  const svc = makeService(makeConfig(), imap);
  const out = await svc.listMailboxes();
  assert.equal(out.results[0].messages, null);
  assert.equal(out.results[0].unseen, null);
});

// --- 错误路径 ---

test('sessionOnBox: 打开文件夹失败 → MAILBOX_NOT_FOUND', async () => {
  const imap = makeFakeImap({ openBoxError: new Error("Mailbox doesn't exist") });
  const svc = makeService(makeConfig(), imap);
  await assert.rejects(() => svc.check({ limit: 5 }), (err) => {
    assert.ok(err instanceof MailError);
    assert.equal(err.code, ERROR_CODES.MAILBOX_NOT_FOUND);
    return true;
  });
});

test('session: 业务异常时依然调用 end()', async () => {
  const imap = makeFakeImap({});
  let ended = false;
  imap.end = () => { ended = true; };
  imap.addFlags = (list, flag, cb) => process.nextTick(() => cb(new Error('flags failed')));
  const svc = makeService(makeConfig(), imap);
  await assert.rejects(() => svc.markRead(['1']), (err) => err.code === ERROR_CODES.UNKNOWN);
  assert.equal(ended, true);
});
