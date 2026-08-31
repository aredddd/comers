import { deepMaskEmails } from './mask-email';
import type { Block, FooterStatus, RunState, ToolEntry } from './run-state';
import { toolBodyMd, toolHeaderText } from './tool-render';
import type { AgentApprovalRequest } from '../agent/types';

const REASONING_MAX = 1500;
const COLLAPSE_TOOL_THRESHOLD = 3;

interface ToolGroup {
  kind: 'tools';
  tools: ToolEntry[];
}
interface TextGroup {
  kind: 'text';
  content: string;
}
type Group = ToolGroup | TextGroup;

export interface RunCardRenderOptions {
  signCallback?: (action: string) => string;
}

export function renderCard(state: RunState, options: RunCardRenderOptions = {}): object {
  const elements: object[] = [];

  if (state.reasoning.content) {
    elements.push(reasoningPanel(state.reasoning.content, state.reasoning.active));
  }

  for (const group of groupBlocks(state.blocks)) {
    if (group.kind === 'text') {
      if (group.content.trim()) {
        elements.push(markdown(group.content));
      }
    } else {
      elements.push(...renderToolGroup(group.tools, state.terminal !== 'running'));
    }
  }

  for (const approval of state.approvals ?? []) {
    elements.push(approvalPanel(approval, options));
  }

  if (state.terminal === 'interrupted') {
    elements.push(noteMd('_⏹ 已被中断_'));
  } else if (state.terminal === 'idle_timeout') {
    const mins = state.idleTimeoutMinutes ?? 0;
    elements.push(noteMd(`_⏱ ${mins} 分钟无响应,已自动终止_`));
  } else if (state.terminal === 'error' && state.errorMsg) {
    elements.push(noteMd(`⚠️ agent 失败：${state.errorMsg}`));
  } else if (state.terminal === 'done' && elements.length === 0) {
    elements.push(noteMd('_（未返回内容）_'));
  }

  if (state.terminal === 'running') {
    if (state.footer) elements.push(footerStatus(state.footer));
    elements.push(stopButton(options));
  }

  // Mask raw emails across every text field so the Feishu tenant audit doesn't
  // reject the (streamed) card with a 400 EMAIL_ADDRESS — see mask-email.ts.
  return deepMaskEmails({
    schema: '2.0',
    config: {
      streaming_mode: state.terminal === 'running',
      summary: { content: summaryText(state) },
    },
    body: { elements },
  });
}

function approvalPanel(
  request: AgentApprovalRequest,
  options: RunCardRenderOptions,
): object {
  const details = [
    request.reason ? `**原因**：${escapeMd(request.reason)}` : '',
    request.cwd ? `**目录**：\`${escapeCode(request.cwd)}\`` : '',
    request.command ? `**命令**\n\`\`\`bash\n${truncate(request.command, 1000)}\n\`\`\`` : '',
    request.detail ? truncate(request.detail, 1000) : '',
    ...((request.questions ?? []).map((question) => {
      const optionsText = question.options?.length
        ? `\n${question.options.map((option) => `- ${escapeMd(option.label)}${option.description ? `：${escapeMd(option.description)}` : ''}`).join('\n')}`
        : '';
      return `**${escapeMd(question.header)}**：${escapeMd(question.question)}${optionsText}`;
    })),
  ].filter(Boolean);
  if (request.url) details.push(`**链接**：${request.url}`);
  const questions = request.questions ?? [];
  if (request.kind === 'user-input' && questions.some((question) => question.isSecret)) {
    details.push('此请求包含敏感输入，不建议在飞书中提交；请拒绝后改用不含秘密的方式继续。');
  } else if (request.kind === 'user-input' && questions.length > 1) {
    const example = Object.fromEntries(questions.map((question) => [question.id, '回答']));
    details.push(`请一次性回复：\`/answer ${request.id} ${escapeCode(JSON.stringify(example))}\``);
  } else if (request.kind === 'user-input' && !questions.some((q) => q.options?.length)) {
    details.push(`请回复：\`/answer ${request.id} <你的回答>\``);
  } else if (request.kind === 'mcp-elicitation' && !request.url) {
    details.push(`如需提交结构化内容，请回复：\`/answer ${request.id} <JSON>\``);
  }

  const buttons: object[] = [];
  const optionButtons = questions.length === 1 && !questions[0]?.isSecret
    ? questions.flatMap((question) =>
    (question.options ?? []).slice(0, 5).map((option) =>
      approvalButton(
        option.label,
        'approval.answer',
        `${request.id}:${encodeURIComponent(`${question.id}:${option.value}`)}`,
        'primary',
        options,
      ),
    ),
  ) : [];
  buttons.push(...optionButtons);
  if (request.url) {
    buttons.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '打开授权链接' },
      type: 'primary',
      url: request.url,
    });
  }
  if (request.kind !== 'user-input') {
    buttons.push(approvalButton('允许一次', 'approval.accept', request.id, 'primary', options));
    if (request.allowForSession) {
      buttons.push(
        approvalButton('本会话允许', 'approval.acceptForSession', request.id, 'default', options),
      );
    }
  }
  buttons.push(approvalButton('拒绝', 'approval.decline', request.id, 'danger', options));

  return {
    tag: 'column_set',
    flex_mode: 'none',
    background_style: 'grey',
    columns: [{
      tag: 'column',
      width: 'weighted',
      weight: 1,
      elements: [
        { tag: 'markdown', content: `🔐 **${escapeMd(request.title)}**\n\n${details.join('\n\n')}` },
        { tag: 'button_group', buttons },
      ],
    }],
  };
}

function approvalButton(
  label: string,
  cmd: string,
  arg: string,
  type: 'primary' | 'danger' | 'default',
  options: RunCardRenderOptions,
): object {
  const value: Record<string, unknown> = { cmd, arg };
  if (options.signCallback) {
    value.__bridge_cb = true;
    value.bridge_token = options.signCallback(cmd);
  }
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: label },
    type,
    behaviors: [{ type: 'callback', value }],
  };
}

function* groupBlocks(blocks: Block[]): Generator<Group> {
  let toolBuf: ToolEntry[] = [];
  for (const b of blocks) {
    if (b.kind === 'tool') {
      toolBuf.push(b.tool);
    } else {
      if (toolBuf.length > 0) {
        yield { kind: 'tools', tools: toolBuf };
        toolBuf = [];
      }
      yield { kind: 'text', content: b.content };
    }
  }
  if (toolBuf.length > 0) yield { kind: 'tools', tools: toolBuf };
}

function renderToolGroup(tools: ToolEntry[], finalized: boolean): object[] {
  if (tools.length === 0) return [];
  if (tools.length < COLLAPSE_TOOL_THRESHOLD) {
    return tools.map((t) => toolPanel(t, false));
  }
  if (finalized) {
    return [collapsedToolSummary(tools, true)];
  }
  // Running: collapse prior tools, keep latest visible.
  const prior = tools.slice(0, -1);
  const latest = tools[tools.length - 1];
  const out: object[] = [];
  if (prior.length > 0) out.push(collapsedToolSummary(prior, false));
  if (latest) out.push(toolPanel(latest, true));
  return out;
}

function reasoningPanel(content: string, active: boolean): object {
  const title = active ? '🧠 **思考中**' : '🧠 **思考完成，点击查看**';
  return collapsiblePanel({
    title,
    expanded: active,
    border: 'grey',
    body: truncate(content, REASONING_MAX),
  });
}

function toolPanel(tool: ToolEntry, expanded: boolean): object {
  return collapsiblePanel({
    title: toolHeaderText(tool),
    expanded,
    border: tool.status === 'error' ? 'red' : 'grey',
    body: toolBodyMd(tool) || '_无输出_',
  });
}

/**
 * Render N tool calls as a single collapsed panel. **Body content is dropped**
 * — only the per-tool header line (icon + name + short summary) is kept.
 *
 * Why no bodies: with full input/output panels nested, the serialized JSON
 * can easily exceed Feishu's per-element size limit (~30KB), causing 400
 * errors that abort the entire card stream. Tool details are still in the
 * file log; users who really need them can `/doctor` to inspect.
 *
 * The latest-running tool, when applicable, is rendered separately via
 * `toolPanel(latest, true)` so live observation isn't sacrificed.
 */
function collapsedToolSummary(tools: ToolEntry[], finalized: boolean): object {
  const suffix = finalized ? '（已结束）' : '';
  const title = `☕ **${tools.length} 个工具调用${suffix}**`;
  const headerList = tools.map((t) => `- ${toolHeaderText(t)}`).join('\n');
  return {
    tag: 'collapsible_panel',
    expanded: false,
    header: panelHeader(title),
    border: { color: 'blue', corner_radius: '5px' },
    vertical_spacing: '8px',
    padding: '8px 8px 8px 8px',
    elements: [{ tag: 'markdown', content: headerList, text_size: 'notation' }],
  };
}

interface PanelOpts {
  title: string;
  expanded: boolean;
  border: 'grey' | 'red' | 'blue';
  body: string;
}

function collapsiblePanel(opts: PanelOpts): object {
  return {
    tag: 'collapsible_panel',
    expanded: opts.expanded,
    header: panelHeader(opts.title),
    border: { color: opts.border, corner_radius: '5px' },
    vertical_spacing: '8px',
    padding: '8px 8px 8px 8px',
    elements: [{ tag: 'markdown', content: opts.body, text_size: 'notation' }],
  };
}

function panelHeader(titleMd: string): object {
  return {
    title: { tag: 'markdown', content: titleMd },
    vertical_align: 'center',
    icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', size: '16px 16px' },
    icon_position: 'follow_text',
    icon_expanded_angle: -180,
  };
}

function markdown(content: string): object {
  return { tag: 'markdown', content };
}

function noteMd(content: string): object {
  return { tag: 'markdown', content, text_size: 'notation' };
}

function stopButton(options: RunCardRenderOptions): object {
  const value: Record<string, unknown> = { cmd: 'stop' };
  if (options.signCallback) {
    value.__bridge_cb = true;
    value.bridge_token = options.signCallback('stop');
  }
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: '⏹ 终止' },
    type: 'danger',
    behaviors: [{ type: 'callback', value }],
  };
}

function footerStatus(status: Exclude<FooterStatus, null>): object {
  const text =
    status === 'thinking'
      ? '🧠 正在思考'
      : status === 'tool_running'
        ? '🧰 正在调用工具'
        : '✍️ 正在输出';
  return noteMd(text);
}

function summaryText(state: RunState): string {
  if (state.terminal === 'interrupted') return '已中断';
  if (state.terminal === 'idle_timeout') return '已超时';
  if (state.terminal === 'error') return '出错';
  if (state.terminal === 'done') return '已完成';
  if (state.footer === 'tool_running') return '正在调用工具';
  if (state.footer === 'streaming') return '正在输出';
  return '思考中';
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function escapeMd(value: string): string {
  return value.replace(/([*_`\\])/g, '\\$1');
}

function escapeCode(value: string): string {
  return value.replace(/`/g, "'");
}
