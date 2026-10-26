/**
 * list-accounts 表格渲染（imap.js 与 smtp.js 共用，避免两份重复实现）。
 */

function padRight(str, len) {
  return (String(str) + ' '.repeat(len)).slice(0, len);
}

function displayAccounts(accounts, configPath) {
  if (!configPath) {
    console.error('未找到邮箱配置文件。');
    console.error('请先运行 "bash setup.sh" 完成配置。');
    process.exit(1);
  }
  if (accounts.length === 0) {
    console.error(`${configPath} 中没有任何账户配置。`);
    process.exit(0);
  }

  console.log(`已配置的账户（来自 ${configPath}）:\n`);

  const maxNameLen = Math.max(7, ...accounts.map((a) => a.name.length));
  const maxEmailLen = Math.max(5, ...accounts.map((a) => a.email.length));
  const maxImapLen = Math.max(4, ...accounts.map((a) => a.imapHost.length));
  const maxSmtpLen = Math.max(4, ...accounts.map((a) => a.smtpHost.length));

  const header = `  ${padRight('Account', maxNameLen)}  ${padRight('Email', maxEmailLen)}  ${padRight('IMAP', maxImapLen)}  ${padRight('SMTP', maxSmtpLen)}  Status`;
  console.log(header);
  console.log('  ' + '─'.repeat(maxNameLen) + '  ' + '─'.repeat(maxEmailLen) + '  ' + '─'.repeat(maxImapLen) + '  ' + '─'.repeat(maxSmtpLen) + '  ' + '────────────────');

  for (const account of accounts) {
    const statusIcon = account.isComplete ? '✓' : '⚠';
    const statusText = account.isComplete ? 'Complete' : 'Incomplete';
    console.log(`  ${padRight(account.name, maxNameLen)}  ${padRight(account.email, maxEmailLen)}  ${padRight(account.imapHost, maxImapLen)}  ${padRight(account.smtpHost, maxSmtpLen)}  ${statusIcon} ${statusText}`);
  }

  console.log(`\n  共 ${accounts.length} 个账户`);
}

module.exports = { displayAccounts, padRight };
