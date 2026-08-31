import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import crossSpawn from 'cross-spawn';

export function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) fail(`缺少 ${name}，当前 run 没有可用的飞书消息路由。`);
  return value;
}

/** App-server processes are intentionally long-lived, so their environment
 * cannot carry a different triggering message id on every turn. The bridge
 * atomically refreshes this route file immediately before `turn/start`. */
export function currentDeliveryRoute() {
  const routeFile = process.env.LARK_CHANNEL_ROUTE_FILE?.trim();
  if (!routeFile) return undefined;
  try {
    const route = JSON.parse(readFileSync(routeFile, 'utf8'));
    if (!route || typeof route !== 'object') return undefined;
    return {
      chatId: typeof route.chatId === 'string' ? route.chatId : undefined,
      messageId: typeof route.messageId === 'string' ? route.messageId : undefined,
      chatType: typeof route.chatType === 'string' ? route.chatType : undefined,
      threadId: typeof route.threadId === 'string' ? route.threadId : undefined,
    };
  } catch {
    fail('无法读取当前 run 的飞书消息路由。');
  }
}

export function resolveArtifacts(cwd, inputs) {
  return inputs.map((input) => resolveArtifact(cwd, input));
}

export function buildIdempotencyKey(routeKey, file) {
  const stat = statSync(file.absolute);
  return createHash('sha256')
    .update(`${routeKey}\0${file.relative}\0${stat.size}\0${stat.mtimeMs}`)
    .digest('hex')
    .slice(0, 32);
}

export function runLarkCli(args, options) {
  const result = crossSpawn.sync('lark-cli', args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) fail(`无法启动 lark-cli: ${result.error.message}`);
  if (options.echoStdout !== false && result.stdout) process.stdout.write(result.stdout);
  if (result.status !== 0) {
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
  return result.stdout ?? '';
}

export function fail(message) {
  process.stderr.write(`lark-channel: ${message}\n`);
  process.exit(2);
}

function resolveArtifact(cwd, input) {
  if (!input || input.startsWith('-')) fail(`无效文件路径: ${input || '(空)'}`);
  if (isAbsolute(input)) fail(`只接受当前工作目录内的相对路径: ${input}`);

  const candidate = resolve(cwd, input);
  if (!existsSync(candidate)) fail(`文件不存在: ${input}`);
  const absolute = realpathSync(candidate);
  const rel = relative(cwd, absolute);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    fail(`文件必须位于当前工作目录内: ${input}`);
  }
  if (!statSync(absolute).isFile()) fail(`不是普通文件: ${input}`);
  return { absolute, relative: `./${rel.split(sep).join('/')}` };
}
