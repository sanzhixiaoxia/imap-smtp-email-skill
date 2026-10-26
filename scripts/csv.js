'use strict';

/**
 * CSV 导出（RFC 4180 转义）。用于把邮件列表导出给 Excel/后续处理。
 */

function escapeCell(value) {
  const s = value == null ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows, columns) {
  const header = columns.map((c) => escapeCell(c.header)).join(',');
  const lines = (rows || []).map((row) =>
    columns
      .map((c) => escapeCell(typeof c.value === 'function' ? c.value(row) : row[c.key]))
      .join(','),
  );
  return [header, ...lines].join('\n');
}

// 邮件列表的标准列
const EMAIL_COLUMNS = [
  { key: 'uid', header: 'uid' },
  { key: 'mailbox', header: 'mailbox' },
  { key: 'date', header: 'date', value: (r) => (r.date ? new Date(r.date).toISOString() : '') },
  { key: 'from', header: 'from' },
  { key: 'to', header: 'to' },
  { key: 'subject', header: 'subject' },
  { key: 'unseen', header: 'unseen', value: (r) => ((r.flags || []).includes('\\Seen') ? '0' : '1') },
  { key: 'attachments', header: 'attachments', value: (r) => (r.attachments || []).map((a) => a.filename).join(';') },
  { key: 'snippet', header: 'snippet' },
];

function emailsToCsv(results) {
  return toCsv(results || [], EMAIL_COLUMNS);
}

module.exports = { toCsv, escapeCell, emailsToCsv, EMAIL_COLUMNS };
