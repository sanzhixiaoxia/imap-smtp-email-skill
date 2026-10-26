'use strict';

/**
 * 结构化日志。默认静默；--verbose 或 MAIL_DEBUG=1 时输出到 stderr
 * （不污染 stdout 的 JSON 结果）。
 */

function createLogger(options = {}) {
  const verbose = options.verbose === true || process.env.MAIL_DEBUG === '1';
  const stream = options.stream || process.stderr;
  const prefix = options.prefix || 'mail';
  const write = (line) => {
    try {
      stream.write(`[${prefix}] ${line}\n`);
    } catch {
      /* 写日志失败不影响主流程 */
    }
  };
  return {
    get enabled() {
      return verbose;
    },
    debug(msg) {
      if (verbose) write(typeof msg === 'function' ? msg() : msg);
    },
    // 返回一个计时器：done() 时打印耗时
    time(label) {
      const t0 = Date.now();
      return (extra) => {
        if (verbose) write(`${label} ${Date.now() - t0}ms${extra ? ` ${extra}` : ''}`);
      };
    },
  };
}

module.exports = { createLogger };
