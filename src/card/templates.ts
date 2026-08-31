import type { CodexThreadDetail } from '../session/codex-history';

interface ButtonSpec {
  text: string;
  value: Record<string, unknown>;
  style?: 'primary' | 'danger' | 'default';
  disabled?: boolean;
}

function button(spec: ButtonSpec): object {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: spec.text },
    type: spec.style ?? 'default',
    value: spec.value,
    ...(spec.disabled ? { disabled: true } : {}),
  };
}

function divMd(content: string): object {
  return { tag: 'div', text: { tag: 'lark_md', content } };
}

function actions(buttons: ButtonSpec[]): object {
  return { tag: 'action', actions: buttons.map(button) };
}

const HR: object = { tag: 'hr' };

function shell(title: string, elements: object[]): object {
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: { title: { tag: 'plain_text', content: title } },
    elements,
  };
}

export function workspacesCard(current: string | undefined, named: Record<string, string>): object {
  const entries = Object.entries(named);
  const elements: object[] = [];

  elements.push(divMd(`当前 cwd：\`${escapeCode(current ?? '(未设置)')}\``));

  if (entries.length === 0) {
    elements.push(HR);
    elements.push(divMd('暂无命名工作目录。'));
    elements.push(
      divMd('💡 发送 `/ws save <name>` 把当前 cwd 存为命名工作目录'),
    );
  } else {
    elements.push(HR);
    entries.forEach(([name, path], i) => {
      const marker = path === current ? '  ← 当前' : '';
      elements.push(divMd(`**${escapeMd(name)}** → \`${escapeCode(path)}\`${marker}`));
      elements.push(
        actions([
          { text: '切换到此处', value: { cmd: 'ws.use', name }, style: 'primary' },
          { text: '删除', value: { cmd: 'ws.remove', name }, style: 'danger' },
        ]),
      );
      if (i < entries.length - 1) elements.push(HR);
    });
  }

  return shell('📂 工作目录', elements);
}

export interface StatusInfo {
  profileName: string;
  cwd?: string;
  sessionId?: string;
  sessionTitle?: string;
  emptySessionText?: string;
  sessionStale: boolean;
  agentName: string;
  runtimeAccess: {
    label: string;
    value: string;
  };
  larkCliStatus?: 'app' | 'user-ready' | 'user-missing' | 'check-failed';
  activeRun: boolean;
  activeScopes?: string[];
  activeCommentScopes?: string[];
  queue?: { active: number; waiting: number; cap: number };
  ownerState: string;
  /** Session scope (= chatId or chatId:threadId in topic groups). */
  scope: string;
  /** Chat mode — used to label scope. */
  chatMode: 'p2p' | 'group' | 'topic';
}

export function statusCard(info: StatusInfo): object {
  const sessionLine = info.sessionId
    ? `\`${info.sessionId.slice(0, 8)}…\`${info.sessionStale ? ' ⚠️ 旧 cwd，下一条会新建' : ''}`
    : (info.emptySessionText ?? '(无)');
  // For topic groups, surface that the scope is per-topic so the user
  // knows /cd / /new only affect this topic.
  const scopeLine =
    info.chatMode === 'topic'
      ? `\`${escapeCode(info.scope)}\` _（话题独立 session）_`
      : `\`${escapeCode(info.scope)}\``;
  const cwdLine = info.cwd ? `\`${escapeCode(info.cwd)}\`` : '(未设置)';
  const queueLine = info.queue
    ? `${info.queue.active}/${info.queue.cap} active, ${info.queue.waiting} waiting`
    : 'unknown';
  const lines = [
    `🧭 **scope**: ${scopeLine}`,
    `🧩 **profile**: ${escapeMd(info.profileName)}`,
    `📁 **cwd**: ${cwdLine}`,
    `🔗 **session**: ${sessionLine}`,
    ...(info.sessionTitle ? [`📝 **任务**: ${escapeMd(info.sessionTitle)}`] : []),
    `🤖 **agent**: ${escapeMd(info.agentName)}`,
    `🛡 **${escapeMd(info.runtimeAccess.label)}**: ${escapeMd(info.runtimeAccess.value)}`,
    ...(info.larkCliStatus ? [`🔐 **lark-cli**: ${info.larkCliStatus}`] : []),
    `🏃 **active run**: ${info.activeRun ? 'yes' : 'no'}`,
    ...(info.activeScopes && info.activeScopes.length > 0
      ? [
          `🏃 **active scopes**: ${info.activeScopes.map((scope) => `\`${escapeCode(scope)}\``).join(', ')}`,
        ]
      : []),
    ...(info.activeCommentScopes && info.activeCommentScopes.length > 0
      ? [
          `📝 **comment runs**: ${info.activeCommentScopes.map((scope) => `\`${escapeCode(scope)}\``).join(', ')}`,
        ]
      : []),
    `🚦 **queue**: ${queueLine}`,
    `👤 **owner API**: ${escapeMd(info.ownerState)}`,
  ];
  return shell('📊 当前状态', [
    divMd(lines.join('\n')),
    HR,
    actions([
      { text: '🆕 新会话', value: { cmd: 'new' }, style: 'primary' },
      { text: '🔁 恢复会话', value: { cmd: 'resume' } },
      { text: '📂 工作目录', value: { cmd: 'ws.list' } },
      { text: '💡 帮助', value: { cmd: 'help' } },
    ]),
  ]);
}

export interface ResumeEntry {
  sessionId: string;
  displayId?: string;
  preview: string;
  relTime: string;
  lineCount?: number;
  detail?: string;
  workspace?: string;
  current?: boolean;
  disabledReason?: string;
}

export interface ResumeCardOptions {
  globalCodex?: boolean;
  query?: string;
  nextPageArg?: string;
}

export function resumeCard(
  cwd: string | undefined,
  entries: ResumeEntry[],
  options: ResumeCardOptions = {},
): object {
  const elements: object[] = [];
  if (options.globalCodex) {
    elements.push(divMd('范围：**本机 Codex 已有任务（跨项目）**'));
    elements.push(divMd(`当前工作目录：\`${escapeCode(cwd ?? '(未设置)')}\``));
    if (options.query) {
      elements.push(divMd(`搜索：**${escapeMd(options.query)}**`));
    }
  } else {
    elements.push(divMd(`当前 cwd：\`${escapeCode(cwd ?? '(未设置)')}\``));
  }

  if (entries.length === 0) {
    elements.push(HR);
    elements.push(
      divMd(options.globalCodex ? '没有找到匹配的 Codex 任务。' : '此 cwd 下没有历史会话。'),
    );
    return shell(options.globalCodex ? '🧭 Codex 任务' : '🔁 恢复历史会话', elements);
  }

  elements.push(HR);
  entries.forEach((e, i) => {
    const marker = e.current ? '  ← 当前' : '';
    const detail = e.detail ?? `${e.lineCount ?? 0} 条`;
    const displayId = e.displayId ?? e.sessionId;
    const workspace = e.workspace
      ? `\n📁 \`${escapeCode(e.workspace)}\``
      : '';
    const disabled = e.disabledReason
      ? `\n⚠️ ${escapeMd(e.disabledReason)}`
      : '';
    elements.push(
      divMd(
        `**${i + 1}.** ${escapeMd(e.preview)}${marker}\n\`${displayId.slice(0, 8)}…\` · ${e.relTime} · ${escapeMd(detail)}${workspace}${disabled}`,
      ),
    );
    elements.push(
      actions([
        {
          text: e.current
            ? '已是当前任务'
            : e.disabledReason
              ? '当前不可继续'
              : '▸ 继续此任务',
          value: { cmd: 'resume.use', arg: e.sessionId },
          style: e.current || e.disabledReason ? 'default' : 'primary',
          ...(e.disabledReason ? { disabled: true } : {}),
        },
      ]),
    );
    if (i < entries.length - 1) elements.push(HR);
  });

  if (options.nextPageArg) {
    elements.push(HR);
    elements.push(
      actions([
        {
          text: '下一页 ›',
          value: { cmd: 'resume.more', arg: options.nextPageArg },
          style: 'primary',
        },
      ]),
    );
  }

  return shell(options.globalCodex ? '🧭 Codex 任务' : '🔁 恢复历史会话', elements);
}

export function taskCard(task: CodexThreadDetail): object {
  const title = task.name || task.preview || '(空任务)';
  const turns = task.turns.slice(-8);
  const elements: object[] = [
    divMd(
      [
        `**${escapeMd(title)}**`,
        `ID：\`${escapeCode(task.threadId)}\``,
        `目录：\`${escapeCode(task.cwd)}\``,
        task.gitBranch ? `分支：\`${escapeCode(task.gitBranch)}\`` : '',
        `来源：${escapeMd(task.source)} · 状态：${escapeMd(task.status)}${task.isPinned ? ' · 📌 已置顶' : ''}`,
      ].filter(Boolean).join('\n'),
    ),
  ];
  if (turns.length > 0) {
    elements.push(HR, divMd('**最近对话**'));
    turns.forEach((turn, index) => {
      const user = truncateLine(turn.userText ?? '(无用户文本)', 280);
      const assistant = truncateLine(turn.assistantText ?? '(无回复文本)', 500);
      const tools = turn.tools.length ? `\n🧰 ${turn.tools.map(escapeMd).join('、')}` : '';
      elements.push(
        divMd(
          `**${index + 1}. 你**：${escapeMd(user)}\n**Codex**：${escapeMd(assistant)}${tools}`,
        ),
      );
      if (index < turns.length - 1) elements.push(HR);
    });
  } else {
    elements.push(HR, divMd('暂无可显示的 turn 历史。'));
  }
  elements.push(
    HR,
    actions([
      {
        text: task.isPinned ? '取消置顶' : '📌 置顶',
        value: { cmd: task.isPinned ? 'task.unpin' : 'task.pin' },
        style: task.isPinned ? 'default' : 'primary',
      },
      { text: '🗄️ 归档…', value: { cmd: 'task.archive' }, style: 'danger' },
      { text: '刷新', value: { cmd: 'task' } },
    ]),
  );
  return shell('🧭 Codex 任务详情', elements);
}

export function helpCard(agentName = 'Agent'): object {
  const escapedAgentName = escapeMd(agentName);
  return shell('💡 使用帮助', [
    divMd(
      [
        '**命令列表**',
        '',
        '- `/new` `/reset` — 清空当前 chat 的会话',
        '- `/new chat [name]` — 新建群+新会话，自动拉你进群',
        '- `/resume [N]` — Codex 跨项目列出本机已有任务（最多 N 条）',
        '- `/resume search <关键词>` — 按 Codex 任务标题搜索',
        '- `/task` — 查看当前 Codex 任务详情与最近 turn',
        '- `/pin [on|off]` — 置顶/取消置顶当前 Codex 任务',
        '- `/archive` — 二次确认后归档当前 Codex 任务',
        '- `/handoff <thread-id>` — 把桌面/CLI Codex 任务接到当前私聊',
        '- `/cron help` — 创建、暂停、恢复和立即运行持久化定时任务',
        '- `/cd <path>` — 切换工作目录（会重置 session）',
        '- `/ws list|save <name>|use <name>|remove <name>` — 工作目录',
        '- `/account` — 查看当前应用；`/account change` 换 appId/secret 并重连',
        '- `/config` — 调整偏好、访问控制和 lark-cli 身份策略',
        '- `/status` — 当前状态',
        '- `/stop` — 结束当前正在跑的任务（也可点卡片底部 ⏹ 终止 按钮）',
        '- `/steer <内容>` — 运行中追加指示，不重开 turn（Codex App Server）',
        '- `/answer <请求ID> <回答>` — 回答 Codex 的自由文本问题',
        '- `/stop comment:<scopeHash>` — 管理员停止云文档评论任务',
        '- `/timeout [N|off|default]` — 当前 session 的探活分钟数,`/config` 改全局默认',
        '- `/timeout comment:<scopeHash> N` — 管理员设置云文档评论任务探活',
        '- `/ps` — 列出本机所有 bot,标识当前正在回复的那个',
        '- `/exit <id|#>` — 关掉指定 bot(用 `/ps` 看 id/序号)',
        '- `/reconnect` — 强制重连 WebSocket(网络抖动后 bot 没反应时用)',
        `- \`/doctor [描述]\` — 把日志和描述交给 ${escapedAgentName} 自助诊断`,
        '- `/help` — 本帮助',
        '',
        `其他内容直接交给 ${escapedAgentName}。`,
      ].join('\n'),
    ),
    HR,
    actions([
      { text: '📊 状态', value: { cmd: 'status' }, style: 'primary' },
      { text: '🔁 恢复会话', value: { cmd: 'resume' } },
      { text: '📂 工作目录', value: { cmd: 'ws.list' } },
      { text: '🆕 新会话', value: { cmd: 'new' } },
    ]),
  ]);
}

function escapeMd(s: string): string {
  return s.replace(/([*_`\\])/g, '\\$1');
}

function escapeCode(s: string): string {
  return s.replace(/`/g, "'");
}

function truncateLine(value: string, max: number): string {
  const oneLine = value.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}
