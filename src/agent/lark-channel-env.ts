import { join } from 'node:path';
import type { AgentDeliveryContext } from './types';

export interface LarkChannelEnvContext {
  profile?: string;
  rootDir?: string;
  configPath?: string;
  larkCliConfigDir?: string;
  larkCliSourceConfigFile?: string;
}

export function buildLarkChannelEnv(
  context?: LarkChannelEnvContext,
  delivery?: AgentDeliveryContext,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    LARK_CHANNEL: '1',
    // Keep these keys present even when unset. mergeProcessEnv then removes
    // stale route values inherited from a parent bridge process.
    LARK_CHANNEL_CHAT_ID: undefined,
    LARK_CHANNEL_MESSAGE_ID: undefined,
    LARK_CHANNEL_CHAT_TYPE: undefined,
    LARK_CHANNEL_THREAD_ID: undefined,
    LARK_CHANNEL_ROUTE_FILE: undefined,
  };
  const profile = nonEmpty(context?.profile);
  if (profile) env.LARK_CHANNEL_PROFILE = profile;

  const rootDir = nonEmpty(context?.rootDir);
  if (rootDir) env.LARK_CHANNEL_HOME = rootDir;

  const configPath =
    nonEmpty(context?.larkCliSourceConfigFile) ??
    nonEmpty(context?.configPath) ??
    (rootDir ? join(rootDir, 'config.json') : undefined);
  if (configPath) env.LARK_CHANNEL_CONFIG = configPath;

  const larkCliConfigDir = nonEmpty(context?.larkCliConfigDir);
  if (larkCliConfigDir) env.LARKSUITE_CLI_CONFIG_DIR = larkCliConfigDir;

  if (delivery) {
    env.LARK_CHANNEL_CHAT_ID = delivery.chatId;
    env.LARK_CHANNEL_MESSAGE_ID = delivery.messageId;
    env.LARK_CHANNEL_CHAT_TYPE = delivery.chatType;
    if (delivery.threadId) env.LARK_CHANNEL_THREAD_ID = delivery.threadId;
  }

  return env;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? value : undefined;
}
