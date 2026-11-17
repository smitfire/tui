import { execFile, execFileSync } from 'node:child_process';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import z from '@deepseek-ai/schemastery';
import { isLoopbackHost } from '@deepseek-ai/dsh-host-webserver';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { BracketedPasteParser, TerminalInteractionController, renderDiffBlock, renderFooter, renderHeader, renderToolBadge, } from '../core/index.js';
export const name = 'ns-tui';
export const inject = ['agents', 'commands', 'tools', 'sessions', 'systemPrompt'];
export const Config = z.object({
    enabled: z.boolean(),
    interactive: z.boolean(),
    resume: z.string(),
    appName: z.string().default('ns-dsh'),
    version: z.string().default('0.1.0'),
});
const VALID_SESSION_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
let lastPersistedSessionKey;
function readPersistedLastSessionId() {
    const stateDir = process.env.NS_DSH_STATE_DIR?.trim();
    if (!stateDir || process.env.NS_DSH_NEW_SESSION === '1')
        return undefined;
    try {
        const file = join(stateDir, 'last-session.json');
        if (!existsSync(file))
            return undefined;
        const parsed = JSON.parse(readFileSync(file, 'utf8'));
        if (typeof parsed.cwd !== 'string' || resolve(parsed.cwd) !== resolve(process.cwd())) {
            return undefined;
        }
        const sid = typeof parsed.sessionId === 'string' ? parsed.sessionId.trim() : '';
        return VALID_SESSION_ID_RE.test(sid) ? sid : undefined;
    }
    catch {
        return undefined;
    }
}
function writePersistedLastSessionId(sessionId) {
    if (process.env.NS_DSH_NEW_SESSION === '1')
        return;
    const stateDir = process.env.NS_DSH_STATE_DIR?.trim();
    if (!stateDir || !VALID_SESSION_ID_RE.test(sessionId))
        return;
    const cwd = resolve(process.cwd());
    const cacheKey = `${stateDir}::${cwd}::${sessionId}`;
    if (cacheKey === lastPersistedSessionKey)
        return;
    try {
        mkdirSync(stateDir, { recursive: true, mode: 0o700 });
        const target = join(stateDir, 'last-session.json');
        const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
        writeFileSync(tmp, `${JSON.stringify({ sessionId, cwd, updatedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
        renameSync(tmp, target);
        lastPersistedSessionKey = cacheKey;
    }
    catch {
        /* best-effort persistence */
    }
}
const LOOPBACK_ORIGIN_RE = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i;
const LOOPBACK_HOST_RE = /^(?:127\.\d+\.\d+\.\d+|localhost|\[::1\]|::1)(?::\d+)?$/i;
const LOOPBACK_REMOTE_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const EPHEMERAL_CONTROL_TOKEN = randomBytes(24).toString('hex');
function isLoopbackRequest(req, requireControlToken = false) {
    const remoteAddr = req.socket?.remoteAddress;
    if (typeof remoteAddr === 'string' && remoteAddr.length > 0 && !LOOPBACK_REMOTE_ADDRS.has(remoteAddr)) {
        return false;
    }
    const host = String(req.headers.host ?? '');
    if (!host || !LOOPBACK_HOST_RE.test(host))
        return false;
    const secFetchSite = req.headers['sec-fetch-site'];
    if (typeof secFetchSite === 'string' && secFetchSite !== 'same-origin' && secFetchSite !== 'none') {
        return false;
    }
    const origin = req.headers.origin;
    if (typeof origin === 'string' && origin.length > 0 && !LOOPBACK_ORIGIN_RE.test(origin)) {
        return false;
    }
    if (requireControlToken) {
        const expected = process.env.NS_DSH_TUI_TOKEN?.trim() || EPHEMERAL_CONTROL_TOKEN;
        const providedHeader = req.headers['x-ns-tui-token'];
        const provided = typeof providedHeader === 'string' ? providedHeader.trim() : '';
        const a = Buffer.from(provided, 'utf8');
        const b = Buffer.from(expected, 'utf8');
        if (a.length !== b.length || !timingSafeEqual(a, b))
            return false;
    }
    return true;
}
function sendJson(res, statusCode, body) {
    if (res.writableEnded || res.destroyed)
        return;
    res.writeHead(statusCode, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        ...(statusCode === 413 ? { connection: 'close' } : {}),
    });
    res.end(JSON.stringify(body));
}
async function readJsonBody(req, limitBytes = 32_768) {
    return new Promise((resolveBody, rejectBody) => {
        const chunks = [];
        let total = 0;
        let settled = false;
        const fail = (err) => {
            if (settled)
                return;
            settled = true;
            rejectBody(err);
        };
        req.on('data', (c) => {
            if (settled)
                return;
            total += c.length;
            if (total > limitBytes) {
                req.resume();
                fail(Object.assign(new Error('request body exceeds 32KB limit'), { statusCode: 413 }));
                return;
            }
            chunks.push(c);
        });
        req.on('end', () => {
            if (settled)
                return;
            settled = true;
            try {
                const raw = Buffer.concat(chunks).toString('utf8').trim();
                resolveBody(raw ? JSON.parse(raw) : {});
            }
            catch {
                rejectBody(Object.assign(new Error('invalid JSON body'), { statusCode: 400 }));
            }
        });
        req.on('error', fail);
        req.on('aborted', () => fail(Object.assign(new Error('request aborted'), { statusCode: 400 })));
    });
}
const GIT_BRANCH_CACHE = new Map();
function refreshGitBranchAsync(cwd) {
    const existing = GIT_BRANCH_CACHE.get(cwd);
    if (existing?.pending)
        return;
    if (GIT_BRANCH_CACHE.size >= 16) {
        const oldestKey = GIT_BRANCH_CACHE.keys().next().value;
        if (oldestKey)
            GIT_BRANCH_CACHE.delete(oldestKey);
    }
    GIT_BRANCH_CACHE.set(cwd, { value: existing?.value, at: Date.now(), pending: true });
    execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, encoding: 'utf8', timeout: 1500 }, (err, stdout) => {
        const value = !err && stdout ? stdout.trim() : existing?.value;
        GIT_BRANCH_CACHE.set(cwd, { value, at: Date.now(), pending: false });
    });
}
function readGitBranch(cwd) {
    const now = Date.now();
    const hit = GIT_BRANCH_CACHE.get(cwd);
    if (!hit || now - hit.at > 15_000) {
        refreshGitBranchAsync(cwd);
    }
    return hit?.value;
}
const VALID_EFFORTS = new Set(['low', 'medium', 'high', 'max']);
function pickStringField(obj, keys) {
    for (const k of keys) {
        if (typeof obj[k] === 'string')
            return obj[k];
    }
    return undefined;
}
// Canonical DSH & MCP file mutation tool names eligible for diff preview cards.
const DIFF_TOOL_KINDS = new Map([
    ['edit', 'edit'],
    ['edit_file', 'edit'],
    ['apply_patch', 'edit'],
    ['patch', 'edit'],
    ['multi_edit', 'edit'],
    ['str_replace', 'edit'],
    ['replace_in_file', 'edit'],
    ['write', 'write'],
    ['write_file', 'write'],
    ['create_file', 'write'],
    ['fs_write', 'write'],
]);
function extractDiffFromToolArgs(toolName, rawArgs) {
    const kind = DIFF_TOOL_KINDS.get(toolName.trim().toLowerCase());
    if (!kind || !rawArgs || typeof rawArgs !== 'object' || Array.isArray(rawArgs))
        return undefined;
    const a = rawArgs;
    const path = pickStringField(a, ['file_path', 'path']);
    if (!path)
        return undefined;
    const newText = pickStringField(a, ['new_string', 'newText', 'content', 'replacement']);
    if (newText === undefined)
        return undefined;
    const oldMatch = pickStringField(a, ['old_string', 'oldText', 'target']);
    if (kind === 'edit' && oldMatch === undefined)
        return undefined;
    return { path, oldText: kind === 'write' ? null : (oldMatch ?? ''), newText };
}
export function apply(ctx, rawConfig = {}) {
    const enabled = rawConfig.enabled ?? (rawConfig.interactive !== undefined || process.env.NS_DSH_TUI === '1');
    if (!enabled)
        return;
    const interactive = rawConfig.interactive ?? process.env.NS_DSH_TUI === '1';
    const appName = rawConfig.appName ?? 'ns-dsh';
    const version = rawConfig.version ?? '0.1.0';
    const log = ctx.logger(name);
    let attached = interactive && Boolean(process.stdout?.isTTY);
    let activeHandle;
    let activeAgent;
    let planMode = false;
    let totalTokens = 0;
    let cugaBlocks = 0;
    let expandBadges = false;
    let lineBuffer = '';
    const recentBadges = [];
    const promptHistory = [];
    const cols = () => process.stdout?.columns ?? 100;
    const writeOut = (chunk) => {
        if (interactive && attached) {
            try {
                process.stdout.write(chunk);
            }
            catch {
                /* ignore broken pipe during shutdown */
            }
        }
    };
    const setTtyInteractiveState = (active) => {
        if (!interactive)
            return;
        if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
            try {
                process.stdin.setRawMode(active);
            }
            catch {
                /* non-raw TTY fallback */
            }
        }
        try {
            process.stdout.write(active ? '\x1b[?2004h' : '\x1b[?2004l');
        }
        catch {
            /* ignore */
        }
    };
    let cleanupInteractiveTty = () => { };
    const interactions = new TerminalInteractionController({
        write: writeOut,
        columns: cols,
    });
    const resolveRootAgent = () => {
        if (activeAgent && ctx.agents.get(activeAgent.id))
            return activeAgent;
        const all = ctx.agents.list();
        return all.find((a) => !a.session.header?.parentSession) ?? all[0];
    };
    const buildStatus = () => {
        const agent = resolveRootAgent();
        const sid = agent ? String(agent.session.id) : 'none';
        const cwd = agent?.session.header?.cwd || process.cwd();
        const sel = agent?.model.current();
        const nsCtx = ctx.get('nsContext');
        const nsTeam = ctx.get('nsTeam');
        const nsBoard = ctx.get('nsBoard');
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
        if (!interactive || !attached)
            return;
        writeOut(`\n${renderFooter(buildStatus(), cols())}\n❯ ${lineBuffer}`);
    };
    const ensureRootAgent = async (resumeId) => {
        const prevSid = activeAgent ? String(activeAgent.session.id) : undefined;
        const setActive = (agent, handle) => {
            const nextSid = String(agent.session.id);
            if (prevSid && prevSid !== nextSid)
                interactions.clearSessionGrants();
            if (handle)
                activeHandle = handle;
            activeAgent = agent;
            writePersistedLastSessionId(nextSid);
            return agent;
        };
        const existing = resolveRootAgent();
        if (!resumeId && existing) {
            return setActive(existing);
        }
        const candidateResume = resumeId ?? readPersistedLastSessionId();
        if (candidateResume) {
            const live = ctx.agents.get(SessionId(candidateResume));
            if (live) {
                return setActive(live);
            }
            if (ctx.get('sessionPersistence')) {
                try {
                    const resumed = await ctx.agents.resume({ resumeSessionId: SessionId(candidateResume) });
                    return setActive(resumed.agent, resumed);
                }
                catch (err) {
                    if (resumeId)
                        throw err;
                    const errName = err instanceof Error ? err.name : 'Error';
                    log.debug(`Auto-resume skipped (${errName}); starting fresh session`);
                    writeOut('\n[Previous session unavailable — started fresh session]\n');
                }
            }
        }
        const sid = SessionId(randomUUID());
        const handle = await ctx.agents.create({
            sessionId: sid,
            meta: { cwd: process.cwd() },
        });
        return setActive(handle.agent, handle);
    };
    const dispatchPromptText = async (trimmed) => {
        promptHistory.push(trimmed);
        if (promptHistory.length > 100)
            promptHistory.shift();
        const agent = await ensureRootAgent();
        const content = planMode
            ? `[PLAN MODE: read-only analysis; propose tasks onto the Kanban board instead of editing files]\n${trimmed}`
            : trimmed;
        agent.followup(createUserMessage({
            content: [{ type: 'text', text: content }],
            source: { kind: 'user' },
        }));
    };
    const submitPrompt = async (text) => {
        const trimmed = text.trim();
        if (!trimmed)
            return;
        if (trimmed.startsWith('/')) {
            const result = await executeCommand(trimmed);
            if (result)
                writeOut(`\n${result.text}\n`);
            return;
        }
        await dispatchPromptText(trimmed);
    };
    const executeCommand = async (line) => {
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
    const tuiService = {
        isAttached: () => attached,
        setAttached: (nextAttached) => {
            attached = nextAttached;
            if (!nextAttached) {
                lineBuffer = '';
                setTtyInteractiveState(false);
                return;
            }
            setTtyInteractiveState(true);
            if (interactive) {
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
            lineBuffer = '';
            interactions.handleCtrlC();
            interactions.clearSessionGrants();
            setTtyInteractiveState(false);
            const tmuxSock = process.env.NS_DSH_TMUX_SOCKET;
            if (tmuxSock) {
                try {
                    execFileSync('tmux', ['-L', tmuxSock, 'detach-client'], {
                        stdio: 'ignore',
                        timeout: 1500,
                    });
                }
                catch {
                    /* ignore when not attached inside tmux */
                }
            }
            else if (process.env.TMUX) {
                try {
                    execFileSync('tmux', ['detach-client'], {
                        stdio: 'ignore',
                        timeout: 1500,
                    });
                }
                catch {
                    /* ignore when not attached inside tmux */
                }
            }
            rawConfig.onDetach?.();
        },
        resume: async (sessionId) => {
            const a = await ensureRootAgent(sessionId);
            return { sessionId: String(a.session.id) };
        },
        getStatus: () => buildStatus(),
        submitPrompt,
        executeCommand,
        pendingInteractions: () => interactions.pending(),
    };
    ctx.provide('nsTui', tuiService);
    // Fail-closed read-only PLAN mode guard: permit only known read-only inspection tools
    const PLAN_READONLY_TOOLS = new Set([
        'read',
        'read_file',
        'glob',
        'grep',
        'search',
        'find',
        'list',
        'ls',
        'view',
        'forewisp_search',
        'forewisp_expand',
        'ctx_search',
        'ctx_slice',
        'vars_list',
        'board_view',
        'board_list',
        'switchyard_status',
        'cuga_evaluate_policy',
        'cuga_evaluate_intent',
        'cuga_classify_reasoning',
        'ns_ask_user',
    ]);
    const disposers = [];
    disposers.push(ctx.tools.guard((exec) => {
        if (planMode && !PLAN_READONLY_TOOLS.has(exec.name.toLowerCase())) {
            return { reason: `Read-only PLAN mode only allows read-only tools; blocked "${exec.name}" (/plan off to resume)` };
        }
        return undefined;
    }));
    disposers.push(ctx.systemPrompt.context({
        name: 'ns-tui:mode',
        order: 186,
        interpolate: false,
        text: () => planMode
            ? '<tui-plan-mode>Operator has enabled read-only PLAN mode. Inspect code and propose Kanban tasks instead of mutating workspace files.</tui-plan-mode>'
            : '',
    }));
    // Priority HITL Approval handler: claim inline when attached, else delegate to WebUI via next().
    disposers.push(ctx.on('approval/request', async (req, next) => {
        if (!attached)
            return next();
        try {
            return await interactions.promptApproval({
                toolName: req.toolName,
                reason: req.displayReason?.en ?? req.reason,
                signal: req.signal,
            });
        }
        catch (err) {
            log.warn(`Inline approval error, falling back to next(): ${err instanceof Error ? err.message : String(err)}`);
            return next();
        }
    }, { prepend: true }));
    // Priority HITL Question handler: claim inline when attached, else delegate to WebUI via next().
    disposers.push(ctx.on('user-questions/request', async (req, next) => {
        if (!attached)
            return next();
        try {
            const res = await interactions.promptQuestion({
                questions: req.questions.map((q) => ({
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
        }
        catch (err) {
            log.warn(`Inline user-question error, falling back to next(): ${err instanceof Error ? err.message : String(err)}`);
            return next();
        }
    }, { prepend: true }));
    // Live streaming output, tool badges, PTC savings, and usage telemetry
    const activeAttemptIds = new Set();
    disposers.push(ctx.on('agent/assistant-stream', ({ agent, frame }) => {
        const root = resolveRootAgent();
        if (root && agent.id !== root.id)
            return;
        const attemptId = String(frame.attemptId);
        if (frame.type === 'start') {
            activeAttemptIds.add(attemptId);
            writeOut('\n');
        }
        else if (frame.type === 'chunk') {
            if (frame.chunk.type === 'text-delta' && frame.chunk.text) {
                writeOut(frame.chunk.text);
            }
            else if (frame.chunk.type === 'usage') {
                const u = frame.chunk.usage;
                totalTokens += (u.inputTokens ?? 0) + (u.outputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0);
            }
        }
        else if (frame.type === 'end') {
            activeAttemptIds.delete(attemptId);
            if (activeAttemptIds.size === 0)
                renderPromptLine();
        }
    }));
    disposers.push(ctx.on('tools/result', (exec, result) => {
        const isErr = result?.isError === true;
        const textPreview = (Array.isArray(result?.content) ? result.content : [])
            .filter((b) => b?.type === 'text' && typeof b.text === 'string')
            .map((b) => b.text)
            .join(' ')
            .slice(0, 120);
        if (textPreview.includes('CUGA_'))
            cugaBlocks += 1;
        const diff = extractDiffFromToolArgs(exec.name, exec.arguments);
        const badge = {
            toolName: exec.name,
            summary: textPreview || (isErr ? 'error' : 'ok'),
            ok: !isErr,
            ...(diff ? { diff } : {}),
        };
        recentBadges.push(badge);
        if (recentBadges.length > 30)
            recentBadges.shift();
        writeOut(`\n${renderToolBadge(badge, expandBadges, cols())}\n`);
    }));
    // Safe slash command registration (never throws on duplicate across plugins)
    const regCmd = (cmdName, description, handler) => {
        try {
            disposers.push(ctx.commands.register({
                name: cmdName,
                description,
                handler: async (inv) => handler({ agent: inv.agent, rawInput: inv.rawInput }),
            }));
        }
        catch (err) {
            log.warn(`Skipped registering /${cmdName}: ${err instanceof Error ? err.message : String(err)}`);
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
        await dispatchPromptText(arg);
        return { kind: 'success', text: `Submitted planning prompt in PLAN mode.` };
    });
    const listBoardHandler = () => {
        const nsBoard = ctx.get('nsBoard');
        if (!nsBoard?.snapshot)
            return { kind: 'error', text: 'ns-board service is unavailable' };
        const cards = nsBoard.snapshot().cards;
        if (cards.length === 0)
            return { kind: 'success', text: 'Board has 0 cards.' };
        return {
            kind: 'success',
            text: cards
                .map((c) => `${c.id} | ${c.column} | ${c.owner} | ${c.title}${c.blockedBy?.length ? ` (blockedBy: ${c.blockedBy.join(',')})` : ''}`)
                .join('\n'),
        };
    };
    regCmd('tasks', 'List Kanban board tasks', listBoardHandler);
    regCmd('board', 'List Kanban board cards & dependencies', listBoardHandler);
    for (const op of ['pickup', 'pause', 'resume-task', 'cancel']) {
        regCmd(op, `${op} Kanban card <cardId>`, ({ rawInput }) => {
            const cardId = rawInput.trim();
            if (!cardId)
                return { kind: 'error', text: `Usage: /${op} <cardId>` };
            const nsBoard = ctx.get('nsBoard');
            if (!nsBoard?.getCard || !nsBoard?.moveCard)
                return { kind: 'error', text: 'ns-board unavailable' };
            const card = nsBoard.getCard(cardId);
            if (!card)
                return { kind: 'error', text: `Card not found: ${cardId}` };
            const col = op === 'cancel' ? 'done' : op === 'pause' ? 'blocked' : 'ready';
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
        const nsCtx = ctx.get('nsContext');
        if (!nsCtx)
            return { kind: 'error', text: 'ns-context unavailable' };
        const q = rawInput.trim();
        if (!q) {
            return { kind: 'success', text: JSON.stringify(await nsCtx.stats?.(), null, 2) };
        }
        const res = await nsCtx.retrieve?.(q, String(agent.session.id));
        if (!res || res.offers.length === 0)
            return { kind: 'success', text: `Forewisp (${res?.tier ?? 'unknown'}): 0 matches.` };
        return {
            kind: 'success',
            text: res.offers.map((o) => `• ${o.id}: ${o.title} — ${o.summary}`).join('\n'),
        };
    });
    regCmd('cuga', 'Inspect CUGA policy state and crystallized playbooks', ({ agent }) => {
        const nsCuga = ctx.get('nsCuga');
        if (!nsCuga?.getSessionState)
            return { kind: 'error', text: 'ns-cuga unavailable' };
        return { kind: 'success', text: JSON.stringify(nsCuga.getSessionState(String(agent.session.id)) ?? { blocks: cugaBlocks }, null, 2) };
    });
    regCmd('switchyard', 'Inspect Switchyard adaptive routing tier and TOML', () => {
        const nsTeam = ctx.get('nsTeam');
        if (!nsTeam?.router?.stateFor)
            return { kind: 'error', text: 'ns-team unavailable' };
        const sid = tuiService.activeSessionId() ?? 'default';
        const state = nsTeam.router.stateFor(sid);
        const toml = nsTeam.exportRoutesToml?.();
        return {
            kind: 'success',
            text: JSON.stringify(toml ? { ...state, routesTomlPreview: toml.split('\n').slice(0, 8) } : state, null, 2),
        };
    });
    regCmd('watchdog', 'Inspect anti-stall watchdog status and auto-resume events', () => {
        const nsTeam = ctx.get('nsTeam');
        if (!nsTeam?.watchdog?.getStatus) {
            return {
                kind: 'success',
                text: JSON.stringify({ active: false, reason: 'ns-team watchdog unavailable' }, null, 2),
            };
        }
        return {
            kind: 'success',
            text: JSON.stringify(nsTeam.watchdog.getStatus(tuiService.activeSessionId()), null, 2),
        };
    });
    regCmd('history', 'Show recent prompts entered in this TUI', () => ({
        kind: 'success',
        text: promptHistory.length ? promptHistory.map((p, i) => `${i + 1}. ${p}`).join('\n') : 'No prompts submitted yet.',
    }));
    regCmd('model', 'Inspect or switch provider/model/effort (/model <provider>/<model> [effort])', ({ agent, rawInput }) => {
        const trimmed = rawInput.trim();
        if (!trimmed) {
            return { kind: 'success', text: JSON.stringify(agent.model.current() ?? null) };
        }
        const [routeSpec, effort] = trimmed.split(/\s+/);
        if (effort && !VALID_EFFORTS.has(effort)) {
            return { kind: 'error', text: `Invalid effort "${effort}". Expected one of: low, medium, high, max.` };
        }
        const slash = routeSpec.indexOf('/');
        const provider = slash > 0 ? routeSpec.slice(0, slash) : agent.model.current()?.provider ?? 'google-antigravity';
        const model = slash > 0 ? routeSpec.slice(slash + 1) : routeSpec;
        agent.model.select({
            provider,
            model,
            ...(effort ? { reasoningEffort: effort } : {}),
        });
        return { kind: 'success', text: `Model switched to ${provider}/${model}${effort ? ` (${effort})` : ''}.` };
    });
    regCmd('quota', 'Show current provider/budget usage counters', () => ({
        kind: 'success',
        text: JSON.stringify({ tokensUsed: totalTokens, cugaBlocks, sessionId: tuiService.activeSessionId() }, null, 2),
    }));
    regCmd('resume', 'Resume an existing session (/resume <sessionId>)', async ({ rawInput }) => {
        const sid = rawInput.trim();
        if (!sid)
            return { kind: 'error', text: 'Usage: /resume <sessionId>' };
        try {
            const out = await tuiService.resume(sid);
            return { kind: 'success', text: `Resumed session ${out.sessionId}` };
        }
        catch (err) {
            return { kind: 'error', text: err instanceof Error ? err.message : String(err) };
        }
    });
    regCmd('exit', 'Detach TUI client while leaving background host and workers alive', () => {
        tuiService.detach();
        return { kind: 'success', text: 'Detached TUI client; background host remains active.' };
    });
    regCmd('shutdown', 'Stop persistent ns-dsh host cleanly', () => {
        cleanupInteractiveTty();
        setTimeout(() => {
            void (async () => {
                for (const agent of ctx.agents.list()) {
                    if (agent.status === 'running') {
                        try {
                            agent.cancel({ kind: 'disposed' });
                        }
                        catch {
                            /* ignore */
                        }
                    }
                }
                await Promise.resolve(activeHandle?.dispose()).catch(() => { });
                const root = ctx.root;
                await Promise.resolve(root?.stop?.()).catch(() => { });
                setTimeout(() => process.kill(process.pid, 'SIGTERM'), 50).unref();
            })();
        }, 25);
        return { kind: 'success', text: 'Shutting down ns-dsh host...' };
    });
    // Register interactive tool so model can ask questions via ctx.userQuestions (inline when attached, WebUI when detached)
    if (ctx.get('userQuestions')) {
        disposers.push(ctx.tools.register(defineTool({
            name: 'ns_ask_user',
            description: 'Ask the human user a blocking structured question (inline in attached TUI, or WebUI when detached).',
            parameters: {
                question: { type: 'string', required: true, description: 'Question to show the user.' },
                options: { type: 'array', items: { type: 'string' }, description: 'Optional choice labels.' },
            },
            output: {
                schema: {
                    type: 'object',
                    properties: {
                        answered: { type: 'boolean' },
                        reason: { type: 'string' },
                        answers: { type: 'array', items: { type: 'object', additionalProperties: true } },
                    },
                    additionalProperties: true,
                },
                render: (_args, val) => [{ type: 'text', text: JSON.stringify(val) }],
            },
            execute: async (args, exec) => {
                if (typeof args.question !== 'string' || !args.question.trim()) {
                    return { answered: false, reason: 'question string is required' };
                }
                const uq = ctx.get('userQuestions');
                if (!uq)
                    return { answered: false, reason: 'userQuestions service absent' };
                const res = await uq.ask({
                    agent: exec.agent,
                    signal: exec.signal,
                    questions: [
                        {
                            id: 'q1',
                            question: args.question.trim(),
                            options: Array.isArray(args.options)
                                ? args.options.map((label) => ({ label: String(label) }))
                                : undefined,
                        },
                    ],
                });
                return {
                    answered: res.answers.length > 0,
                    answers: res.answers.map((a) => {
                        const entry = {
                            id: a.id,
                            selected: [...a.selected],
                        };
                        if (a.custom !== undefined)
                            entry.custom = a.custom;
                        return entry;
                    }),
                };
            },
        })));
    }
    // Loopback HTTP routes on WebServer so tmux launcher can flip attached state cleanly
    ctx.inject(['webServer'], (webCtx) => {
        const server = webCtx.webServer;
        if (!isLoopbackHost(server.host))
            return;
        const webDisposers = [
            server.register({
                kind: 'exact',
                path: '/ns-tui/api/status',
                handler: (req, res) => {
                    if (req.method !== 'GET')
                        return sendJson(res, 405, { error: 'method not allowed' });
                    if (!isLoopbackRequest(req))
                        return sendJson(res, 403, { error: 'loopback required' });
                    sendJson(res, 200, buildStatus());
                },
            }),
            server.register({
                kind: 'exact',
                path: '/ns-tui/api/attach',
                handler: async (req, res) => {
                    if (req.method !== 'POST')
                        return sendJson(res, 405, { error: 'method not allowed' });
                    if (!isLoopbackRequest(req, true))
                        return sendJson(res, 403, { error: 'loopback & valid control token required' });
                    try {
                        const body = await readJsonBody(req);
                        tuiService.setAttached(Boolean(body.attached));
                        sendJson(res, 200, { ok: true, attached });
                    }
                    catch (err) {
                        const rawCode = err.statusCode;
                        const code = typeof rawCode === 'number' && Number.isInteger(rawCode) && rawCode >= 400 && rawCode <= 599 ? rawCode : 400;
                        sendJson(res, code, { error: err instanceof Error ? err.message : String(err) });
                    }
                },
            }),
            server.register({
                kind: 'exact',
                path: '/ns-tui/api/resume',
                handler: async (req, res) => {
                    if (req.method !== 'POST')
                        return sendJson(res, 405, { error: 'method not allowed' });
                    if (!isLoopbackRequest(req, true))
                        return sendJson(res, 403, { error: 'loopback & valid control token required' });
                    try {
                        const body = await readJsonBody(req);
                        const sid = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
                        if (!sid)
                            return sendJson(res, 400, { error: 'sessionId string is required' });
                        const out = await tuiService.resume(sid);
                        sendJson(res, 200, { ok: true, sessionId: out.sessionId });
                    }
                    catch (err) {
                        const rawCode = err.statusCode;
                        const code = typeof rawCode === 'number' && Number.isInteger(rawCode) && rawCode >= 400 && rawCode <= 599 ? rawCode : 400;
                        sendJson(res, code, { error: err instanceof Error ? err.message : String(err) });
                    }
                },
            }),
        ];
        webCtx.effect(() => () => {
            for (const d of webDisposers)
                d();
        });
    });
    // Live TTY input reader when interactive mode is enabled
    let parser;
    let onData;
    let onResize;
    if (interactive) {
        parser = new BracketedPasteParser();
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
            if (attached)
                renderPromptLine();
        };
        process.stdout?.on('resize', onResize);
        onData = (chunk) => {
            if (!attached)
                return;
            for (const tok of parser.feed(chunk)) {
                if (tok.type === 'ctrl_c') {
                    if (!interactions.handleCtrlC()) {
                        const a = resolveRootAgent();
                        if (a && a.status === 'running') {
                            activeAttemptIds.clear();
                            a.cancel({ kind: 'user' });
                            writeOut('\n[Turn aborted via Ctrl+C]\n');
                        }
                        else {
                            lineBuffer = '';
                            writeOut('\n^C\n');
                        }
                    }
                    renderPromptLine();
                }
                else if (tok.type === 'ctrl_o') {
                    expandBadges = !expandBadges;
                    const last = recentBadges.at(-1);
                    if (last)
                        writeOut(`\n${renderToolBadge(last, expandBadges, cols())}\n`);
                    renderPromptLine();
                }
                else if (tok.type === 'ctrl_l') {
                    writeOut('\x1b[2J\x1b[H');
                    writeOut(`${renderHeader(buildStatus(), cols())}\n`);
                    renderPromptLine();
                }
                else if (tok.type === 'escape') {
                    if (interactions.hasActivePrompt()) {
                        interactions.handleCtrlC();
                        renderPromptLine();
                    }
                }
                else if (tok.type === 'backspace') {
                    if (lineBuffer.length > 0) {
                        lineBuffer = Array.from(lineBuffer).slice(0, -1).join('');
                        writeOut('\b \b');
                    }
                }
                else if (tok.type === 'paste' && tok.text !== undefined) {
                    lineBuffer += tok.text;
                    writeOut(tok.text);
                }
                else if (tok.type === 'text' && tok.text !== undefined) {
                    lineBuffer += tok.text;
                    writeOut(tok.text);
                }
                else if (tok.type === 'enter') {
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
        setTtyInteractiveState(attached);
        let ttyCleaned = false;
        cleanupInteractiveTty = () => {
            if (ttyCleaned)
                return;
            ttyCleaned = true;
            setTtyInteractiveState(false);
            if (onData)
                process.stdin.off('data', onData);
            if (onResize)
                process.stdout?.off('resize', onResize);
            // Release stdin ref only on final plugin teardown so test/daemon loops exit cleanly.
            process.stdin.pause();
            if (!process.stdin.isTTY) {
                process.stdin.unref?.();
            }
        };
    }
    ctx.effect(() => () => {
        if (interactive)
            cleanupInteractiveTty();
        interactions.clearSessionGrants();
        for (const d of disposers)
            d();
    });
}
//# sourceMappingURL=index.js.map