/**
 * IMAP 协议层：拉取、解析、附件安全。
 * 依赖一个已连接的 imap 实例，不依赖 config.js —— 因此可以用假 imap
 * 对象做单元测试。
 */

const os = require('os');
const path = require('path');
const { simpleParser } = require('mailparser');
const { MailError, ERROR_CODES } = require('./errors');

// IMAP ID（RFC 2971）载荷 —— 163.com 会拒绝不自我介绍身份的客户端
const IMAP_ID = {
  name: 'openclaw',
  version: '0.0.1',
  vendor: 'netease',
  'support-email': 'kefu@188.com',
};

/**
 * 把 body 流收集成单个 Buffer。
 * 关键：绝不能对每个 chunk 单独 `chunk.toString('utf8')` 再拼接 ——
 * 多字节 UTF-8 字符（中文）跨 chunk 边界时会被截断成乱码。
 * 必须先攒 Buffer，最后一次性 concat + toString。
 */
function collectBody(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    stream.once('end', () => resolve(Buffer.concat(chunks)));
    stream.once('error', reject);
  });
}

/**
 * 按 UID 批量拉取邮件，返回 [{ which, bodyBuf, attributes }]。
 * 无竞态：attributes 用同一个对象引用、由 attributes 事件原地填充，
 * 因此无论该事件早于还是晚于 body 流结束，最终都能挂到消息上
 * （旧实现用 parts.forEach 挂载，attributes 先到时会静默丢失 uid）。
 */
function fetchMessages(imap, uids, fetchOptions) {
  return new Promise((resolve, reject) => {
    const fetch = imap.fetch(uids, fetchOptions);
    const pending = [];
    fetch.on('message', (msg) => {
      const attrs = {};
      let bodyPromise = null;
      msg.on('body', (stream, info) => {
        bodyPromise = collectBody(stream).then((bodyBuf) => ({ which: info.which, bodyBuf }));
      });
      msg.once('attributes', (a) => { Object.assign(attrs, a); });
      msg.once('end', () => {
        if (bodyPromise) {
          pending.push(bodyPromise.then((part) => {
            part.attributes = attrs;
            return part;
          }));
        }
      });
    });
    fetch.once('error', reject);
    fetch.once('end', () => { Promise.all(pending).then(resolve, reject); });
  });
}

// 仅执行 SEARCH，返回 UID 数组
function searchUids(imap, criteria) {
  return new Promise((resolve, reject) => {
    imap.search(criteria, (err, results) => {
      if (err) { reject(err); return; }
      resolve(results || []);
    });
  });
}

// SEARCH + FETCH 一步完成
async function searchAndFetch(imap, criteria, fetchOptions) {
  const uids = await searchUids(imap, criteria);
  if (!uids.length) return [];
  return fetchMessages(imap, uids, fetchOptions);
}

// 解析原始 RFC822 报文（Buffer 或字符串）为结构化对象
async function parseEmail(body, includeAttachments = false) {
  const src = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  const parsed = await simpleParser(src);
  return {
    messageId: parsed.messageId || undefined,
    from: parsed.from ? parsed.from.text : 'Unknown',
    to: parsed.to ? parsed.to.text : undefined,
    subject: parsed.subject || '(no subject)',
    headerDate: parsed.date, // 发件人 Date 头，可能被伪造/倒灌
    text: parsed.text,
    html: parsed.html,
    snippet: parsed.text
      ? parsed.text.slice(0, 200)
      : (parsed.html ? parsed.html.slice(0, 200).replace(/<[^>]*>/g, '') : ''),
    attachments: parsed.attachments
      ? parsed.attachments.map((a) => ({
          filename: a.filename,
          contentType: a.contentType,
          size: a.size,
          content: includeAttachments ? a.content : undefined,
          cid: a.cid,
        }))
      : undefined,
  };
}

/**
 * 附件落盘目录白名单校验。
 * allowedWriteDirs 由调用方从 config 传入，保持本模块纯净。
 * 失败抛 MailError(IO_ERROR)，与 validateReadPath 一致，便于 CLI 统一输出。
 */
function validateWritePath(dirPath, allowedWriteDirs) {
  if (!allowedWriteDirs || !allowedWriteDirs.length) {
    throw new MailError(ERROR_CODES.IO_ERROR,
      'ALLOWED_WRITE_DIRS 未配置，附件下载已禁用。请在 .env 中设置 ALLOWED_WRITE_DIRS（例如 ~/Downloads）。');
  }
  const home = os.homedir();
  const resolved = path.resolve(String(dirPath).replace(/^~/, home));
  const allowed = allowedWriteDirs.map((d) => path.resolve(String(d).replace(/^~/, home)));
  const ok = allowed.some((dir) => resolved === dir || resolved.startsWith(dir + path.sep));
  if (!ok) {
    throw new MailError(ERROR_CODES.IO_ERROR,
      `拒绝写入: '${dirPath}' 不在 ALLOWED_WRITE_DIRS 白名单内（当前白名单: ${allowed.join(', ')}）`);
  }
  return resolved;
}

module.exports = {
  IMAP_ID,
  collectBody,
  fetchMessages,
  searchUids,
  searchAndFetch,
  parseEmail,
  validateWritePath,
};
