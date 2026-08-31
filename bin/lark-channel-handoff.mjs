#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fail, runLarkCli } from './artifact-common.mjs';

const HELP = `把当前 Codex 桌面/CLI 任务交接到飞书 PersonalAgent。

用法:
  lark-channel-handoff [--profile <名称>] [--thread <thread-id>] [--note <说明>]
  lark-channel-handoff [--profile <名称>] --check

说明:
  - 在 Codex 内运行时会自动读取 CODEX_THREAD_ID/CODEX_SESSION_ID
  - bot 会私信应用 owner 一张“接管到飞书”卡片；点击后当前私聊切到该任务
  - 不接受任意收件人，固定发给 PersonalAgent owner
`;

const parsed = parseArgs(process.argv.slice(2));
if (parsed.help) {
  process.stdout.write(HELP);
  process.exit(0);
}
const threadId = parsed.thread || process.env.CODEX_THREAD_ID || process.env.CODEX_SESSION_ID;
if (!parsed.check && !threadId) fail('找不到当前 Codex thread id，请显式传入 --thread。');
if (threadId && !/^[A-Za-z0-9_-]{8,128}$/.test(threadId)) fail('thread id 格式无效。');

const rootDir = process.env.LARK_CHANNEL_HOME || join(homedir(), '.lark-channel');
const profile = parsed.profile || readActiveProfile(rootDir);
validateProfile(profile);
const profileDir = join(rootDir, 'profiles', profile);
const sourceConfig = join(profileDir, 'lark-cli-source', 'config.json');
const cliConfigDir = join(profileDir, 'lark-cli');
if (!existsSync(sourceConfig)) {
  fail(`profile「${profile}」尚未完成 lark-cli 绑定，请先启动 bridge。`);
}
const env = {
  ...process.env,
  LARK_CHANNEL: '1',
  LARK_CHANNEL_HOME: rootDir,
  LARK_CHANNEL_PROFILE: profile,
  LARK_CHANNEL_CONFIG: sourceConfig,
  LARKSUITE_CLI_CONFIG_DIR: cliConfigDir,
};
delete env.LARK_CHANNEL_CHAT_ID;
delete env.LARK_CHANNEL_MESSAGE_ID;
delete env.LARK_CHANNEL_CHAT_TYPE;
delete env.LARK_CHANNEL_THREAD_ID;
delete env.LARK_CHANNEL_ROUTE_FILE;

const ownerId = resolveOwner(env);
if (parsed.check) {
  process.stdout.write(`✓ profile「${profile}」的 Codex→飞书交接路由可用。\n`);
  process.exit(0);
}

const shortId = threadId.slice(0, 8);
const note = parsed.note ? `\n\n${escapeMd(parsed.note)}` : '';
const card = {
  config: { wide_screen_mode: true },
  header: { title: { tag: 'plain_text', content: '📱 Codex 任务交接' } },
  elements: [
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `Codex 请求把任务 \`${shortId}…\` 接到这个飞书私聊。${note}`,
      },
    },
    {
      tag: 'action',
      actions: [{
        tag: 'button',
        text: { tag: 'plain_text', content: '接管到飞书' },
        type: 'primary',
        value: { cmd: 'handoff', arg: threadId },
      }],
    },
  ],
};
runLarkCli(
  [
    'im',
    '+messages-send',
    '--user-id',
    ownerId,
    '--msg-type',
    'interactive',
    '--content',
    JSON.stringify(card),
    '--as',
    'bot',
    '--idempotency-key',
    createHash('sha256').update(`${profile}:${ownerId}:${threadId}`).digest('hex').slice(0, 32),
    '--json',
  ],
  { cwd: process.cwd(), env },
);

function resolveOwner(env) {
  const raw = runLarkCli(
    ['api', 'GET', '/open-apis/application/v6/applications/me', '--params', '{"lang":"zh_cn","user_id_type":"open_id"}', '--as', 'bot', '--json'],
    { cwd: process.cwd(), env, echoStdout: false },
  );
  try {
    const body = JSON.parse(raw);
    const ownerId = body?.data?.app?.owner?.owner_id || body?.data?.app?.creator_id;
    if (typeof ownerId === 'string' && ownerId) return ownerId;
  } catch {
    // concise error below
  }
  fail('无法解析 PersonalAgent owner open_id。');
}

function parseArgs(args) {
  const parsed = { profile: undefined, thread: undefined, note: undefined, check: false, help: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') parsed.help = true;
    else if (arg === '--check') parsed.check = true;
    else if (arg === '--profile') parsed.profile = requiredArg(args, ++index, '--profile');
    else if (arg === '--thread') parsed.thread = requiredArg(args, ++index, '--thread');
    else if (arg === '--note') parsed.note = requiredArg(args, ++index, '--note');
    else fail(`未知参数：${arg}`);
  }
  return parsed;
}

function requiredArg(args, index, flag) {
  const value = args[index];
  if (!value) fail(`${flag} 缺少值。`);
  return value;
}

function readActiveProfile(rootDir) {
  const activeFile = join(rootDir, 'active-profile');
  if (existsSync(activeFile)) {
    const value = readFileSync(activeFile, 'utf8').trim();
    if (value) return value;
  }
  const configFile = join(rootDir, 'config.json');
  if (existsSync(configFile)) {
    const root = JSON.parse(readFileSync(configFile, 'utf8'));
    if (typeof root.activeProfile === 'string' && root.activeProfile.trim()) return root.activeProfile.trim();
  }
  fail('找不到 active profile，请用 --profile 指定。');
}

function validateProfile(profile) {
  if (!profile || /[\u0000-\u001f\s/\\:*?"<>|]/.test(profile) || profile === '.' || profile === '..') {
    fail(`无效 profile 名称：${profile || '(空)'}`);
  }
}

function escapeMd(value) {
  return value.replace(/([*_`\\])/g, '\\$1');
}
