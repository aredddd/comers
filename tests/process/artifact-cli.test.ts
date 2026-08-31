import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const cli = join(process.cwd(), 'bin', 'lark-channel-artifact.mjs');
const sendCli = join(process.cwd(), 'bin', 'lark-channel-send.mjs');

describe('lark-channel-artifact', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('replies with a cwd-relative file to the bridge-bound message route', async () => {
    const fixture = await createFixture();
    cleanup.push(fixture.dir);
    await mkdir(join(fixture.workspace, 'outputs'));
    await writeFile(join(fixture.workspace, 'outputs', 'report.pdf'), 'pdf-data');

    const result = spawnSync(process.execPath, [cli, './outputs/report.pdf'], {
      cwd: fixture.workspace,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fixture.binDir}${delimiter}${process.env.PATH ?? ''}`,
        LARK_CHANNEL: '1',
        LARK_CHANNEL_CHAT_ID: 'oc_current',
        LARK_CHANNEL_MESSAGE_ID: 'om_trigger',
        LARK_CHANNEL_CHAT_TYPE: 'group',
        LARK_CHANNEL_THREAD_ID: 'omt_topic',
        ARTIFACT_TEST_RECORD: fixture.record,
      },
    });

    expect(result.status).toBe(0);
    const records = JSON.parse(await readFile(fixture.record, 'utf8')) as string[][];
    const args = records[0] ?? [];
    expect(args.slice(0, 7)).toEqual([
      'im',
      '+messages-reply',
      '--message-id',
      'om_trigger',
      '--file',
      './outputs/report.pdf',
      '--as',
    ]);
    expect(args).toContain('bot');
    expect(args).toContain('--idempotency-key');
    expect(args).toContain('--reply-in-thread');
    expect(args).not.toContain('oc_current');
  });

  it('rejects files outside the current workspace before calling lark-cli', async () => {
    const fixture = await createFixture();
    cleanup.push(fixture.dir);
    const outside = join(fixture.dir, 'outside.txt');
    await writeFile(outside, 'private');

    const result = spawnSync(process.execPath, [cli, '../outside.txt'], {
      cwd: fixture.workspace,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fixture.binDir}${delimiter}${process.env.PATH ?? ''}`,
        LARK_CHANNEL: '1',
        LARK_CHANNEL_MESSAGE_ID: 'om_trigger',
        ARTIFACT_TEST_RECORD: fixture.record,
      },
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('文件必须位于当前工作目录内');
    await expect(readFile(fixture.record, 'utf8')).rejects.toThrow();
  });

  it('refuses to guess a recipient outside a bridge-triggered run', async () => {
    const fixture = await createFixture();
    cleanup.push(fixture.dir);
    await writeFile(join(fixture.workspace, 'report.txt'), 'result');

    const result = spawnSync(process.execPath, [cli, './report.txt'], {
      cwd: fixture.workspace,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fixture.binDir}${delimiter}${process.env.PATH ?? ''}`,
        LARK_CHANNEL: '0',
        ARTIFACT_TEST_RECORD: fixture.record,
      },
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('拒绝猜测飞书收件人');
  });

  it('sends from a local Codex run only to the selected PersonalAgent owner', async () => {
    const fixture = await createFixture();
    cleanup.push(fixture.dir);
    const channelHome = join(fixture.dir, 'channel-home');
    const profileDir = join(channelHome, 'profiles', 'codex');
    await mkdir(join(profileDir, 'lark-cli-source'), { recursive: true });
    await mkdir(join(profileDir, 'lark-cli'), { recursive: true });
    await writeFile(join(profileDir, 'lark-cli-source', 'config.json'), '{}');
    await writeFile(join(channelHome, 'active-profile'), 'codex\n');
    await writeFile(join(fixture.workspace, 'result.zip'), 'zip-data');

    const result = spawnSync(process.execPath, [sendCli, './result.zip'], {
      cwd: fixture.workspace,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fixture.binDir}${delimiter}${process.env.PATH ?? ''}`,
        LARK_CHANNEL_HOME: channelHome,
        ARTIFACT_TEST_RECORD: fixture.record,
      },
    });

    expect(result.status).toBe(0);
    const records = JSON.parse(await readFile(fixture.record, 'utf8')) as string[][];
    expect(records).toHaveLength(2);
    expect(records[0]).toEqual([
      'api',
      'GET',
      '/open-apis/application/v6/applications/me',
      '--params',
      '{"lang":"zh_cn","user_id_type":"open_id"}',
      '--as',
      'bot',
      '--json',
    ]);
    expect(records[1]).toContain('--user-id');
    expect(records[1]).toContain('ou_owner');
    expect(records[1]).toContain('./result.zip');
  });

  it('checks the active owner route without sending a message', async () => {
    const fixture = await createFixture();
    cleanup.push(fixture.dir);
    const channelHome = join(fixture.dir, 'channel-home');
    const profileDir = join(channelHome, 'profiles', 'codex');
    await mkdir(join(profileDir, 'lark-cli-source'), { recursive: true });
    await mkdir(join(profileDir, 'lark-cli'), { recursive: true });
    await writeFile(join(profileDir, 'lark-cli-source', 'config.json'), '{}');
    await writeFile(join(channelHome, 'active-profile'), 'codex\n');

    const result = spawnSync(process.execPath, [sendCli, '--profile', 'codex', '--check'], {
      cwd: fixture.workspace,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fixture.binDir}${delimiter}${process.env.PATH ?? ''}`,
        LARK_CHANNEL_HOME: channelHome,
        ARTIFACT_TEST_RECORD: fixture.record,
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('owner 路由可用');
    const records = JSON.parse(await readFile(fixture.record, 'utf8')) as string[][];
    expect(records).toHaveLength(1);
    expect(records[0]?.slice(0, 3)).toEqual([
      'api',
      'GET',
      '/open-apis/application/v6/applications/me',
    ]);
  });
});

async function createFixture(): Promise<{
  dir: string;
  workspace: string;
  binDir: string;
  record: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'lark-artifact-test-'));
  const workspace = join(dir, 'workspace');
  const binDir = join(dir, 'bin');
  const record = join(dir, 'lark-cli-argv.json');
  await mkdir(workspace);
  await mkdir(binDir);

  const fakeScript = join(binDir, 'fake-lark-cli.mjs');
  await writeFile(
    fakeScript,
    `import { existsSync, readFileSync, writeFileSync } from 'node:fs';\nconst args = process.argv.slice(2);\nconst path = process.env.ARTIFACT_TEST_RECORD;\nconst records = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : [];\nrecords.push(args);\nwriteFileSync(path, JSON.stringify(records));\nif (args[0] === 'api') process.stdout.write('{"code":0,"data":{"app":{"owner":{"owner_id":"ou_owner"}}}}\\n');\nelse process.stdout.write('{"ok":true}\\n');\n`,
  );
  if (process.platform === 'win32') {
    await writeFile(join(binDir, 'lark-cli.cmd'), `@"${process.execPath}" "${fakeScript}" %*\r\n`);
  } else {
    const shim = join(binDir, 'lark-cli');
    await writeFile(shim, `#!/bin/sh\nexec "${process.execPath}" "${fakeScript}" "$@"\n`);
    await chmod(shim, 0o755);
  }
  return { dir, workspace, binDir, record };
}
