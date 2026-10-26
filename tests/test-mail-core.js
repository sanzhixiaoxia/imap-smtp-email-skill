'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const {
  fetchMessages, searchAndFetch, parseEmail, validateWritePath, collectBody,
} = require('../scripts/mail-core');

// 一封完整的中文邮件报文（UTF-8）
const RAW_EMAIL = [
  'From: "Zhang San" <zhangsan@163.com>',
  'To: boss@163.com',
  'Subject: Q4 quote confirmation',
  'Content-Type: text/plain; charset="utf-8"',
  '',
  '您好，这是秋季报价确认。金额：¥12,800。请在周五前回复。',
].join('\r\n');

// 在「秋」的第 2 个字节处切开，模拟多字节字符跨 chunk 的边界
const RAW_BUF = Buffer.from(RAW_EMAIL, 'utf8');
const SPLIT_AT = RAW_BUF.indexOf(Buffer.from('秋', 'utf8')) + 1;

/**
 * 构造一个假 imap 对象。
 * order 控制 attributes / body / end 三个事件的触发顺序，
 * 用于复现旧实现的竞态（attributes 早于 body 流结束）。
 */
function makeFakeImap(messages, searchResult = []) {
  return {
    fetch(uids, fetchOptions) {
      const f = new EventEmitter();
      process.nextTick(() => {
        for (const m of messages) {
          const msg = new EventEmitter();
          // 先 emit 'message'（fetchMessages 会同步挂上 msg 的监听），
          // 再按 order 触发 attributes / body / end —— 与真实 imap 库一致
          f.emit('message', msg);
          for (const ev of (m.order || ['attributes', 'body', 'end'])) {
            if (ev === 'attributes') {
              msg.emit('attributes', { uid: m.uid, date: m.date, flags: m.flags });
            } else if (ev === 'body') {
              const chunks = m.chunks;
              let i = 0;
              const stream = new Readable({
                read() {
                  if (i < chunks.length) this.push(chunks[i++]);
                  else this.push(null);
                },
              });
              msg.emit('body', stream, { which: '' });
            } else if (ev === 'end') {
              msg.emit('end');
            }
          }
        }
        f.emit('end');
      });
      return f;
    },
    search(criteria, cb) {
      process.nextTick(() => cb(null, searchResult.slice()));
    },
  };
}

function makeMsg(uid, order) {
  return {
    uid,
    date: new Date(2026, 9, 18, 14, 2),
    flags: ['\\Seen'],
    chunks: [RAW_BUF.slice(0, SPLIT_AT), RAW_BUF.slice(SPLIT_AT)],
    order: order || ['attributes', 'body', 'end'],
  };
}

test('fetchMessages: attributes 先于 body 结束时 uid 依然挂载（修复竞态）', async () => {
  const imap = makeFakeImap([makeMsg(42, ['attributes', 'body', 'end'])]);
  const out = await fetchMessages(imap, [42], { bodies: [''], markSeen: false });
  assert.equal(out.length, 1);
  assert.equal(out[0].attributes.uid, 42);
  assert.deepEqual(out[0].attributes.flags, ['\\Seen']);
});

test('fetchMessages: attributes 晚于 body 也正确挂载', async () => {
  const imap = makeFakeImap([makeMsg(43, ['body', 'attributes', 'end'])]);
  const out = await fetchMessages(imap, [43], { bodies: [''], markSeen: false });
  assert.equal(out.length, 1);
  assert.equal(out[0].attributes.uid, 43);
});

test('fetchMessages: UTF-8 多字节字符跨 chunk 不被截断（修复中文乱码）', async () => {
  const imap = makeFakeImap([makeMsg(44)]);
  const out = await fetchMessages(imap, [44], { bodies: [''], markSeen: false });
  assert.equal(out.length, 1);
  const parsed = await parseEmail(out[0].bodyBuf);
  assert.equal(parsed.subject, 'Q4 quote confirmation');
  assert.match(parsed.from, /zhangsan@163\.com/);
  assert.match(parsed.text, /您好，这是秋季报价确认。/);
  assert.match(parsed.text, /¥12,800/);
  // 不应出现替换字符（乱码标志）
  assert.ok(!parsed.text.includes('\uFFFD'), '文本中出现 U+FFFD 替换字符');
});

test('fetchMessages: 多封邮件全部返回', async () => {
  const imap = makeFakeImap([makeMsg(1), makeMsg(2), makeMsg(3)]);
  const out = await fetchMessages(imap, [1, 2, 3], { bodies: [''], markSeen: false });
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((m) => m.attributes.uid).sort(), [1, 2, 3]);
});

test('searchAndFetch: 先 SEARCH 再 FETCH', async () => {
  const imap = makeFakeImap([makeMsg(7), makeMsg(8)], [7, 8]);
  const out = await searchAndFetch(imap, ['ALL'], { bodies: [''], markSeen: false });
  assert.equal(out.length, 2);
});

test('searchAndFetch: 无匹配时返回空数组', async () => {
  const imap = makeFakeImap([], []);
  const out = await searchAndFetch(imap, ['ALL'], { bodies: [''], markSeen: false });
  assert.deepEqual(out, []);
});

test('parseEmail: 接受字符串输入（向后兼容）', async () => {
  const parsed = await parseEmail(RAW_EMAIL);
  assert.equal(parsed.subject, 'Q4 quote confirmation');
  assert.match(parsed.text, /秋季报价确认/);
  // mailparser 对无附件邮件给出空数组（与原实现一致）
  assert.deepEqual(parsed.attachments, []);
});

test('parseEmail: 附件元信息默认不带 content', async () => {
  const withAtt = [
    'From: a@163.com',
    'To: b@163.com',
    'Subject: with attachment',
    'Content-Type: multipart/mixed; boundary="BOUND"',
    '',
    '--BOUND',
    'Content-Type: text/plain; charset="utf-8"',
    '',
    '见附件',
    '--BOUND',
    'Content-Type: application/pdf; name="quote.pdf"',
    'Content-Disposition: attachment; filename="quote.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    'JVBERi0xLjQK',
    '--BOUND--',
  ].join('\r\n');
  const parsed = await parseEmail(withAtt);
  assert.equal(parsed.attachments.length, 1);
  assert.equal(parsed.attachments[0].filename, 'quote.pdf');
  assert.equal(parsed.attachments[0].content, undefined);
  const parsedWithContent = await parseEmail(withAtt, true);
  assert.ok(Buffer.isBuffer(parsedWithContent.attachments[0].content));
});

test('collectBody: 分块 Buffer 拼回原内容', async () => {
  const chunks = [RAW_BUF.slice(0, SPLIT_AT), RAW_BUF.slice(SPLIT_AT)];
  let i = 0;
  const stream = new Readable({
    read() {
      if (i < chunks.length) this.push(chunks[i++]);
      else this.push(null);
    },
  });
  const buf = await collectBody(stream);
  assert.ok(Buffer.isBuffer(buf));
  assert.equal(buf.toString('utf8'), RAW_EMAIL);
});

test('validateWritePath: 白名单内通过、名单外拒绝', () => {
  assert.equal(validateWritePath('/tmp/mail-out', ['/tmp']), '/tmp/mail-out');
  assert.throws(() => validateWritePath('/etc', ['/tmp']), /拒绝写入/);
  // 同名前缀目录不算白名单内（/tmp-evil 不在 /tmp 内）
  assert.throws(() => validateWritePath('/tmp-evil/x', ['/tmp']), /拒绝写入/);
});

test('validateWritePath: 空白名单禁用下载', () => {
  assert.throws(() => validateWritePath('/tmp/x', []), /ALLOWED_WRITE_DIRS/);
  assert.throws(() => validateWritePath('/tmp/x', undefined), /ALLOWED_WRITE_DIRS/);
});

test('validateWritePath: ~ 展开到家目录', () => {
  const home = os.homedir();
  assert.equal(validateWritePath('~/mail-out', [home]), path.join(home, 'mail-out'));
  assert.throws(() => validateWritePath('~/mail-out', ['/nonexistent-xyz']), /拒绝写入/);
});
