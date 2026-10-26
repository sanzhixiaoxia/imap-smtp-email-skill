---
slug: imap-smtp-email-sanzhixiaoxia
displayName: 多邮箱管理助手
version: 2.2.1
summary: 通过 IMAP/SMTP 收发邮件：增量收取、搜索、附件下载、批量标记、发信、连通性体检。支持 Gmail/Outlook/163/QQ/139/sina/aliyun/189 等 19 种邮箱，含非交互式一条命令配置、凭证 AES-256 加密存储，分层可测架构。
license: MIT
name: multi-mailbox-assistant
description: 多邮箱管理助手——通过 IMAP/SMTP 收发邮件。Check for new/unread messages (with incremental --since-last polling), fetch content by UID, search mailboxes, download attachments, mark as read/unread, and send emails with attachments. Supports multiple accounts, JSON/table/text/CSV output, and a doctor command for connectivity checks. Works with any IMAP/SMTP server including Gmail, Outlook, 163.com, vip.163.com, 126.com, vip.126.com, 188.com, vip.188.com, yeah.net, QQ, exmail.qq.com, iCloud, Fastmail, 139, sina, aliyun, 189, and NetEase Enterprise.
metadata:
  clawdbot:
    emoji: "\U0001F4E7"
    requires:
      bins:
        - node
        - npm
      env:
        - PROVIDER
        - USERNAME
        - PASSWORD
    primaryEnv: PROVIDER
display_name: "多邮箱管理助手"
display_name_en: "Multi-Mailbox Assistant"
description_zh: "多邮箱管理助手——支持多账户、增量收取与附件管理"
description_en: "Multi-mailbox assistant: read and send email via IMAP/SMTP with multi-account, incremental check, and attachment support"
visibility: "public"
---

# 多邮箱管理助手 (Multi-Mailbox Assistant)

Read, search, and manage email via IMAP protocol. Send email via SMTP. Supports Gmail, Outlook, 163.com, vip.163.com, 126.com, vip.126.com, 188.com, vip.188.com, yeah.net, QQ Mail, exmail.qq.com, iCloud, Fastmail, 139, sina, aliyun, 189, NetEase Enterprise, and any standard IMAP/SMTP server.

## 快速开始：收取 163 邮箱新邮件

1. **开启服务并获取授权码**：163 网页版 → 设置 → POP3/SMTP/IMAP → 开启 IMAP/SMTP 服务 → 按提示获取授权码（**不是登录密码**）
2. **配置账户（推荐：一条命令，无需菜单）**：

```bash
node scripts/mail.js configure --provider 163 --user you@163.com --password 你的授权码
```

也可交互式 `bash setup.sh`（选 `1) 163.com`，密码处填授权码）。

3. **收取新邮件**：

```bash
node scripts/mail.js check --new               # 最近 24 小时未读（最常用）
node scripts/mail.js check --since-last        # 自从上次检查以来的新邮件（agent 轮询推荐）
node scripts/mail.js check --recent 7d --unseen
node scripts/mail.js check --format table      # 摘要表格，适合快速浏览
node scripts/mail.js check --format text       # 完整可读正文
node scripts/mail.js check --format csv        # 导出给 Excel/后续处理
```

> `node scripts/mail.js` 是统一入口，收发/配置/体检全部命令都在这里。`scripts/imap.js`（仅收）和 `scripts/smtp.js`（仅发）仍可作为兼容入口使用。多账户加 `--account <name>`。

## Configuration

Run the setup script to install dependencies and configure your email account:

```bash
bash setup.sh
```

If running commands manually without setup.sh, install dependencies first:

```bash
npm install --production
```

Configuration is stored at `~/.config/mail-skills/.env` (shared with caldav-sync skill, survives skill updates). If no shared config is found, the skill checks `~/.config/imap-smtp-email/.env` (legacy) and then a `.env` file in the skill directory. **Passwords are stored encrypted** (AES-256-GCM, `enc:v1:...`); the key lives at `~/.config/mail-skills/.key` (or `$MAIL_SKILLS_KEY`).

Environment overrides:
- `MAIL_SKILLS_ENV=/path/to/.env` — use a different config file (highest priority; also skips the default locations)
- `MAIL_STATE_FILE=/path/to/state.json` — relocate the incremental-check state file (default `~/.cache/mail-skills/state.json`)
- `MAIL_DEBUG=1` — debug logging on stderr (same as `--verbose`)

### Config file format (shared)

```bash
# Default account
PROVIDER=163
USERNAME=your@163.com
PASSWORD=your_password

# Optional: connection retries (default 1) and port overrides
IMAP_RETRIES=1
SMTP_RETRIES=1
# IMAP_PORT=993
# SMTP_PORT=465

# File access whitelist (security)
ALLOWED_READ_DIRS=~/Downloads,~/Documents
ALLOWED_WRITE_DIRS=~/Downloads
```

The `PROVIDER` preset auto-fills IMAP/SMTP server settings. For custom servers:

```bash
PROVIDER=custom
USERNAME=your@email.com
PASSWORD=your_password
IMAP_HOST=imap.example.com
SMTP_HOST=smtp.example.com
```

### Legacy config file format

If you have an existing `~/.config/imap-smtp-email/.env`, it takes priority over the shared config. The format is:

```bash
# Default account (no prefix)
IMAP_HOST=imap.gmail.com
IMAP_PORT=993
IMAP_USER=your@email.com
IMAP_PASS=your_password
IMAP_TLS=true
IMAP_REJECT_UNAUTHORIZED=true
IMAP_MAILBOX=INBOX

SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your@email.com
SMTP_PASS=your_password
SMTP_FROM=your@email.com
SMTP_REJECT_UNAUTHORIZED=true

# File access whitelist (security)
ALLOWED_READ_DIRS=~/Downloads,~/Documents
ALLOWED_WRITE_DIRS=~/Downloads
```

Run `bash setup.sh` to migrate your legacy config to the shared format.

## Multi-Account

You can configure additional email accounts in the same config file. Each account uses a name prefix (uppercase) on all variables.

### Adding an account

Run the setup script and choose "Add a new account":

```bash
bash setup.sh
```

Or manually add prefixed variables to `~/.config/mail-skills/.env`:

```bash
# Work account (WORK_ prefix)
WORK_PROVIDER=gmail
WORK_USERNAME=me@company.com
WORK_PASSWORD=app_password
```

### Using a named account

Add `--account <name>` before the command:

```bash
node scripts/imap.js --account work check
node scripts/smtp.js --account work send --to foo@bar.com --subject Hi --body Hello
```

Without `--account`, the default (unprefixed) account is used.

### Account name rules

- Letters and digits only (e.g., `work`, `163`, `personal2`)
- Case-insensitive: `work` and `WORK` refer to the same account
- The prefix in `.env` is always uppercase (e.g., `WORK_PROVIDER`)
- `ALLOWED_READ_DIRS` and `ALLOWED_WRITE_DIRS` are shared across all accounts (always unprefixed)

## Common Email Servers

| Provider | IMAP Host | IMAP Port | SMTP Host | SMTP Port |
|----------|-----------|-----------|-----------|-----------|
| 163.com | imap.163.com | 993 | smtp.163.com | 465 |
| vip.163.com | imap.vip.163.com | 993 | smtp.vip.163.com | 465 |
| 126.com | imap.126.com | 993 | smtp.126.com | 465 |
| vip.126.com | imap.vip.126.com | 993 | smtp.vip.126.com | 465 |
| 188.com | imap.188.com | 993 | smtp.188.com | 465 |
| vip.188.com | imap.vip.188.com | 993 | smtp.vip.188.com | 465 |
| yeah.net | imap.yeah.net | 993 | smtp.yeah.net | 465 |
| Gmail | imap.gmail.com | 993 | smtp.gmail.com | 587 |
| Outlook | outlook.office365.com | 993 | smtp.office365.com | 587 |
| QQ Mail | imap.qq.com | 993 | smtp.qq.com | 587 |
| exmail.qq.com | imap.exmail.qq.com | 993 | smtp.exmail.qq.com | 465 |
| iCloud | imap.mail.me.com | 993 | smtp.mail.me.com | 587 |
| Fastmail | imap.fastmail.com | 993 | smtp.fastmail.com | 465 |
| 139.com | imap.139.com | 993 | smtp.139.com | 465 |
| sina.com | imap.sina.com | 993 | smtp.sina.com | 465 |
| aliyun.com | imap.aliyun.com | 993 | smtp.aliyun.com | 465 |
| 189.cn | imap.189.cn | 993 | smtp.189.cn | 465 |
| NetEase Enterprise | imap.qiye.163.com | 993 | smtp.qiye.163.com | 465 |

**Important for Gmail:**
- Gmail does **not** accept your regular account password
- You must generate an **App Password**: https://myaccount.google.com/apppasswords
- Use the generated 16-character App Password as `IMAP_PASS` / `SMTP_PASS`
- Requires Google Account with 2-Step Verification enabled

**Important for 163.com:**
- Use **authorization code** (授权码), not account password
- Enable IMAP/SMTP in web settings first

## IMAP Commands (Receiving Email)

### check
Check for new/unread emails.

```bash
node scripts/imap.js [--account <name>] check [options]
```

Options:
- `--limit <n>`: Max results (default: 10)
- `--mailbox <name>`: Mailbox to check (default: INBOX)
- `--recent <time>`: Only show emails from last X time (e.g., 30m, 2h, 7d)
- `--unseen`: Only show unread messages
- `--new`: Shortcut for "last 24h + unread" (the usual "new mail" check)
- `--since-last`: Only show emails since the last successful check (incremental polling; falls back to full scan with `meta.note` on first run)
- `--offset <n>`: Skip the newest N results (pagination)
- `--body-chars <n>`: Truncate text/html bodies to N chars (keeps output small)
- `--format <json|table|text|csv>`: Output format (default: json)
- `--save <file>`: Write the result to a file instead of stdout
- `--verbose`: Debug logging on stderr

`--since-last` state lives at `~/.cache/mail-skills/state.json` (override with
`MAIL_STATE_FILE`), keyed per account + mailbox. Each successful check records
`lastCheckAt`; the next `--since-last` run uses it as the SINCE date and drops
anything older client-side (server SINCE is day-granular only). The response
carries `meta.sinceLast` (whether history was used) and
`meta.skippedDuplicate` (how many day-boundary leftovers were filtered).

Output is an object: `{ "results": [...], "meta": {...} }` (same shape as
`search`).

### fetch
Fetch full email content by UID (one or many).

```bash
node scripts/imap.js [--account <name>] fetch <uid> [uid2 uid3...] [--mailbox INBOX] [--body-chars 5000]
```

Requested UIDs that do not exist are reported in `meta.missing` instead of
failing the whole call.

### download
Download attachments. With UIDs: per-message. Without UIDs: batch mode driven
by `--recent`/`--new`/`--since`/`--unseen` + `--limit`.

```bash
node scripts/imap.js [--account <name>] download <uid> [uid2...] [options]
node scripts/imap.js [--account <name>] download --recent 7d --limit 20 [options]
```

Options:
- `--mailbox <name>`: Mailbox (default: INBOX)
- `--dir <path>`: Output directory (default: current directory; must be inside `ALLOWED_WRITE_DIRS`)
- `--file <filename>`: Download only the specified attachment (default: download all)
- `--flat`: Put all attachments in `--dir` directly instead of per-message subdirectories

Each message gets its own subdirectory `<uid>-<subject-slug>/` by default, so
attachments from different messages never collide. Results include the on-disk
path and size of every downloaded file.

### search
Search emails with filters.

```bash
node scripts/imap.js [--account <name>] search [options]
```

Options:
```
  --unseen           Only unread messages
  --seen             Only read messages
  --from <email>     From address contains
  --subject <text>   Subject contains
  --recent <time>    From last X time (e.g., 30m, 2h, 7d)
  --new              Last 24h only
  --since <date>     After date (YYYY-MM-DD)
  --before <date>    Before date (YYYY-MM-DD)
  --limit <n>        Max results (default: 20)
  --offset <n>       Skip the newest N results (pagination)
  --mailbox <name>   Mailbox to search (default: INBOX)
  --sort <mode>      uid (default, fast) or date (strict INTERNALDATE sort;
                     fetches all matches, use when mailbox has COPY'd/backdated mail)
  --format <json|table|text|csv>
  --body-chars <n>
  --save <file>
```

Output is an object: `{ "results": [...], "meta": {...} }` where `results` is
an array of message objects and `meta` carries `fallbackUsed`, `provider`,
`mailbox`, `scope`, `scanned`, `matched`, `returned`, `truncated`, and optional `note`.

Each result contains `uid`, `from`, `to`, `subject`, `date` (server
INTERNALDATE — trust this for "newest"), `headerDate` (sender's Date header —
may be forged), `text`, `html`, `snippet`, `attachments` (filename/size only),
`flags`, and `mailbox`.

For 163/126/188/yeah.net (NetEase) accounts, the IMAP server silently returns
empty for text-based SEARCH (`--from`/`--subject`). These are automatically
filtered client-side: server-side SEARCH keeps only date/flag criteria, then
fetched messages are filtered locally (`meta.fallbackUsed=true`). When
searching `--from`/`--subject` without a date/flag scope, only the most recent
200 messages are scanned (`meta.truncated=true`) — add `--recent`/`--since` to
search a wider range.

### mark-read / mark-unread
Mark message(s) as read or unread (one or many UIDs).

```bash
node scripts/imap.js [--account <name>] mark-read <uid> [uid2 uid3...]
node scripts/imap.js [--account <name>] mark-unread <uid> [uid2 uid3...]
```

### list-mailboxes
List all available mailboxes/folders, with message and unread counts.

```bash
node scripts/imap.js [--account <name>] list-mailboxes
```

Non-INBOX folders of 163/126/188 have Chinese names (`已发送`, `草稿箱`,
`垃圾邮件`, `已删除`). Pass them directly as `--mailbox`:

```bash
node scripts/imap.js check --mailbox 垃圾邮件 --unseen
```

### list-accounts
List all configured email accounts.

```bash
node scripts/imap.js list-accounts
node scripts/smtp.js list-accounts
```

Shows account name, email address, server addresses, and configuration status.

### doctor
Test connectivity of every configured account (IMAP + SMTP) without sending
any email. Prints a per-account table and exits non-zero if any check failed.

```bash
node scripts/imap.js doctor
node scripts/smtp.js doctor
```

## SMTP Commands (Sending Email)

### send
Send email via SMTP (automatic retry on transient failures, count via
`SMTP_RETRIES`, default 1).

```bash
node scripts/smtp.js [--account <name>] send --to <email> --subject <text> [options]
```

**Required:**
- `--to <email>`: Recipient (comma-separated for multiple)
- `--subject <text>`: Email subject, or `--subject-file <file>`

**Optional:**
- `--body <text>`: Plain text body
- `--html`: Send body as HTML
- `--body-file <file>`: Read body from file
- `--html-file <file>`: Read HTML from file
- `--cc <email>`: CC recipients
- `--bcc <email>`: BCC recipients
- `--attach <file>`: Attachments (comma-separated; must be inside `ALLOWED_READ_DIRS`)
- `--from <email>`: Override default sender

**Examples:**
```bash
# Simple text email
node scripts/smtp.js send --to recipient@example.com --subject "Hello" --body "World"

# HTML email
node scripts/smtp.js send --to recipient@example.com --subject "Newsletter" --html --body "<h1>Welcome</h1>"

# Email with attachment
node scripts/smtp.js send --to recipient@example.com --subject "Report" --body "Please find attached" --attach report.pdf

# Multiple recipients
node scripts/smtp.js send --to "a@example.com,b@example.com" --cc "c@example.com" --subject "Update" --body "Team update"
```

### test
Test SMTP connection by sending a test email to yourself.

```bash
node scripts/smtp.js [--account <name>] test
```

## Output Formats

All commands print JSON by default (`{results, meta}` for list commands).
For human consumption:

```bash
node scripts/imap.js check --new --format table   # 摘要表：UID/日期/发件人/未读/附件/主题
node scripts/imap.js check --new --format text    # 每封邮件的完整可读渲染
node scripts/imap.js check --new --format csv     # RFC 4180 CSV（Excel 可直接打开）
node scripts/imap.js fetch 12345 --format text
```

`--save <file>` writes the result to a file instead of stdout (in the selected
format; path is NOT restricted by the whitelist — it is an explicit user
action, unlike attachment downloads).

## Error Model

All failures print `错误[CODE]: message` plus a Chinese `提示:` line when a
hint is available, and exit with code 1. Codes are stable for automation:

| Code | Meaning | Typical fix |
|------|---------|-------------|
| `CONFIG_MISSING` | No config file found | Run `bash setup.sh` |
| `CONFIG_INVALID` | Config incomplete / unknown account / bad provider | Check `.env` keys; run `list-accounts` |
| `AUTH_FAILED` | Credentials rejected | Use authorization code / App Password; enable IMAP |
| `CONNECTION_FAILED` | Network/TLS/timeout | Raise `IMAP_RETRIES`; check `REJECT_UNAUTHORIZED` |
| `MAILBOX_NOT_FOUND` | Folder does not exist | Run `list-mailboxes` for exact names |
| `INVALID_INPUT` | Bad CLI argument | Check UIDs are numeric, options not conflicting |
| `IO_ERROR` | File read/write blocked or failed | Check `ALLOWED_READ_DIRS`/`ALLOWED_WRITE_DIRS` |
| `UNKNOWN` | Unclassified error | Re-run with `--verbose` and inspect stderr |

## Security Notes

- **凭证加密（默认开启）**：密码/授权码以 AES-256-GCM 加密后存为 `enc:v1:...`，配置文件 `~/.config/mail-skills/.env` 中不再出现明文。加密密钥存于 `~/.config/mail-skills/.key`（`600` 权限，首次使用自动生成）。加载时自动解密，命令用法不变。
- **密钥可外置**：把 `.key` 放到 U 盘/挂载盘等外部位置更安全，通过 `MAIL_SKILLS_KEY=/path/to/.key` 或 `configure --key-path` 指定；密钥与密文分离后，单独泄露配置文件无法还原密码。
- **信任边界**：加密防的是「配置文件被误读/误传/备份泄露」，不是对抗本机 root——密钥与密文同机时，能读到 `.key` 的用户仍可解密。需要更强保护请将 `.key` 外置。
- **密钥丢失**：无法再解密旧密码，用 `configure --force` 重新写入账户即可。
- Configuration is stored at `~/.config/mail-skills/.env` (or `~/.config/imap-smtp-email/.env` for legacy) with `600` permissions (owner read/write only)
- Attachment downloads are restricted to `ALLOWED_WRITE_DIRS`; attachment/sending file reads are restricted to `ALLOWED_READ_DIRS` (symlink-resolved)
- **Gmail**: regular password is rejected — generate an App Password at https://myaccount.google.com/apppasswords
- For 163.com: use authorization code (授权码), not account password

## Troubleshooting

**Authentication failed:**
- 163/126/188/yeah: use the authorization code (授权码), and enable IMAP in web settings first
- QQ Mail: use the authorization code (授权码)
- Gmail: generate an App Password (requires 2-Step Verification)
- The CLI prints provider-specific hints automatically on auth failures

**Connection timeout / first attempt refused:**
- The CLI retries once by default; raise with `IMAP_RETRIES=3` in `.env`

**Chinese text looks garbled:**
- Should not happen — bodies are collected as raw Buffers and decoded once
  (per-chunk decoding corrupts multi-byte characters split across chunks)

**Mailbox not found:**
- Run `list-mailboxes` to see exact folder names; Chinese names work as `--mailbox` values

**TLS/SSL errors:**
- Match `IMAP_TLS`/`SMTP_SECURE` setting to server requirements
- For self-signed certs: set `IMAP_REJECT_UNAUTHORIZED=false` or `SMTP_REJECT_UNAUTHORIZED=false`

**`--since-last` returns nothing:**
- First run has no history and returns everything; check `meta.sinceLast`/`meta.note`
- Reset state by deleting `~/.cache/mail-skills/state.json` (or point `MAIL_STATE_FILE` elsewhere)

## Development

```bash
npm test        # node:test unit tests (utils / format / mail-core / config /
                #  state-store / csv / errors / cli / mail-service / smtp-service)
```

Module layout:
- `scripts/utils.js` — pure helpers (argv parsing, dates, filename sanitizing)
- `scripts/format.js` — CJK-aware display (width, tables, text rendering)
- `scripts/csv.js` — RFC 4180 CSV export
- `scripts/errors.js` — MailError + error classification + provider hints
- `scripts/logger.js` — debug logger (`MAIL_DEBUG=1` / `--verbose`, stderr only)
- `scripts/state-store.js` — incremental-check state (`--since-last`)
- `scripts/providers.js` — server presets (19 providers)
- `scripts/mail-core.js` — IMAP protocol layer (fetch/search/parse/path safety)
- `scripts/mail-service.js` — IMAP service layer (check/fetch/search/download/mark/list)
- `scripts/smtp-service.js` — SMTP service layer (send/verify/test)
- `scripts/config.js` — config loading (pure, no process.exit)
- `scripts/cli.js` — CLI framework (commands, formats, unified errors)
- `scripts/doctor.js` — connectivity doctor
- `scripts/imap.js` / `scripts/smtp.js` — thin CLI shells (command registration only)

## Related Skills

- **[caldav-sync](https://clawhub.ai/gzlicanyi/caldav-sync)** - Calendar and task management via CalDAV protocol. Manage events, todos, and free/busy queries with Google Calendar, iCloud, NetEase, and more. Install with:
  ```bash
  npx skills add https://github.com/gzlicanyi/mail-skills -s caldav-sync
  ```

## Feedback

Issues and pull requests are welcome at [github.com/gzlicanyi/mail-skills](https://github.com/gzlicanyi/mail-skills).
