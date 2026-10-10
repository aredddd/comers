import { spawnProcess } from '../platform/spawn';

export class InboxCliError extends Error {
  constructor(readonly kind: 'auth' | 'rate_limit' | 'incomplete' | 'failure',
    message: string, readonly retryAfterMs?: number) { super(message); }
}
export type JsonCli = (binary: string, args: string[]) => Promise<unknown>;

/** No shell interpolation, bounded output/time, and no raw stderr/body logging. */
export const runJsonCli: JsonCli = async (binary, args) => {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(binary, args, { stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' } });
    let stdout = ''; let stderr = ''; let overflow = false;
    const timer = setTimeout(() => child.kill('SIGTERM'), 45_000);
    child.stdout!.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.length > 8_000_000) { overflow = true; child.kill('SIGTERM'); }
    });
    child.stderr!.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-16_000); });
    child.once('error', () => { clearTimeout(timer); reject(new InboxCliError('failure', `${binary} 无法启动`)); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (overflow) { reject(new InboxCliError('incomplete', '响应超过容量，未推进游标')); return; }
      let value: unknown;
      try { value = JSON.parse(stdout); } catch { reject(new InboxCliError('failure', `${binary} 未返回完整 JSON`)); return; }
      const row = record(value);
      const failed = code !== 0 || row.ok === false || Boolean(row.error) ||
        (row.code !== undefined && row.code !== 0 && row.code !== '0') ||
        (row.err_code !== undefined && row.err_code !== 0 && row.err_code !== '0');
      if (failed) {
        const diagnostic = `${stderr} ${JSON.stringify(row.error ?? {})}`;
        const limited = /9999140[01]|429|rate.?limit|too many requests|频控|限流/i.test(diagnostic);
        const auth = /999916|999917|401|403|unauth|permission|scope|token.*expir|登录|授权/i.test(diagnostic);
        reject(new InboxCliError(limited ? 'rate_limit' : auth ? 'auth' : 'failure',
          limited ? '接口限流，正在退避' : auth ? 'CLI 身份或权限需要重新授权' : `${binary} 查询失败，未推进游标`));
        return;
      }
      if (row.complete === false || row.truncated === true || (Array.isArray(row.errors) && row.errors.length)) {
        reject(new InboxCliError('incomplete', '接口结果不完整，未推进游标')); return;
      }
      resolve(value);
    });
  });
};
export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function data(value: unknown): Record<string, unknown> {
  const row = record(value); return row.data === undefined ? row : record(row.data);
}
export function text(value: unknown): string { return value === undefined || value === null ? '' : String(value); }
