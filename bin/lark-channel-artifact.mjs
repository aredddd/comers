#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import {
  buildIdempotencyKey,
  currentDeliveryRoute,
  fail,
  requiredEnv,
  resolveArtifacts,
  runLarkCli,
} from './artifact-common.mjs';

const HELP = `把当前 Codex/Claude run 生成的文件回复到触发它的飞书消息。

用法:
  lark-channel-artifact <相对文件路径> [更多相对文件路径...]

限制:
  - 只能在 comers 启动的 agent 子进程中使用
  - 文件必须位于当前工作目录内
  - 收件会话由 bridge 注入，命令不接受 chat_id/message_id 参数
`;

const inputPaths = process.argv.slice(2);
if (inputPaths.includes('--help') || inputPaths.includes('-h')) {
  process.stdout.write(HELP);
  process.exit(0);
}
if (inputPaths.length === 0) fail('至少需要一个相对文件路径。\n\n' + HELP);
if (process.env.LARK_CHANNEL !== '1') {
  fail('当前不在 comers run 中，拒绝猜测飞书收件人。');
}

const route = currentDeliveryRoute();
const messageId = route?.messageId || requiredEnv('LARK_CHANNEL_MESSAGE_ID');
const cwd = realpathSync(process.cwd());
const files = resolveArtifacts(cwd, inputPaths);

for (const file of files) {
  const args = [
    'im',
    '+messages-reply',
    '--message-id',
    messageId,
    '--file',
    file.relative,
    '--as',
    'bot',
    '--idempotency-key',
    buildIdempotencyKey(messageId, file),
    '--json',
  ];
  if (route?.threadId || process.env.LARK_CHANNEL_THREAD_ID) args.push('--reply-in-thread');
  runLarkCli(args, { cwd, env: process.env });
}
