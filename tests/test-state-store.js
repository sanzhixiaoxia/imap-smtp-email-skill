'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { StateStore } = require('../scripts/state-store');

function tmpStateFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-state-'));
  return path.join(dir, 'state.json');
}

test('StateStore: 无文件时从空状态开始', () => {
  const store = new StateStore(tmpStateFile());
  assert.equal(store.get('default', 'INBOX'), null);
});

test('StateStore: recordCheck 后 get 能读回', () => {
  const file = tmpStateFile();
  const store = new StateStore(file);
  store.recordCheck('default', 'INBOX', { lastSeenUid: 501 });
  const st = store.get('default', 'INBOX');
  assert.ok(st);
  assert.equal(st.lastSeenUid, 501);
  assert.equal(st.checks, 1);
  assert.ok(new Date(st.lastCheckAt).getTime() > 0);

  // 重新加载（模拟下次进程）
  const store2 = new StateStore(file);
  const st2 = store2.get('default', 'INBOX');
  assert.equal(st2.lastSeenUid, 501);
  assert.equal(st2.checks, 1);
});

test('StateStore: checks 累加', () => {
  const file = tmpStateFile();
  const store = new StateStore(file);
  store.recordCheck('default', 'INBOX');
  store.recordCheck('default', 'INBOX');
  store.recordCheck('default', 'INBOX');
  assert.equal(store.get('default', 'INBOX').checks, 3);
});

test('StateStore: 按 账户+文件夹 隔离', () => {
  const store = new StateStore(tmpStateFile());
  store.recordCheck('default', 'INBOX', { lastSeenUid: 1 });
  store.recordCheck('work', 'INBOX', { lastSeenUid: 2 });
  store.recordCheck('default', 'Archive', { lastSeenUid: 3 });
  assert.equal(store.get('default', 'INBOX').lastSeenUid, 1);
  assert.equal(store.get('work', 'INBOX').lastSeenUid, 2);
  assert.equal(store.get('default', 'Archive').lastSeenUid, 3);
  assert.equal(store.get('work', 'Archive'), null);
});

test('StateStore: update 合并而非覆盖', () => {
  const file = tmpStateFile();
  const store = new StateStore(file);
  store.update('default', 'INBOX', { lastSeenUid: 10 });
  store.update('default', 'INBOX', { checks: 5 });
  const st = store.get('default', 'INBOX');
  assert.equal(st.lastSeenUid, 10);
  assert.equal(st.checks, 5);
});

test('StateStore: reset 单文件夹与全清', () => {
  const store = new StateStore(tmpStateFile());
  store.recordCheck('default', 'INBOX');
  store.recordCheck('work', 'INBOX');
  store.reset('default', 'INBOX');
  assert.equal(store.get('default', 'INBOX'), null);
  assert.notEqual(store.get('work', 'INBOX'), null);
  store.reset();
  assert.equal(store.get('work', 'INBOX'), null);
});

test('StateStore: 文件损坏时降级为空状态', () => {
  const file = tmpStateFile();
  fs.writeFileSync(file, '{ this is not json');
  const store = new StateStore(file);
  assert.equal(store.get('default', 'INBOX'), null);
  // 损坏不影响后续写入
  store.recordCheck('default', 'INBOX');
  assert.ok(new StateStore(file).get('default', 'INBOX'));
});

test('StateStore: MAIL_STATE_FILE 环境变量覆盖', () => {
  const file = tmpStateFile();
  const prev = process.env.MAIL_STATE_FILE;
  process.env.MAIL_STATE_FILE = file;
  try {
    const store = new StateStore();
    store.recordCheck('default', 'INBOX', { lastSeenUid: 7 });
    assert.equal(new StateStore().get('default', 'INBOX').lastSeenUid, 7);
  } finally {
    if (prev === undefined) delete process.env.MAIL_STATE_FILE;
    else process.env.MAIL_STATE_FILE = prev;
  }
});
