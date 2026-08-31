#!/usr/bin/env node

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  buildIdempotencyKey,
  fail,
  resolveArtifacts,
  runLarkCli,
} from './artifact-common.mjs';

const HELP = `通过 comers 的 PersonalAgent bot，把本地产物主动发给应用 owner。

用法:
  lark-channel-send [--profile <名称>] <相对文件路径> [更多相对文件路径...]
  lark-channel-send [--profile <名称>] --check

说明:
  - 适用于普通 Codex 桌面/CLI 会话，不要求由飞书消息触发
  - 收件人固定为所选 PersonalAgent 应用的 owner，不接受 user_id/chat_id
  - 文件必须位于当前工作目录内
`;

const parsed = parseArgs(process.argv.slice(2));
if (parsed.help) {
  process.stdout.write(HELP);
  process.exit(0);
}
if (!parsed.check && parsed.files.length === 0) fail('至少需要一个相对文件路径。\n\n' + HELP);

const cwd = realpathSync(process.cwd());
const rootDir = process.env.LARK_CHANNEL_HOME || join(homedir(), '.lark-channel');
const profile = parsed.profile || readActiveProfile(rootDir);
validateProfile(profile);

const profileDir = join(rootDir, 'profiles', profile);
const sourceConfig = join(profileDir, 'lark-cli-source', 'config.json');
const cliConfigDir = join(profileDir, 'lark-cli');
if (!existsSync(sourceConfig)) {
  fail(`profile「${profile}」尚未完成 lark-cli 绑定，请先启动 bridge 并运行 doctor/preflight。`);
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

const appInfoRaw = runLarkCli(
  [
    'api',
    'GET',
    '/open-apis/application/v6/applications/me',
    '--params',
    '{"lang":"zh_cn","user_id_type":"open_id"}',
    '--as',
    'bot',
    '--json',
  ],
  { cwd, env, echoStdout: false },
);
const ownerId = parseOwnerId(appInfoRaw);
if (parsed.check) {
  process.stdout.write(`✓ profile「${profile}」的 PersonalAgent owner 路由可用。\n`);
  process.exit(0);
}
const files = resolveArtifacts(cwd, parsed.files);

for (const file of files) {
  runLarkCli(
    [
      'im',
      '+messages-send',
      '--user-id',
      ownerId,
      '--file',
      file.relative,
      '--as',
      'bot',
      '--idempotency-key',
      buildIdempotencyKey(`${profile}:${ownerId}`, file),
      '--json',
    ],
    { cwd, env },
  );
}

function parseArgs(args) {
  const files = [];
  let profile;
  let check = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') return { files, profile, check, help: true };
    if (arg === '--check') {
      check = true;
      continue;
    }
    if (arg === '--profile') {
      profile = args[++i];
      if (!profile) fail('--profile 缺少名称。');
      continue;
    }
    files.push(arg);
  }
  if (check && files.length > 0) fail('--check 不能和文件路径同时使用。');
  return { files, profile, check, help: false };
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
    if (typeof root.activeProfile === 'string' && root.activeProfile.trim()) {
      return root.activeProfile.trim();
    }
  }
  fail('找不到 active profile，请先运行 comers start --profile codex --agent codex。');
}

function validateProfile(profile) {
  if (
    !profile ||
    /[\u0000-\u001f\s/\\:*?"<>|]/.test(profile) ||
    profile === '.' ||
    profile === '..'
  ) {
    fail(`无效 profile 名称: ${profile || '(空)'}`);
  }
}

function parseOwnerId(raw) {
  try {
    const body = JSON.parse(raw);
    const ownerId = body?.data?.app?.owner?.owner_id || body?.data?.app?.creator_id;
    if (typeof ownerId === 'string' && ownerId) return ownerId;
  } catch {
    // Fall through to a concise user-facing error without echoing raw API data.
  }
  fail('无法从应用信息中解析 owner open_id，请确认应用有 application:application:self_manage 权限。');
}
