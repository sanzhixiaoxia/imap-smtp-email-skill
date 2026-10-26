/**
 * 展示层格式化：表格 / 纯文本渲染。纯函数，可单元测试。
 * 中文按双倍宽度计算列宽，保证 --format table 对齐。
 */

// 中日韩宽字符区间（近似 wcwidth）
const CJK_RE = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/;

function displayWidth(s) {
  let w = 0;
  for (const ch of String(s == null ? '' : s)) {
    w += CJK_RE.test(ch) ? 2 : 1;
  }
  return w;
}

function padDisplay(s, len) {
  const str = String(s == null ? '' : s);
  const w = displayWidth(str);
  return w >= len ? str : str + ' '.repeat(len - w);
}

// 按显示宽度截断，超长时以 … 收尾
function truncateDisplay(s, len) {
  const str = String(s == null ? '' : s);
  if (len <= 1) return str.slice(0, len);
  if (displayWidth(str) <= len) return str;
  let out = '';
  let w = 0;
  for (const ch of str) {
    const cw = CJK_RE.test(ch) ? 2 : 1;
    if (w + cw > len - 1) break;
    out += ch;
    w += cw;
  }
  return out + '…';
}

// 本地时区 YYYY-MM-DD HH:mm
function formatDate(d) {
  if (!d) return '-';
  const x = d instanceof Date ? d : new Date(d);
  if (isNaN(x.getTime())) return '-';
  const p = (n) => String(n).padStart(2, '0');
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())} ${p(x.getHours())}:${p(x.getMinutes())}`;
}

function formatSize(bytes) {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function hasSeen(item) {
  return (item.flags || []).includes('\\Seen');
}

// 单行摘要表（--format table）
function formatResultsTable(results) {
  const rows = (results || []).map((r) => [
    padDisplay(String(r.uid == null ? '' : r.uid), 8),
    padDisplay(formatDate(r.date), 16),
    padDisplay(truncateDisplay(r.from || '', 28), 28),
    padDisplay(hasSeen(r) ? '' : '未读', 4),
    padDisplay((r.attachments && r.attachments.length) ? '有' : '', 4),
    truncateDisplay(r.subject || '', 44),
  ].join('  '));

  const header = [
    padDisplay('UID', 8),
    padDisplay('日期', 16),
    padDisplay('发件人', 28),
    padDisplay('未读', 4),
    padDisplay('附件', 4),
    '主题',
  ].join('  ');
  const sep = '─'.repeat(displayWidth(header));
  if (!rows.length) return `${header}\n${sep}\n(无邮件)`;
  return [header, sep, ...rows].join('\n');
}

// 完整可读邮件（--format text）
function formatEmailText(item) {
  const lines = [];
  lines.push(`──── 邮件 UID ${item.uid} ────`);
  lines.push(`发件人:  ${item.from || '-'}`);
  if (item.to) lines.push(`收件人:  ${item.to}`);
  lines.push(`收信时间: ${formatDate(item.date)}（服务器时间，可信）`);
  if (item.headerDate) lines.push(`发信时间: ${formatDate(item.headerDate)}（发件人声明，可能不准确）`);
  lines.push(`主题:    ${item.subject || '(no subject)'}`);
  if (item.attachments && item.attachments.length) {
    lines.push(`附件:    ${item.attachments
      .map((a) => `${a.filename || '(无名)'}${a.size != null ? ` (${formatSize(a.size)})` : ''}`)
      .join(', ')}`);
  }
  lines.push('─'.repeat(46));
  lines.push(item.text
    ? String(item.text).trim()
    : '(无纯文本正文，可能是 HTML 邮件，可用 fetch <uid> 查看 html 字段)');
  return lines.join('\n');
}

module.exports = {
  displayWidth,
  padDisplay,
  truncateDisplay,
  formatDate,
  formatSize,
  formatResultsTable,
  formatEmailText,
  hasSeen,
};
