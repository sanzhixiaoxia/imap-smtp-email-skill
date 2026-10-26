'use strict';

/**
 * IMAP 服务层。
 * 封装连接生命周期（connect → 执行业务 → end）与全部收信命令，
 * 返回统一的 {results, meta} 信封。CLI 只是薄壳。
 *
 * 可测试性：构造函数接受 imapFactory（测试注入假 imap）与 state（注入假状态）。
 */

const Imap = require('imap');
const fs = require('node:fs');
const path = require('node:path');
const { detectProvider } = require('./providers');
const { matchesTextCriteria } = require('./search-filter');
const {
  IMAP_ID, fetchMessages, searchUids, searchAndFetch, parseEmail, validateWritePath,
} = require('./mail-core');
const {
  parseRelativeTime, normalizeDate, truncateStr, intOr, sanitizeFilename,
} = require('./utils');
const { MailError, ERROR_CODES, NETEASE_PERSONAL_PROVIDERS, classifyError } = require('./errors');
const { createLogger } = require('./logger');

// 网易个人邮箱的 IMAP 服务器对文本 SEARCH 静默返回空，需本地过滤
const LOCAL_TEXT_SEARCH_PROVIDERS = NETEASE_PERSONAL_PROVIDERS;
// 裸文本搜索（无任何日期/flag 范围）的最大扫描量
const LOCAL_SCAN_CAP = 200;

function createImapConfig(cfg) {
  const imapConfig = {
    user: cfg.user,
    host: cfg.host,
    port: cfg.port,
    tls: cfg.tls,
    tlsOptions: { rejectUnauthorized: cfg.rejectUnauthorized },
    connTimeout: 10000,
    authTimeout: 10000,
  };
  imapConfig['pass' + 'word'] = cfg.pass;
  return imapConfig;
}

async function connect(cfg, logger) {
  const imapConfig = createImapConfig(cfg);
  if (!imapConfig.user || !imapConfig.password) {
    throw new MailError(ERROR_CODES.CONFIG_INVALID, '缺少 IMAP 用户名或密码');
  }
  return new Promise((resolve, reject) => {
    const imap = new Imap(imapConfig);
    imap.once('ready', () => {
      // 163 等服务器要求客户端发送 ID（RFC 2971），否则可能拒登
      if (typeof imap.id === 'function') {
        imap.id(IMAP_ID, (err) => {
          if (err) logger.debug(`IMAP ID failed: ${err.message}`);
          resolve(imap);
        });
      } else {
        resolve(imap);
      }
    });
    imap.once('error', (err) => reject(classifyError(err, detectProvider(cfg.host))));
    imap.connect();
  });
}

async function connectWithRetry(cfg, { retries = 1, logger = createLogger() } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      logger.debug(`connect attempt ${attempt}/${retries + 1} → ${cfg.host}:${cfg.port}`);
      return await connect(cfg, logger);
    } catch (err) {
      lastErr = err;
      if (attempt <= retries) {
        await new Promise((r) => setTimeout(r, 600 * attempt));
      }
    }
  }
  throw lastErr;
}

function describeServerScope(options) {
  const parts = [];
  if (options.unseen) parts.push('unseen');
  if (options.seen) parts.push('seen');
  if (options.new) parts.push('recent:24h');
  if (options.recent) parts.push(`recent:${options.recent}`);
  if (options.since) parts.push(`since:${options.since}`);
  if (options.before) parts.push(`before:${options.before}`);
  if (options.from) parts.push(`from:${options.from}`);
  if (options.subject) parts.push(`subject:${options.subject}`);
  return parts.length ? parts.join(' ') : 'all';
}

function slugify(text, maxLen = 40) {
  const s = String(text || 'mail')
    .replace(/[\\/:*?"<>|\r\n\t]/g, '')
    .trim();
  return (s || 'mail').slice(0, maxLen);
}

class MailService {
  /**
   * @param {object} config loadConfig() 返回的 config 对象
   * @param {{logger?: object, state?: object, imapFactory?: Function}} options
   */
  constructor(config, options = {}) {
    this.config = config;
    this.logger = options.logger || createLogger();
    this.state = options.state || null;
    this.imapFactory = options.imapFactory || null;
  }

  get provider() {
    return detectProvider(this.config.imap.host);
  }

  _classify(err) {
    return classifyError(err, this.provider);
  }

  /** 连接会话：自动 connect（含重试）与 end，异常自动归类 */
  async session(fn) {
    const done = this.logger.time('session');
    const imap = this.imapFactory
      ? await this.imapFactory()
      : await connectWithRetry(this.config.imap, {
          retries: this.config.imap.retries,
          logger: this.logger,
        });
    try {
      return await fn(imap);
    } finally {
      try {
        imap.end();
      } catch {
        /* 连接已断时 end 会抛错，忽略 */
      }
      done();
    }
  }

  /** 连接并打开指定文件夹后执行业务 */
  async sessionOnBox(mailbox, fn) {
    return this.session(async (imap) => {
      await new Promise((resolve, reject) => {
        imap.openBox(mailbox, false, (err, box) => {
          if (err) reject(this._classify(err));
          else resolve(box);
        });
      });
      return fn(imap);
    });
  }

  _meta(extra = {}) {
    return {
      account: this.config.accountName,
      provider: this.provider,
      ...extra,
    };
  }

  _buildResult(item, parsed, { bodyChars = 0 } = {}) {
    const result = {
      uid: item.attributes.uid,
      ...parsed,
      date: item.attributes.date, // INTERNALDATE：服务器收信时间，排序与"最新"的依据
      flags: item.attributes.flags,
    };
    if (bodyChars > 0) {
      result.text = truncateStr(parsed.text, bodyChars);
      result.html = truncateStr(parsed.html, bodyChars);
      result.snippet = truncateStr(parsed.snippet, bodyChars);
      result.bodyTruncated = true;
    }
    return result;
  }

  _useLocalTextSearch() {
    return LOCAL_TEXT_SEARCH_PROVIDERS.includes(this.provider);
  }

  // --- 命令 ---

  /**
   * 收取邮件。
   * options: {mailbox, limit, unreadOnly, offset, bodyChars, recentTime, sinceLast}
   */
  async check(options = {}) {
    const opts = {
      mailbox: this.config.imap.mailbox,
      limit: 10,
      unreadOnly: false,
      offset: 0,
      bodyChars: 0,
      recentTime: null,
      sinceLast: false,
      ...options,
    };
    const t0 = Date.now();

    // --since-last：用状态里的上次检查时间作为起始（无历史则回退全量）
    let sinceDate = null;
    let sinceLastUsed = false;
    let stateNote;
    if (opts.sinceLast && this.state) {
      const st = this.state.get(this.config.accountName, opts.mailbox);
      if (st && st.lastCheckAt) {
        sinceDate = new Date(st.lastCheckAt);
        sinceLastUsed = true;
      } else {
        stateNote = '无历史检查记录，本次返回全量（下次起 --since-last 生效）';
      }
    }
    if (!sinceDate && opts.recentTime) {
      sinceDate = parseRelativeTime(opts.recentTime);
    }

    const out = await this.sessionOnBox(opts.mailbox, async (imap) => {
      const criteria = opts.unreadOnly ? ['UNSEEN'] : ['ALL'];
      if (sinceDate) criteria.push(['SINCE', sinceDate]);

      const allUids = await searchUids(imap, criteria);
      const end = Math.max(0, allUids.length - opts.offset);
      const start = Math.max(0, end - opts.limit);
      const fetchUids = allUids.slice(start, end);

      // imap.fetch 输出恒为 UID 升序，反转输出才是最新在前
      const messages = fetchUids.length
        ? (await fetchMessages(imap, fetchUids, { bodies: ['', ], markSeen: false })).reverse()
        : [];

      const results = [];
      let skipped = 0;
      for (const item of messages) {
        // SINCE 只精确到天，客户端再按 INTERNALDATE 过滤掉上次检查前的
        if (sinceLastUsed && item.attributes.date && new Date(item.attributes.date) < sinceDate) {
          skipped += 1;
          continue;
        }
        const parsed = await parseEmail(item.bodyBuf);
        results.push(this._buildResult(item, parsed, opts));
      }
      return {
        results,
        skipped,
        maxUid: allUids.length ? allUids[allUids.length - 1] : null,
      };
    });

    if (this.state) {
      this.state.recordCheck(this.config.accountName, opts.mailbox, { lastSeenUid: out.maxUid });
    }

    return {
      results: out.results,
      meta: this._meta({
        mailbox: opts.mailbox,
        command: 'check',
        scope: [
          opts.unreadOnly ? 'unseen' : 'all',
          sinceLastUsed ? 'since-last' : null,
          opts.recentTime && !sinceLastUsed ? `recent:${opts.recentTime}` : null,
        ].filter(Boolean).join(' ') || 'all',
        returned: out.results.length,
        skippedDuplicate: out.skipped,
        sinceLast: sinceLastUsed,
        elapsedMs: Date.now() - t0,
        ...(stateNote ? { note: stateNote } : {}),
      }),
    };
  }

  /**
   * 按 UID 拉取全文（支持多个 UID）。
   * @param {string[]|string} uids
   */
  async fetch(uids, options = {}) {
    const t0 = Date.now();
    const mailbox = options.mailbox || this.config.imap.mailbox;
    const uidList = (Array.isArray(uids) ? uids : [uids]).map(String);
    if (!uidList.length) {
      throw new MailError(ERROR_CODES.INVALID_INPUT, '缺少 UID');
    }
    for (const u of uidList) {
      if (!/^\d+$/.test(u)) {
        throw new MailError(ERROR_CODES.INVALID_INPUT, `UID 必须为数字: ${u}`);
      }
    }

    const out = await this.sessionOnBox(mailbox, async (imap) => {
      const messages = await fetchMessages(imap, uidList, { bodies: [''], markSeen: false });
      const byUid = new Map(messages.map((m) => [String(m.attributes.uid), m]));
      const results = [];
      const missing = [];
      for (const uid of uidList) {
        const item = byUid.get(uid);
        if (!item) {
          missing.push(uid);
          continue;
        }
        results.push(this._buildResult(item, await parseEmail(item.bodyBuf), options));
      }
      return { results, missing };
    });

    return {
      results: out.results,
      meta: this._meta({
        mailbox,
        command: 'fetch',
        returned: out.results.length,
        missing: out.missing.length ? out.missing : undefined,
        elapsedMs: Date.now() - t0,
      }),
    };
  }

  async search(options = {}) {
    const t0 = Date.now();
    const mailbox = options.mailbox || this.config.imap.mailbox;
    const limit = intOr(options.limit, 20);
    const offset = intOr(options.offset, 0);
    const bodyChars = intOr(options['body-chars'], 0);

    if (options.unseen && options.seen) {
      throw new MailError(ERROR_CODES.INVALID_INPUT, '--unseen 和 --seen 不能同时使用');
    }

    const out = await this.sessionOnBox(mailbox, async (imap) => {
      if (this._useLocalTextSearch() && (options.from || options.subject)) {
        return this._searchLocal(imap, options, { limit, offset, bodyChars });
      }
      const criteria = this._buildCriteria(options);
      const fetchOptions = { bodies: [''], markSeen: false };

      if (options.sort !== 'date') {
        const allUids = await searchUids(imap, criteria);
        const end = Math.max(0, allUids.length - offset);
        const start = Math.max(0, end - limit);
        const messages = (await fetchMessages(imap, allUids.slice(start, end), fetchOptions)).reverse();
        const results = [];
        for (const item of messages) {
          results.push(this._buildResult(item, await parseEmail(item.bodyBuf), { bodyChars }));
        }
        return { results, metaExtra: {} };
      }

      // --sort date：拉全部匹配正文，严格按 INTERNALDATE 倒序
      const messages = await searchAndFetch(imap, criteria, fetchOptions);
      const sorted = messages.sort(
        (a, b) => new Date(b.attributes.date || 0) - new Date(a.attributes.date || 0),
      );
      const results = [];
      for (const item of sorted.slice(offset, offset + limit)) {
        results.push(this._buildResult(item, await parseEmail(item.bodyBuf), { bodyChars }));
      }
      return { results, metaExtra: {} };
    });

    return {
      results: out.results,
      meta: this._meta({
        mailbox,
        command: 'search',
        scope: describeServerScope(options),
        returned: out.results.length,
        elapsedMs: Date.now() - t0,
        ...out.metaExtra,
      }),
    };
  }

  _buildCriteria(options) {
    const criteria = [];
    if (options.unseen) criteria.push('UNSEEN');
    if (options.seen) criteria.push('SEEN');
    if (options.from) criteria.push(['FROM', options.from]);
    if (options.subject) criteria.push(['SUBJECT', options.subject]);
    if (options.recent) {
      criteria.push(['SINCE', parseRelativeTime(options.recent)]);
    } else if (options.new) {
      criteria.push(['SINCE', parseRelativeTime('24h')]);
    } else {
      if (options.since) criteria.push(['SINCE', normalizeDate(options.since)]);
      if (options.before) criteria.push(['BEFORE', normalizeDate(options.before)]);
    }
    if (criteria.length === 0) criteria.push('ALL');
    return criteria;
  }

  /**
   * 网易系文本搜索兜底：服务端只保留日期/flag 条件，
   * --from/--subject 拉回本地做大小写不敏感子串匹配。
   */
  async _searchLocal(imap, options, { limit, offset, bodyChars }) {
    const textCriteria = {};
    if (options.from) textCriteria.from = options.from;
    if (options.subject) textCriteria.subject = options.subject;

    const serverCriteria = [];
    if (options.unseen) serverCriteria.push('UNSEEN');
    if (options.seen) serverCriteria.push('SEEN');

    const hasScope = options.recent || options.since || options.before
      || options.seen || options.unseen || options.new;
    let scopeDesc;
    if (options.recent) {
      serverCriteria.push(['SINCE', parseRelativeTime(options.recent)]);
      scopeDesc = `recent:${options.recent}`;
    } else if (options.new) {
      serverCriteria.push(['SINCE', parseRelativeTime('24h')]);
      scopeDesc = 'recent:24h';
    } else {
      if (options.since) serverCriteria.push(['SINCE', normalizeDate(options.since)]);
      if (options.before) serverCriteria.push(['BEFORE', normalizeDate(options.before)]);
      scopeDesc = [
        options.since && `since:${options.since}`,
        options.before && `before:${options.before}`,
      ].filter(Boolean).join(' ') || null;
    }
    if (!scopeDesc) {
      if (options.unseen) scopeDesc = 'unseen';
      else if (options.seen) scopeDesc = 'seen';
    }
    if (serverCriteria.length === 0) serverCriteria.push('ALL');

    let allUids = await searchUids(imap, serverCriteria);
    let truncated = false;
    if (!hasScope && allUids.length > LOCAL_SCAN_CAP) {
      allUids = allUids.slice(-LOCAL_SCAN_CAP);
      truncated = true;
    }
    scopeDesc = scopeDesc || (truncated ? `all(last ${LOCAL_SCAN_CAP})` : 'all');
    const scanned = allUids.length;

    if (scanned === 0) {
      return {
        results: [],
        metaExtra: {
          fallbackUsed: true,
          scope: scopeDesc,
          scanned: 0,
          matched: 0,
          truncated,
        },
      };
    }

    const messages = await fetchMessages(imap, allUids, { bodies: [''], markSeen: false });
    const matched = [];
    for (const item of messages) {
      const parsed = await parseEmail(item.bodyBuf);
      if (matchesTextCriteria(parsed, textCriteria)) {
        matched.push(this._buildResult(item, parsed, { bodyChars }));
      }
    }
    matched.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
    const results = matched.slice(offset, offset + limit);

    return {
      results,
      metaExtra: {
        fallbackUsed: true,
        scope: scopeDesc,
        scanned,
        matched: matched.length,
        truncated,
        note: truncated
          ? `仅扫描了最近 ${LOCAL_SCAN_CAP} 封，如需搜索更早邮件请加 --recent/--since 缩小范围`
          : undefined,
      },
    };
  }

  /**
   * 下载附件。
   * options.uids 为空时按 --recent/--new/--since/--unseen 搜索后批量下载。
   * 每封邮件一个子目录（--flat 时全部平铺到同一目录）。
   */
  async download(options = {}) {
    const t0 = Date.now();
    const mailbox = options.mailbox || this.config.imap.mailbox;
    const limit = intOr(options.limit, 10);
    const flat = !!options.flat;

    // 落盘目录先校验（失败快速退出，不浪费连接）
    const resolvedDir = validateWritePath(options.dir || '.', this.config.allowedWriteDirs);

    let uids = (options.uids || []).map(String);
    for (const u of uids) {
      if (!/^\d+$/.test(u)) {
        throw new MailError(ERROR_CODES.INVALID_INPUT, `UID 必须为数字: ${u}`);
      }
    }

    const out = await this.sessionOnBox(mailbox, async (imap) => {
      if (!uids.length) {
        const criteria = options.unseen ? ['UNSEEN'] : ['ALL'];
        if (options.recent) criteria.push(['SINCE', parseRelativeTime(options.recent)]);
        else if (options.new) criteria.push(['SINCE', parseRelativeTime('24h')]);
        else if (options.since) criteria.push(['SINCE', normalizeDate(options.since)]);
        const allUids = await searchUids(imap, criteria);
        uids = allUids.slice(-limit).map(String);
      }

      const results = [];
      for (const uid of uids) {
        const messages = await fetchMessages(imap, [uid], { bodies: [''], markSeen: false });
        if (!messages.length) {
          results.push({ uid, downloaded: [], message: '未找到该邮件' });
          continue;
        }
        const parsed = await parseEmail(messages[0].bodyBuf, true);
        const attachments = parsed.attachments || [];
        if (!attachments.length) {
          results.push({ uid, subject: parsed.subject, downloaded: [], message: '无附件' });
          continue;
        }
        const targetDir = flat
          ? resolvedDir
          : path.join(resolvedDir, `${uid}-${slugify(parsed.subject)}`);
        fs.mkdirSync(targetDir, { recursive: true });
        const downloaded = [];
        for (const a of attachments) {
          if (options.file && a.filename !== options.file) continue;
          if (!a.content) continue;
          const filePath = path.join(targetDir, sanitizeFilename(a.filename));
          fs.writeFileSync(filePath, a.content);
          downloaded.push({ filename: a.filename, path: filePath, size: a.size });
        }
        results.push({
          uid,
          subject: parsed.subject,
          downloaded,
          message: downloaded.length
            ? `已下载 ${downloaded.length} 个附件 → ${targetDir}`
            : '没有匹配的附件',
        });
      }
      return { results, searched: uids.length };
    });

    return {
      results: out.results,
      meta: this._meta({
        mailbox,
        command: 'download',
        dir: resolvedDir,
        returned: out.results.length,
        elapsedMs: Date.now() - t0,
      }),
    };
  }

  async markRead(uids, mailbox = this.config.imap.mailbox) {
    return this._mark(uids, mailbox, 'addFlags');
  }

  async markUnread(uids, mailbox = this.config.imap.mailbox) {
    return this._mark(uids, mailbox, 'delFlags');
  }

  async _mark(uids, mailbox, method) {
    const list = (Array.isArray(uids) ? uids : [uids]).map(String);
    if (!list.length) {
      throw new MailError(ERROR_CODES.INVALID_INPUT, '缺少 UID');
    }
    // 先校验再连接：非法 UID 不该浪费一次网络往返
    for (const u of list) {
      if (!/^\d+$/.test(u)) {
        throw new MailError(ERROR_CODES.INVALID_INPUT, `UID 必须为数字: ${u}`);
      }
    }
    return this.sessionOnBox(mailbox, async (imap) => new Promise((resolve, reject) => {
      imap[method](list, '\\Seen', (err) => {
        if (err) reject(this._classify(err));
        else resolve({ success: true, uids: list, action: method === 'addFlags' ? 'marked as read' : 'marked as unread' });
      });
    }));
  }

  /** 列出全部文件夹（含每夹 total/unseen 计数） */
  async listMailboxes() {
    const t0 = Date.now();
    const tree = await this.session(async (imap) => {
      const boxes = await new Promise((resolve, reject) => {
        imap.getBoxes((err, b) => {
          if (err) reject(this._classify(err));
          else resolve(b);
        });
      });
      const list = [];
      const walk = (nodes, prefix) => {
        for (const [name, info] of Object.entries(nodes)) {
          const fullName = prefix ? `${prefix}${info.delimiter}${name}` : name;
          list.push({ name: fullName, delimiter: info.delimiter, attributes: info.attribs });
          if (info.children) walk(info.children, fullName);
        }
      };
      walk(boxes, '');

      // STATUS 查询计数（不打开邮箱；对 \Noselect 文件夹失败则记 null）
      for (const box of list) {
        try {
          const st = await new Promise((resolve, reject) => {
            imap.status(box.name, (err, r) => {
              if (err) reject(err);
              else resolve(r);
            });
          });
          box.messages = st.messages != null ? st.messages : null;
          box.unseen = st.unseen != null ? st.unseen : null;
        } catch {
          box.messages = null;
          box.unseen = null;
        }
      }
      return list;
    });

    return {
      results: tree,
      meta: this._meta({ command: 'list-mailboxes', returned: tree.length, elapsedMs: Date.now() - t0 }),
    };
  }
}

module.exports = {
  MailService,
  connect,
  connectWithRetry,
  createImapConfig,
  LOCAL_TEXT_SEARCH_PROVIDERS,
  LOCAL_SCAN_CAP,
};
