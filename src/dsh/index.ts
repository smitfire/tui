import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent';
import { isLoopbackHost } from '@deepseek-ai/dsh-host-webserver';
import { createUserMessage, type ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval';
import type { ApprovalRequestEvent } from '@deepseek-ai/dsh-user-approval/types';
import type { AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions';
import type { AskUserQuestionItem, AskUserQuestionRequestEvent } from '@deepseek-ai/dsh-user-questions/types';
import type {} from '@deepseek-ai/dsh-commands';
import type {} from '@deepseek-ai/dsh-system-prompt';
import {
  BracketedPasteParser,
  TerminalInteractionController,
  renderDiffBlock,
  renderFooter,
  renderHeader,
  renderToolBadge,
  type NsTuiService,
  type ToolBadgeEntry,
  type TuiStatusSnapshot,
} from '../core/index.js';

export const name = 'ns-tui';
export const inject = ['agents', 'commands', 'tools', 'sessions', 'systemPrompt'] as const;

export interface PluginConfig {
  interactive?: boolean;
  resume?: string;
  appName?: string;
  version?: string;
  onDetach?: () => void;
}

export const Config: z<PluginConfig> = z.object({
  interactive: z.boolean(),
  resume: z.string(),
  appName: z.string().default('ns-dsh'),
  version: z.string().default('0.1.0'),
}) as unknown as z<PluginConfig>;

declare module '@deepseek-ai/cordis' {
  interface Context {
    nsTui?: NsTuiService;
  }
}

const LOOPBACK_ORIGIN_RE = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i;
const LOOPBACK_HOST_RE = /^(?:127\.\d+\.\d+\.\d+|localhost|\[::1\]|::1)(?::\d+)?$/i;

function isLoopbackRequest(req: IncomingMessage): boolean {
  const host = String(req.headers.host ?? '');
  if (!host || !LOOPBACK_HOST_RE.test(host)) return false;
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin.length > 0 && !LOOPBACK_ORIGIN_RE.test(origin)) {
    return false;
  }
  return true;
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage, limitBytes = 32_768): Promise<Record<string, unknown>> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      rejectBody(err);
    };
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > limitBytes) {
        req.pause();
        fail(Object.assign(new Error('request body exceeds 32KB limit'), { statusCode: 413 }));
        return;
      }
      if (!settled) chunks.push(c);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      try {
        const raw = Buffer.concat(chunks).toString('utf8').trim();
        resolveBody(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
      } catch {
        rejectBody(Object.assign(new Error('invalid JSON body'), { statusCode: 400 }));
      }
    });
    req.on('error', fail);
    req.on('aborted', () => fail(Object.assign(new Error('request aborted'), { statusCode: 400 })));
  });
}

function readGitBranch(cwd: string): string | undefined {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      timeout: 1500,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

export function apply(ctx: Context, rawConfig: Partial<PluginConfig> = {}): void {
  const interactive = rawConfig.interactive ?? process.env.NS_DSH_TUI === '1';
  const appName = rawConfig.appName ?? 'ns-dsh';
  const version = rawConfig.version ?? '0.1.0';
  const log = ctx.logger(name);

  let attached = interactive && Boolean(process.stdout?.isTTY);
  let activeHandle: AgentHandle | undefined;
  let activeAgent: Agent | undefined;
  let planMode = false;
  let totalTokens = 0;
  let cugaBlocks = 0;
  let expandBadges = false;
  let lineBuffer = '';
  const recentBadges: ToolBadgeEntry[] = [];
  const promptHistory: string[] = [];

  const cols = () => process.stdout?.columns ?? 100;
  const writeOut = (chunk: string) => {
    if (interactive && attached) {
      try {
        process.stdout.write(chunk);
      } catch {
        /* ignore broken pipe during shutdown */
      }
    }
  };

  const interactions = new TerminalInteractionController({
    write: writeOut,
    columns: cols,
  });

  const resolveRootAgent = (): Agent | undefined => {
    if (activeAgent && ctx.agents.get(activeAgent.id)) return activeAgent;
    const all = ctx.agents.list();
    return all.find((a) => !a.session.header?.parentSession) ?? all[0];
  };

  const buildStatus = (): TuiStatusSnapshot => {
    const agent = resolveRootAgent();
    const sid = agent ? String(agent.session.id) : 'none';
    const cwd = (agent?.session.header as { cwd?: string } | undefined)?.cwd || process.cwd();
    const sel = agent?.model.current();
    const nsCtx = ctx.get('nsContext') as
      | {
          getSessionSummary?: (sessionId: string) => {
            strategy?: string;
            tier?: string;
            activeOffers?: number;
          };
        }
      | undefined;
    const nsTeam = ctx.get('nsTeam') as
      | {
          router?: {
            stateFor?: (sessionId: string) => { activeTier?: string; escalations?: number };
          };
        }
      | undefined;
    const nsBoard = ctx.get('nsBoard') as
      | {
          snapshot?: () => { cards: Array<{ id: string; column: string }> };
        }
      | undefined;
    const fw = sid !== 'none' ? nsCtx?.getSessionSummary?.(sid) : undefined;
    const sw = sid !== 'none' ? nsTeam?.router?.stateFor?.(sid) : undefined;
    const boardSnap = nsBoard?.snapshot?.();
    const runningCard = boardSnap?.cards.find((c) => c.column === 'in_progress' || c.column === 'review');

    return {
      appName,
      version,
      cwd,
      branch: readGitBranch(cwd),
      sessionId: sid,
      model: sel?.model ?? 'unselected',
      provider: sel?.provider,
      effort: sel?.reasoningEffort,
      switchyardTier: sw?.activeTier ?? 'direct',
      switchyardEscalations: sw?.escalations ?? 0,
      contextPercent: Math.min(100, Math.round((totalTokens / 128_000) * 100)),
      forewispStrategy: fw?.strategy ?? fw?.tier ?? 'local',
      forewispOffers: fw?.activeOffers ?? 0,
      cugaMode: planMode ? 'plan-readonly' : 'enforce',
      cugaBlocks,
      activeCard: runningCard ? `${runningCard.id} [${runningCard.column}]` : undefined,
      tokensUsed: totalTokens,
      planMode,
      attached,
      running: agent?.status === 'running',
    };
  };

  const renderPromptLine = () => {
    if (!interactive || !attached) return;
    writeOut(`\n${renderFooter(buildStatus(), cols())}\n❯ ${lineBuffer}`);
  };

  const ensureRootAgent = async (resumeId?: string): Promise<Agent> => {
    const existing = resolveRootAgent();
    if (!resumeId && existing) {
      activeAgent = existing;
      return existing;
    }
    if (resumeId) {
      const live = ctx.agents.get(SessionId(resumeId));
      if (live) {
        activeAgent = live;
        return live;
      }
      if (ctx.get('sessionPersistence')) {
        const resumed = await ctx.agents.resume({ resumeSessionId: SessionId(resumeId) });
        activeHandle = resumed;
        activeAgent = resumed.agent;
        return resumed.agent;
      }
    }
    const sid = SessionId(randomUUID());
    const handle = await ctx.agents.create({
      sessionId: sid,
      meta: { cwd: process.cwd() },
    });
    activeHandle = handle;
    activeAgent = handle.agent;
    return handle.agent;
  };

  const submitPrompt = async (text: string): Promise<void> => {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (trimmed.startsWith('/')) {
      const result = await executeCommand(trimmed);
      if (result) writeOut(`\n${result.text}\n`);
      return;
    }
    promptHistory.push(trimmed);
    if (promptHistory.length > 100) promptHistory.shift();
    const agent = await ensureRootAgent();
    const content = planMode
      ? `[PLAN MODE: read-only analysis; propose tasks onto the Kanban board instead of editing files]\n${trimmed}`
      : trimmed;
    agent.followup(
      createUserMessage({
        content: [{ type: 'text', text: content }],
        source: { kind: 'user' },
      }),
    );
  };

  const executeCommand = async (line: string): Promise<{ kind: string; text: string } | undefined> => {
    const agent = resolveRootAgent() ?? (await ensureRootAgent());
    const exec = await ctx.commands.execute(agent, line, [], new AbortController().signal);
    if (!exec) {
      return { kind: 'error', text: `Unknown command: ${line.split(/\s+/)[0]} (try /help)` };
    }
    return {
      kind: exec.result.kind,
      text: exec.result.text ?? '',
    };
  };

  const tuiService: NsTuiService = {
    isAttached: () => attached,
    setAttached: (nextAttached: boolean) => {
      attached = nextAttached;
      if (attached && interactive) {
        writeOut(`\n${renderHeader(buildStatus(), cols())}\n`);
        renderPromptLine();
      }
    },
    activeSessionId: () => {
      const a = resolveRootAgent();
      return a ? String(a.session.id) : undefined;
    },
    detach: () => {
      attached = false;
      interactions.handleCtrlC();
      const tmuxSock = process.env.NS_DSH_TMUX_SOCKET;
      if (tmuxSock) {
        try {
          execFileSync('tmux', ['-L', tmuxSock, 'detach-client'], {
            stdio: 'ignore',
            timeout: 1500,
          });
        } catch {
          /* ignore when not attached inside tmux */
        }
      } else if (process.env.TMUX) {
        try {
          execFileSync('tmux', ['detach-client'], {
            stdio: 'ignore',
            timeout: 1500,
          });
        } catch {
          /* ignore when not attached inside tmux */
        }
      }
      rawConfig.onDetach?.();
    },
    resume: async (sessionId: string) => {
      const a = await ensureRootAgent(sessionId);
      return { sessionId: String(a.session.id) };
    },
    getStatus: () => buildStatus(),
    submitPrompt,
    executeCommand,
    pendingInteractions: () => interactions.pending(),
  };
  ctx.provide('nsTui', tuiService);

  // Plan-mode safety context slot when /plan is toggled in interactive UX
  ctx.systemPrompt.context({
    name: 'ns-tui:mode',
    order: 186,
    interpolate: false,
    text: () =>
      planMode
        ? '<tui-plan-mode>Operator has enabled read-only PLAN mode. Inspect code and propose Kanban tasks instead of mutating workspace files.</tui-plan-mode>'
        : '',
  });

  // Priority HITL Approval handler: claim inline when attached, else delegate to WebUI via next().
  ctx.on(
    'approval/request',
    async (req: ApprovalRequestEvent, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome> => {
      if (!attached) return next();
      const outcome = await interactions.promptApproval({
        toolName: req.toolName,
        reason: req.displayReason?.en ?? req.reason,
        signal: req.signal,
      });
      return outcome;
    },
    { prepend: true },
  );

  // Priority HITL Question handler: claim inline when attached, else delegate to WebUI via next().
  ctx.on(
    'user-questions/request',
    async (req: AskUserQuestionRequestEvent, next: () => Promise<AskUserQuestionAnswer>): Promise<AskUserQuestionAnswer> => {
      if (!attached) return next();
      const res = await interactions.promptQuestion({
        questions: req.questions.map((q: AskUserQuestionItem) => ({
          id: q.id,
          question: q.question,
          detail: q.detail,
          header: q.header,
          options: q.options,
          multiSelect: q.multiSelect,
        })),
        signal: req.signal,
      });
      if (res.cancelled) {
        return { answers: [] };
      }
      return { answers: res.answers };
    },
    { prepend: true },
  );

  // Live streaming output, tool badges, PTC savings, and usage telemetry
  let activeAttemptId: string | undefined;
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    const root = resolveRootAgent();
    if (root && agent.id !== root.id) return;
    if (frame.type === 'start') {
      activeAttemptId = String(frame.attemptId);
      writeOut('\n');
    } else if (frame.type === 'chunk') {
      if (frame.chunk.type === 'text-delta' && frame.chunk.text) {
        writeOut(frame.chunk.text);
      } else if (frame.chunk.type === 'usage') {
        const u = frame.chunk.usage;
        totalTokens += (u.inputTokens ?? 0) + (u.outputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0);
      }
    } else if (frame.type === 'end' && String(frame.attemptId) === activeAttemptId) {
      activeAttemptId = undefined;
      renderPromptLine();
    }
  });

  ctx.on('tools/result', (exec, result) => {
    const isErr = result?.isError === true;
    const textPreview = (Array.isArray(result?.content) ? result.content : [])
      .filter((b): b is { type: 'text'; text: string } => b?.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join(' ')
      .slice(0, 120);
    if (textPreview.includes('CUGA_')) cugaBlocks += 1;
    const badge: ToolBadgeEntry = {
      toolName: exec.name,
      summary: textPreview || (isErr ? 'error' : 'ok'),
      ok: !isErr,
    };
    recentBadges.push(badge);
    if (recentBadges.length > 30) recentBadges.shift();
    writeOut(`\n${renderToolBadge(badge, expandBadges, cols())}\n`);
  });

  // Safe slash command registration (never throws on duplicate across plugins)
  const disposers: Array<() => void> = [];
  const regCmd = (
    cmdName: string,
    description: string,
    handler: (inv: { agent: Agent; rawInput: string }) => { kind: 'success' | 'error'; text: string } | Promise<{ kind: 'success' | 'error'; text: string }>,
  ) => {
    try {
      disposers.push(
        ctx.commands.register({
          name: cmdName,
          description,
          handler: async (inv) => handler({ agent: inv.agent, rawInput: inv.rawInput }),
        }),
      );
    } catch {
      /* another plugin may already register this command name */
    }
  };

  regCmd('help', 'List available ns-dsh slash commands', () => ({
    kind: 'success',
    text: [
      '/plan [on|off|<task>]  Toggle read-only planning mode or send planning prompt',
      '/status                Show live model, Switchyard, Forewisp/JEV, CUGA & token status',
      '/board / /tasks        Show Kanban board cards & dependencies',
      '/pickup <id>           Move card to Ready queue',
      '/pause <id>            Pause running card',
      '/cancel <id>           Cancel card',
      '/diff [id]             Show rendered unified diff for card or last edited file',
      '/context [query]       Inspect Forewisp / JEV offers or search knowledge',
      '/cuga                  Inspect CUGA security blocks & crystallized playbooks',
      '/switchyard            Inspect current Switchyard tier & escalations',
      '/model [prov/mod [eff]] Switch active model or reasoning effort',
      '/resume <sessionId>    Resume existing session ID',
      '/exit                  Detach terminal TUI (background host keeps running)',
      '/shutdown              Stop persistent ns-dsh host cleanly',
    ].join('\n'),
  }));

  regCmd('status', 'Show live TUI/Forewisp/Switchyard/CUGA status', () => ({
    kind: 'success',
    text: renderFooter(buildStatus(), cols(), true),
  }));

  regCmd('plan', 'Toggle read-only PLAN mode or submit a planning prompt', async ({ rawInput }) => {
    const arg = rawInput.trim();
    if (!arg) {
      planMode = !planMode;
      return { kind: 'success', text: `Plan mode ${planMode ? 'ENABLED (read-only)' : 'DISABLED'}.` };
    }
    if (arg === 'on' || arg === 'off') {
      planMode = arg === 'on';
      return { kind: 'success', text: `Plan mode ${planMode ? 'ENABLED (read-only)' : 'DISABLED'}.` };
    }
    planMode = true;
    await submitPrompt(arg);
    return { kind: 'success', text: `Submitted planning prompt in PLAN mode.` };
  });

  regCmd('tasks', 'List Kanban board tasks', () => {
    const nsBoard = ctx.get('nsBoard') as
      | { snapshot?: () => { cards: Array<{ id: string; column: string; owner: string; title: string; blockedBy: string[] }> } }
      | undefined;
    if (!nsBoard?.snapshot) return { kind: 'error', text: 'ns-board service is unavailable' };
    const cards = nsBoard.snapshot().cards;
    if (cards.length === 0) return { kind: 'success', text: 'Board has 0 cards.' };
    return {
      kind: 'success',
      text: cards
        .map((c) => `${c.id} | ${c.column} | ${c.owner} | ${c.title}${c.blockedBy.length ? ` (blockedBy: ${c.blockedBy.join(',')})` : ''}`)
        .join('\n'),
    };
  });

  for (const op of ['pickup', 'pause', 'resume-task', 'cancel'] as const) {
    regCmd(op, `${op} Kanban card <cardId>`, ({ rawInput }) => {
      const cardId = rawInput.trim();
      if (!cardId) return { kind: 'error', text: `Usage: /${op} <cardId>` };
      const nsBoard = ctx.get('nsBoard') as
        | {
            getCard?: (id: string) => { id: string; revision: number } | undefined;
            moveCard?: (req: Record<string, unknown>) => { ok: boolean; reason?: string; status?: string };
          }
        | undefined;
      if (!nsBoard?.getCard || !nsBoard?.moveCard) return { kind: 'error', text: 'ns-board unavailable' };
      const card = nsBoard.getCard(cardId);
      if (!card) return { kind: 'error', text: `Card not found: ${cardId}` };
      const col = op === 'pickup' || op === 'resume-task' ? 'ready' : 'blocked';
      const out = nsBoard.moveCard({
        cardId,
        toColumn: col,
        actor: 'human',
        role: 'human',
        expectedRevision: card.revision,
        clearApproval: op === 'pickup',
        reason: `TUI /${op} command`,
      });
      return out.ok
        ? { kind: 'success', text: `${cardId} -> ${col}` }
        : { kind: 'error', text: out.reason ?? out.status ?? 'move rejected' };
    });
  }

  regCmd('diff', 'Render colorized unified diff for last file edit or card', ({ rawInput }) => {
    const target = rawInput.trim();
    const withDiff = recentBadges.findLast((b) => b.diff && (!target || b.diff.path.includes(target)));
    if (withDiff?.diff) {
      return { kind: 'success', text: renderDiffBlock(withDiff.diff, { maxLines: 80, columns: cols(), noColor: true }) };
    }
    return { kind: 'success', text: target ? `No recorded diff matching "${target}".` : 'No recent file diffs recorded.' };
  });

  regCmd('context', 'Inspect Forewisp/JEV health and context offers (/context [query])', async ({ agent, rawInput }) => {
    const nsCtx = ctx.get('nsContext') as
      | {
          stats?: () => Promise<Record<string, unknown>>;
          retrieve?: (q: string, sid?: string) => Promise<{ tier: string; strategy?: string; offers: Array<{ id: string; title: string; summary: string }> }>;
        }
      | undefined;
    if (!nsCtx) return { kind: 'error', text: 'ns-context unavailable' };
    const q = rawInput.trim();
    if (!q) {
      return { kind: 'success', text: JSON.stringify(await nsCtx.stats?.(), null, 2) };
    }
    const res = await nsCtx.retrieve?.(q, String(agent.session.id));
    if (!res || res.offers.length === 0) return { kind: 'success', text: `Forewisp (${res?.tier ?? 'unknown'}): 0 matches.` };
    return {
      kind: 'success',
      text: res.offers.map((o) => `• ${o.id}: ${o.title} — ${o.summary}`).join('\n'),
    };
  });

  regCmd('cuga', 'Inspect CUGA policy state and crystallized playbooks', ({ agent }) => {
    const nsCuga = ctx.get('nsCuga') as { getSessionState?: (sid: string) => unknown } | undefined;
    if (!nsCuga?.getSessionState) return { kind: 'error', text: 'ns-cuga unavailable' };
    return { kind: 'success', text: JSON.stringify(nsCuga.getSessionState(String(agent.session.id)) ?? { blocks: cugaBlocks }, null, 2) };
  });

  regCmd('switchyard', 'Inspect Switchyard adaptive routing tier and TOML', () => {
    const nsTeam = ctx.get('nsTeam') as
      | { router?: { stateFor?: (sid: string) => unknown }; exportRoutesToml?: () => string }
      | undefined;
    if (!nsTeam?.router?.stateFor) return { kind: 'error', text: 'ns-team unavailable' };
    const sid = tuiService.activeSessionId() ?? 'default';
    return { kind: 'success', text: JSON.stringify(nsTeam.router.stateFor(sid), null, 2) };
  });

  regCmd('model', 'Inspect or switch provider/model/effort (/model <provider>/<model> [effort])', ({ agent, rawInput }) => {
    const trimmed = rawInput.trim();
    if (!trimmed) {
      return { kind: 'success', text: JSON.stringify(agent.model.current() ?? null) };
    }
    const [routeSpec, effort] = trimmed.split(/\s+/);
    const slash = routeSpec.indexOf('/');
    const provider = slash > 0 ? routeSpec.slice(0, slash) : agent.model.current()?.provider ?? 'google-antigravity';
    const model = slash > 0 ? routeSpec.slice(slash + 1) : routeSpec;
    agent.model.select({
      provider,
      model,
      ...(effort ? { reasoningEffort: effort as ReasoningEffortId } : {}),
    });
    return { kind: 'success', text: `Model switched to ${provider}/${model}${effort ? ` (${effort})` : ''}.` };
  });

  regCmd('quota', 'Show current provider/budget usage counters', () => ({
    kind: 'success',
    text: JSON.stringify({ tokensUsed: totalTokens, cugaBlocks, sessionId: tuiService.activeSessionId() }, null, 2),
  }));

  regCmd('resume', 'Resume an existing session (/resume <sessionId>)', async ({ rawInput }) => {
    const sid = rawInput.trim();
    if (!sid) return { kind: 'error', text: 'Usage: /resume <sessionId>' };
    const out = await tuiService.resume(sid);
    return { kind: 'success', text: `Resumed session ${out.sessionId}` };
  });

  regCmd('exit', 'Detach TUI client while leaving background host and workers alive', () => {
    tuiService.detach();
    return { kind: 'success', text: 'Detached TUI client; background host remains active.' };
  });

  regCmd('shutdown', 'Stop persistent ns-dsh host cleanly', () => {
    setImmediate(() => {
      void activeHandle?.dispose().catch(() => {});
      process.kill(process.pid, 'SIGTERM');
    });
    return { kind: 'success', text: 'Shutting down ns-dsh host...' };
  });

  // Register interactive tool so model can ask questions via ctx.userQuestions (inline when attached, WebUI when detached)
  if (ctx.get('userQuestions')) {
    disposers.push(
      ctx.tools.register(
        defineTool({
          name: 'ns_ask_user',
          description: 'Ask the human user a blocking structured question (inline in attached TUI, or WebUI when detached).',
          parameters: {
            question: { type: 'string', required: true, description: 'Question to show the user.' },
            options: { type: 'array', items: { type: 'string' }, description: 'Optional choice labels.' },
          },
          output: {
            schema: { type: 'object', properties: {}, additionalProperties: true },
            render: (_args, val) => [{ type: 'text', text: JSON.stringify(val) }],
          },
          execute: async (args, exec): Promise<Record<string, boolean | string | Array<Record<string, string | string[]>>>> => {
            const uq = ctx.get('userQuestions');
            if (!uq) return { answered: false, reason: 'userQuestions service absent' };
            const res = await uq.ask({
              agent: exec.agent,
              signal: exec.signal,
              questions: [
                {
                  id: 'q1',
                  question: String(args.question),
                  options: Array.isArray(args.options)
                    ? args.options.map((label) => ({ label: String(label) }))
                    : undefined,
                },
              ],
            });
            return {
              answered: true,
              answers: res.answers.map((a) => {
                const entry: Record<string, string | string[]> = {
                  id: a.id,
                  selected: [...a.selected],
                };
                if (a.custom !== undefined) entry.custom = a.custom;
                return entry;
              }),
            };
          },
        }),
      ),
    );
  }

  // Loopback HTTP routes on WebServer so tmux launcher can flip attached state cleanly
  ctx.inject(['webServer'], (webCtx) => {
    const server = webCtx.webServer;
    if (!isLoopbackHost(server.host)) return;
    const webDisposers = [
      server.register({
        kind: 'exact',
        path: '/ns-tui/api/status',
        handler: (req, res) => {
          if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
          if (!isLoopbackRequest(req)) return sendJson(res, 403, { error: 'loopback required' });
          sendJson(res, 200, buildStatus());
        },
      }),
      server.register({
        kind: 'exact',
        path: '/ns-tui/api/attach',
        handler: async (req, res) => {
          if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
          if (!isLoopbackRequest(req)) return sendJson(res, 403, { error: 'loopback required' });
          try {
            const body = await readJsonBody(req);
            tuiService.setAttached(Boolean(body.attached));
            sendJson(res, 200, { ok: true, attached });
          } catch (err) {
            const code = (err as { statusCode?: number }).statusCode ?? 400;
            sendJson(res, code, { error: err instanceof Error ? err.message : String(err) });
          }
        },
      }),
      server.register({
        kind: 'exact',
        path: '/ns-tui/api/resume',
        handler: async (req, res) => {
          if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
          if (!isLoopbackRequest(req)) return sendJson(res, 403, { error: 'loopback required' });
          try {
            const body = await readJsonBody(req);
            const sid = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
            if (!sid) return sendJson(res, 400, { error: 'sessionId string is required' });
            const out = await tuiService.resume(sid);
            sendJson(res, 200, { ok: true, sessionId: out.sessionId });
          } catch (err) {
            const code = (err as { statusCode?: number }).statusCode ?? 400;
            sendJson(res, code, { error: err instanceof Error ? err.message : String(err) });
          }
        },
      }),
    ];
    webCtx.effect(() => () => {
      for (const d of webDisposers) d();
    });
  });

  // Live TTY input reader when interactive mode is enabled
  let parser: BracketedPasteParser | undefined;
  let onData: ((chunk: Buffer) => void) | undefined;
  let onResize: (() => void) | undefined;
  if (interactive) {
    parser = new BracketedPasteParser();
    if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
      try {
        process.stdin.setRawMode(true);
      } catch {
        /* non-raw TTY fallback */
      }
    }
    process.stdin.resume();
    writeOut('\x1b[?2004h');
    const initialResume = rawConfig.resume || process.env.NS_DSH_RESUME || undefined;
    void ensureRootAgent(initialResume).then(() => {
      if (attached) {
        writeOut(`\n${renderHeader(buildStatus(), cols())}\n`);
        renderPromptLine();
      }
    }).catch((err) => {
      log.warn(`Failed initial TUI agent setup: ${err instanceof Error ? err.message : String(err)}`);
    });

    onResize = () => {
      if (attached) renderPromptLine();
    };
    process.stdout?.on('resize', onResize);

    onData = (chunk: Buffer) => {
      for (const tok of parser!.feed(chunk)) {
        if (tok.type === 'ctrl_c') {
          if (!interactions.handleCtrlC()) {
            const a = resolveRootAgent();
            if (a && a.status === 'running') {
              a.cancel({ kind: 'user' });
              writeOut('\n[Turn aborted via Ctrl+C]\n');
            } else {
              lineBuffer = '';
              writeOut('\n^C\n');
            }
          }
          renderPromptLine();
        } else if (tok.type === 'ctrl_o') {
          expandBadges = !expandBadges;
          const last = recentBadges.at(-1);
          if (last) writeOut(`\n${renderToolBadge(last, expandBadges, cols())}\n`);
          renderPromptLine();
        } else if (tok.type === 'ctrl_l') {
          writeOut('\x1b[2J\x1b[H');
          writeOut(`${renderHeader(buildStatus(), cols())}\n`);
          renderPromptLine();
        } else if (tok.type === 'escape') {
          if (interactions.hasActivePrompt()) {
            interactions.handleCtrlC();
            renderPromptLine();
          }
        } else if (tok.type === 'backspace') {
          if (lineBuffer.length > 0) {
            lineBuffer = Array.from(lineBuffer).slice(0, -1).join('');
            writeOut('\b \b');
          }
        } else if (tok.type === 'paste' && tok.text !== undefined) {
          lineBuffer += tok.text;
          writeOut(tok.text);
        } else if (tok.type === 'text' && tok.text !== undefined) {
          lineBuffer += tok.text;
          writeOut(tok.text);
        } else if (tok.type === 'enter') {
          const submitted = lineBuffer;
          lineBuffer = '';
          writeOut('\n');
          if (!interactions.handleInputLine(submitted)) {
            void submitPrompt(submitted).catch((err) => {
              writeOut(`\nError: ${err instanceof Error ? err.message : String(err)}\n`);
              renderPromptLine();
            });
          }
        }
      }
    };
    process.stdin.on('data', onData);
  }

  ctx.effect(() => () => {
    if (interactive) {
      writeOut('\x1b[?2004l');
      if (onData) process.stdin.off('data', onData);
      if (onResize) process.stdout?.off('resize', onResize);
      process.stdin.pause();
      if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
        try {
          process.stdin.setRawMode(false);
        } catch {
          /* ignore */
        }
      }
    }
    interactions.clearSessionGrants();
    for (const d of disposers) d();
  });
}
