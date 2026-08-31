import type { Readable, Writable } from 'node:stream';
import { mergeProcessEnv, spawnProcess, type SpawnedProcessByStdio } from '../../platform/spawn';
import { log } from '../../core/logger';

type AppServerChild = SpawnedProcessByStdio<Writable, Readable, Readable>;

export interface AppServerMessage {
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

/** Minimal async queue used for app-server notifications and server requests. */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<(value: IteratorResult<T>) => void> = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value: item });
    else this.items.push(item);
  }

  clear(): void {
    this.items.length = 0;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ done: true, value: undefined });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async (): Promise<IteratorResult<T>> => {
        const item = this.items.shift();
        if (item !== undefined) return { done: false, value: item };
        if (this.closed) return { done: true, value: undefined };
        return new Promise<IteratorResult<T>>((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

export class AppServerRpcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppServerRpcError';
  }
}

export interface CodexAppServerClientOptions {
  binary: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  clientName?: string;
}

/** One initialized `codex app-server` stdio transport. */
export class CodexAppServerClient {
  private child: AppServerChild | undefined;
  private buffer = '';
  private nextId = 0;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly messages = new AsyncQueue<AppServerMessage>();
  private closed = false;

  constructor(private readonly options: CodexAppServerClientOptions) {}

  get exited(): boolean {
    return !this.child || this.child.exitCode !== null || this.child.signalCode !== null;
  }

  async connect(): Promise<void> {
    if (this.child && !this.exited) return;
    this.closed = false;
    const child = spawnProcess(
      this.options.binary,
      ['app-server', '--listen', 'stdio://'],
      {
        cwd: this.options.cwd,
        env: mergeProcessEnv(process.env, this.options.env ?? {}),
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    ) as AppServerChild;
    this.child = child;
    log.info('app-server', 'spawn', { pid: child.pid ?? null, cwd: this.options.cwd });

    child.stdout.on('data', (chunk: Buffer) => this.onStdout(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      const line = chunk.toString('utf8').trim();
      if (line) log.warn('app-server', 'stderr', { line: line.slice(0, 1000) });
    });
    child.once('error', (error) => this.fail(error));
    child.once('exit', (code, signal) => {
      log.info('app-server', 'exit', { pid: child.pid ?? null, code, signal });
      this.fail(new Error(`codex app-server exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`));
    });
    child.stdin.on('error', (error) => this.fail(error));

    await this.request('initialize', {
      clientInfo: {
        name: this.options.clientName ?? 'comers',
        title: 'Comers',
        version: '0.8.0',
      },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.notify('initialized', {});
  }

  request<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    const child = this.child;
    if (this.closed || !child || this.exited) {
      return Promise.reject(new Error('codex app-server transport is closed'));
    }
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`,
        'utf8',
        (error?: Error | null) => {
          if (!error) return;
          this.pending.delete(id);
          reject(error);
        },
      );
    });
  }

  notify(method: string, params: unknown = {}): void {
    if (this.closed || !this.child || this.exited) return;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  respond(id: string | number, result: unknown): void {
    if (this.closed || !this.child || this.exited) return;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
  }

  respondError(id: string | number, message: string, code = -32601): void {
    if (this.closed || !this.child || this.exited) return;
    this.child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`,
    );
  }

  stream(): AsyncIterable<AppServerMessage> {
    return this.messages;
  }

  clearMessages(): void {
    this.messages.clear();
  }

  async close(graceMs = 4000): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const child = this.child;
    this.failAll(new Error('codex app-server transport closed'));
    this.messages.close();
    if (!child || this.exited) return;
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        resolve();
      }, graceMs);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private onStdout(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8');
    let newline = this.buffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.handleLine(line);
      newline = this.buffer.indexOf('\n');
    }
  }

  private handleLine(line: string): void {
    let message: AppServerMessage;
    try {
      message = JSON.parse(line) as AppServerMessage;
    } catch {
      log.warn('app-server', 'non-json', { line: line.slice(0, 500) });
      return;
    }
    if (typeof message.id === 'number' && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new AppServerRpcError(rpcErrorMessage(message.error)));
      else pending.resolve(message.result);
      return;
    }
    if (message.method) this.messages.push(message);
  }

  private fail(error: Error): void {
    if (!this.closed) this.closed = true;
    this.failAll(error);
    this.messages.close();
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

function rpcErrorMessage(value: unknown): string {
  if (value && typeof value === 'object' && typeof (value as { message?: unknown }).message === 'string') {
    return (value as { message: string }).message;
  }
  return String(value);
}
