'use strict';

/**
 * 极简 CLI 框架：命令注册 + 统一输出 + 统一错误处理。
 * imap.js / smtp.js 只是声明式地注册命令，不再各自重复解析/输出/错误逻辑。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseArgs } = require('./utils');
const { MailError, classifyError, formatError } = require('./errors');
const { formatResultsTable, formatEmailText } = require('./format');
const { emailsToCsv } = require('./csv');

const VALID_FORMATS = ['json', 'table', 'text', 'csv'];

/** 从 argv 中剥离 --account <name>，返回剩余 argv */
function extractAccount(argv) {
  const args = argv.slice(2);
  const idx = args.indexOf('--account');
  if (idx !== -1 && idx + 1 < args.length) {
    const name = args[idx + 1];
    args.splice(idx, 2);
    return { accountName: name, argv: [argv[0], argv[1], ...args] };
  }
  return { accountName: null, argv };
}

function printUsage(script, commands) {
  const lines = [
    `用法: node ${script} [--account <name>] <命令> [选项]`,
    '',
    '可用命令:',
  ];
  for (const [name, def] of Object.entries(commands)) {
    lines.push(`  ${name.padEnd(16)} ${def.description || ''}`);
  }
  lines.push('');
  lines.push('通用选项:');
  lines.push('  --format json|table|text|csv   输出格式（默认 json）');
  lines.push('  --save <file>                  结果写入文件而非 stdout');
  lines.push('  --help                         显示本帮助');
  console.error(lines.join('\n'));
}

/** 把命令结果渲染到 stdout（或写入 --save 文件） */
function emitResult(result, options) {
  const format = options.format || 'json';

  if (options.save) {
    const resolved = path.resolve(String(options.save).replace(/^~/, os.homedir()));
    const content = renderForSave(result, format);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, content);
    console.error(`结果已保存到: ${resolved}`);
    return;
  }

  if (format === 'json' || !hasEmailItems(result)) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const items = emailItems(result);
  if (format === 'table') {
    console.log(formatResultsTable(items));
  } else if (format === 'text') {
    items.forEach((item, i) => {
      console.log(formatEmailText(item));
      if (i < items.length - 1) console.log('');
    });
  } else if (format === 'csv') {
    console.log(emailsToCsv(items));
  }
}

function hasEmailItems(result) {
  if (!result || typeof result !== 'object') return false;
  if (Array.isArray(result.results)) return true;
  return typeof result.from === 'string'; // 单封邮件对象
}

function emailItems(result) {
  return Array.isArray(result.results) ? result.results : [result];
}

function renderForSave(result, format) {
  if (format === 'json') return JSON.stringify(result, null, 2);
  if (!hasEmailItems(result)) return JSON.stringify(result, null, 2);
  const items = emailItems(result);
  if (format === 'csv') return emailsToCsv(items);
  if (format === 'table') return formatResultsTable(items);
  if (format === 'text') return items.map((item) => formatEmailText(item)).join('\n\n');
  return JSON.stringify(result, null, 2);
}

/**
 * 运行 CLI。
 * @param {{script: string, boolFlags?: string[], argv?: string[], commands: object,
 *          exit?: Function, onHelp?: Function}} config
 */
async function runCli(config) {
  const {
    script, boolFlags = [], argv = process.argv, commands,
    exit = (code) => process.exit(code),
  } = config;

  const { command, options, positional } = parseArgs(argv, new Set(boolFlags));

  if (command === 'help' || options.help || options.h) {
    printUsage(script, commands);
    exit(0);
    return;
  }

  if (options.format && !VALID_FORMATS.includes(options.format)) {
    console.error(`错误: 未知输出格式 "${options.format}"，可用: ${VALID_FORMATS.join(' | ')}`);
    exit(1);
    return;
  }

  const def = commands[command];
  if (!def) {
    console.error(`未知命令: ${command || '(空)'}`);
    printUsage(script, commands);
    exit(1);
    return;
  }

  try {
    const result = await def.handler({ options, positional });
    if (!def.raw && result !== undefined) {
      emitResult(result, options);
    }
  } catch (err) {
    const e = err instanceof MailError ? err : classifyError(err);
    console.error(formatError(e));
    exit(1);
  }
}

module.exports = {
  runCli,
  extractAccount,
  printUsage,
  emitResult,
  hasEmailItems,
  emailItems,
  VALID_FORMATS,
};
