import { createServer, type Server } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { writeFileAtomic } from '../platform/atomic-write';
import { InboxReview, type ReviewInput } from './review';
import { InboxStore } from './store';
import { codeSnapshot } from './workspace';
import { record, text } from './cli-client';
import { join } from 'node:path';
import { REVIEW_HTML } from './view';

export async function startInboxServer(store: InboxStore, stateDir: string, port = 0): Promise<{ server: Server; url: string }> {
  const token = randomBytes(32).toString('hex');
  const review = new InboxReview(store, stateDir);
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(REVIEW_HTML); return;
    }
    const supplied = text(req.headers['x-inbox-token']);
    const suppliedBytes = Buffer.from(supplied); const tokenBytes = Buffer.from(token);
    if (suppliedBytes.length !== tokenBytes.length || !timingSafeEqual(suppliedBytes, tokenBytes)) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.writeHead(403); res.end(JSON.stringify({ error: '拒绝访问，请重新打开本机审阅地址' })); return;
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    try {
      if (req.method === 'GET' && url.pathname === '/api/state') {
        res.end(JSON.stringify(store.snapshot())); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/code') {
        const item = store.snapshot().items.find((row) => row.id === url.searchParams.get('itemId'));
        if (!item?.worktree) throw new Error('代码工作区不存在');
        res.end(JSON.stringify(await codeSnapshot(item.worktree))); return;
      }
      if (req.method !== 'POST' || !url.pathname.startsWith('/api/')) { res.writeHead(404); res.end('{}'); return; }
      let body = '';
      for await (const chunk of req) {
        body += String(chunk);
        if (body.length > 512_000) throw new Error('请求内容过长');
      }
      const raw = record(JSON.parse(body));
      const input: ReviewInput = { itemId: text(raw.itemId), artifactId: text(raw.artifactId) || undefined,
        revision: Number(raw.revision), body: typeof raw.body === 'string' ? raw.body : undefined };
      const action = url.pathname.slice('/api/'.length);
      if (action === 'send') await review.send(input);
      else if (action === 'publish-mr') await review.publishDraftMr(input);
      else if (['approve', 'reject', 'edit', 'retry'].includes(action)) await review.update(input, action as 'approve' | 'reject' | 'edit' | 'retry');
      else throw new Error('不支持的操作');
      res.end(JSON.stringify({ ok: true }));
    } catch (error) {
      res.writeHead(409);
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : '操作失败' }));
    }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); }); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('收件箱控制台端口无效');
  const url = `http://127.0.0.1:${address.port}/#${token}`;
  await writeFileAtomic(join(stateDir, 'console.json'), JSON.stringify({ url, pid: process.pid }), { mode: 0o600 });
  return { server, url };
}
