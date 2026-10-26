'use strict';

/**
 * 增量检查状态存储。
 * 记录每个「账户 + 文件夹」最后一次检查时间与最大 UID，
 * 使 check --since-last 只返回上次检查之后的新邮件（agent 轮询场景）。
 * 状态文件: ~/.cache/mail-skills/state.json（可用 MAIL_STATE_FILE 覆盖）
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_STATE_PATH = path.join(os.homedir(), '.cache', 'mail-skills', 'state.json');

class StateStore {
  constructor(filePath) {
    this.filePath = filePath || process.env.MAIL_STATE_FILE || DEFAULT_STATE_PATH;
    this.data = this._read();
  }

  _read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (parsed && typeof parsed === 'object' && parsed.accounts && typeof parsed.accounts === 'object') {
        return parsed;
      }
    } catch {
      /* 首次运行或文件损坏 → 全新状态 */
    }
    return { accounts: {} };
  }

  _write() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
      try {
        fs.chmodSync(this.filePath, 0o600);
      } catch {
        /* 忽略权限设置失败 */
      }
    } catch (err) {
      // 状态持久化失败不阻断主流程
      if (process.env.MAIL_DEBUG === '1') {
        process.stderr.write(`[state] 保存失败: ${err.message}\n`);
      }
    }
  }

  static key(account, mailbox) {
    return `${account || 'default'}::${mailbox || 'INBOX'}`;
  }

  get(account, mailbox) {
    return this.data.accounts[StateStore.key(account, mailbox)] || null;
  }

  update(account, mailbox, patch) {
    const k = StateStore.key(account, mailbox);
    const prev = this.data.accounts[k] || { checks: 0 };
    this.data.accounts[k] = {
      ...prev,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    this._write();
    return this.data.accounts[k];
  }

  // 一次成功检查后调用：推进 lastCheckAt 与 lastSeenUid
  recordCheck(account, mailbox, extra = {}) {
    const prev = this.get(account, mailbox);
    return this.update(account, mailbox, {
      lastCheckAt: new Date().toISOString(),
      checks: (prev && prev.checks ? prev.checks : 0) + 1,
      ...(extra.lastSeenUid != null ? { lastSeenUid: extra.lastSeenUid } : {}),
    });
  }

  // 清除某账户/文件夹的状态（下次 --since-last 回到全量）
  reset(account, mailbox) {
    if (account == null && mailbox == null) {
      this.data = { accounts: {} };
    } else {
      delete this.data.accounts[StateStore.key(account, mailbox)];
    }
    this._write();
  }
}

module.exports = { StateStore, DEFAULT_STATE_PATH };
