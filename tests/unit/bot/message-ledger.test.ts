import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MessageLedger } from '../../../src/bot/message-ledger.js';

describe('MessageLedger', () => {
  const cleanup: string[] = [];
  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it('deduplicates immediately and restores unfinished normalized messages after restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bridge-message-ledger-'));
    cleanup.push(dir);
    const path = join(dir, 'ledger.json');
    const message = {
      messageId: 'om_1',
      chatId: 'oc_1',
      chatType: 'p2p' as const,
      senderId: 'ou_owner',
      content: '继续任务',
      rawContentType: 'text',
      resources: [],
      mentions: [],
      mentionAll: false,
      mentionedBot: true,
      createTime: Date.now(),
    };
    const first = new MessageLedger(path);
    expect(first.claim(message)).toBe(true);
    expect(first.claim(message)).toBe(false);
    first.markQueued(message.messageId);
    await first.flush();

    const second = new MessageLedger(path);
    await second.load();
    expect(second.recoverable()).toEqual([message]);
    second.markDone(message.messageId);
    await second.flush();

    const third = new MessageLedger(path);
    await third.load();
    expect(third.recoverable()).toEqual([]);
    expect(third.claim(message)).toBe(false);
  });

  it('never prunes unfinished recovery entries when terminal dedup history exceeds its cap', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bridge-message-ledger-cap-'));
    cleanup.push(dir);
    const path = join(dir, 'ledger.json');
    const message = {
      messageId: 'om_unfinished',
      chatId: 'oc_1',
      chatType: 'p2p' as const,
      senderId: 'ou_owner',
      content: '必须恢复',
      rawContentType: 'text',
      resources: [],
      mentions: [],
      mentionAll: false,
      mentionedBot: true,
      createTime: Date.now(),
    };
    const done = Array.from({ length: 2100 }, (_, index) => ({
      messageId: `om_done_${index}`,
      status: 'done',
      updatedAt: Date.now() - index,
    }));
    await writeFile(path, JSON.stringify([
      ...done,
      { messageId: message.messageId, status: 'queued', updatedAt: Date.now(), message },
    ]));

    const ledger = new MessageLedger(path);
    await ledger.load();
    expect(ledger.recoverable()).toEqual([message]);
  });
});
