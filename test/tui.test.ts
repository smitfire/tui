import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Context } from '@deepseek-ai/cordis';
import CommandsService from '@deepseek-ai/dsh-commands';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolsService from '@deepseek-ai/dsh-tools';
import {
  BracketedPasteParser,
  TerminalInteractionController,
  renderApprovalBox,
  renderDiffBlock,
  renderFooter,
  renderHeader,
  renderToolBadge,
} from '../dist/core/index.js';
import * as tuiPlugin from '../dist/dsh/index.js';

test('Claude Code / agy renderer handles headers, badges, unified diffs, footer clamping, and Unicode bracketed paste', () => {
  const status = {
    appName: 'ns-dsh',
    version: '0.2.0',
    cwd: '/tmp/work/demo-repo',
    branch: 'main',
    sessionId: 'abc12345def67890',
    model: 'antigravity-gemini-3.8-flash',
    effort: 'high',
    switchyardTier: 'capable',
    switchyardEscalations: 1,
    contextPercent: 18,
    forewispStrategy: 'jev',
    forewispOffers: 2,
    jevCostUsd: 0.0042,
    cugaMode: 'enforce',
    cugaBlocks: 1,
    activeCard: 'card-auth [in_progress]',
    tokensUsed: 12450,
  };

  const hdr = renderHeader(status, 72, true);
  assert.ok(hdr.includes('ns-dsh v0.2.0'));
  assert.ok(hdr.includes('demo-repo (main)'));

  const diff = renderDiffBlock(
    { path: 'src/auth.ts', oldText: 'return a === b;', newText: 'return timingSafeEqual(a, b);' },
    { columns: 80, noColor: true },
  );
  assert.match(diff, /@@ src\/auth\.ts @@/);
  assert.match(diff, /- return a === b;/);
  assert.match(diff, /\+ return timingSafeEqual\(a, b\);/);

  const badge = renderToolBadge(
    { toolName: 'Edit', summary: 'src/auth.ts (+1 -1)', ok: true, diff: { path: 'src/auth.ts', oldText: 'a', newText: 'b' } },
    true,
    80,
    true,
  );
  assert.match(badge, /Edit src\/auth\.ts/);

  const footerClamped = renderFooter(status, 60, true);
  for (const line of footerClamped.split('\n')) {
    assert.ok(line.length <= 60);
  }
  const footerFull = renderFooter(status, 140, true);
  assert.match(footerFull, /Forewisp: jev \(2\)/);
  assert.match(footerFull, /JEV \$0\.0042/);

  const approvalText = renderApprovalBox(
    { id: '1', toolName: 'bash', code: 'CUGA_MUTATION_GATE', reason: 'Sensitive command', commandPreview: 'npm publish' },
    80,
    true,
  );
  assert.match(approvalText, /\[y\] Allow once/);

  // Split multi-chunk bracketed paste with Unicode + Ctrl+C
  const parser = new BracketedPasteParser();
  const t1 = parser.feed('\x1b[200~Hello Zürich ');
  assert.equal(t1.length, 0);
  const t2 = parser.feed('日本語 🚀\x1b[201~\r\n\x03');
  assert.deepEqual(t2, [
    { type: 'paste', text: 'Hello Zürich 日本語 🚀' },
    { type: 'enter' },
    { type: 'ctrl_c' },
  ]);
});

test('TerminalInteractionController handles Ctrl+C reject, [y]/[a] grants, and multi-question selection', async () => {
  const output: string[] = [];
  const ctrl = new TerminalInteractionController({ write: (s) => output.push(s), columns: () => 90 });

  // 1. Ctrl+C dismisses active approval prompt cleanly
  const p1 = ctrl.promptApproval({ toolName: 'bash', reason: 'rm temp', code: 'CUGA_MUTATION_GATE' });
  assert.equal(ctrl.hasActivePrompt(), true);
  assert.equal(ctrl.handleCtrlC(), true);
  assert.equal(await p1, 'rejected');
  assert.equal(ctrl.hasActivePrompt(), false);

  // 2. 'a' grants session-level approval for non-shell/non-CUGA tools, while refusing blanket 'a' on high-risk tools
  const pRisky = ctrl.promptApproval({ toolName: 'bash', reason: 'rm temp', code: 'CUGA_MUTATION_GATE', commandPreview: 'rm -rf tmp' });
  assert.equal(ctrl.handleInputLine('a'), true);
  assert.equal(ctrl.hasSessionGrant('bash'), false);
  assert.equal(ctrl.handleInputLine('y'), true);
  assert.equal(await pRisky, 'allowed-once');

  const p2 = ctrl.promptApproval({ toolName: 'read_file', reason: 'inspect config' });
  assert.equal(ctrl.handleInputLine('a'), true);
  assert.equal(await p2, 'allowed-once');
  assert.equal(ctrl.hasSessionGrant('read_file'), true);
  const p2Repeat = await ctrl.promptApproval({ toolName: 'read_file', reason: 'inspect config 2' });
  assert.equal(p2Repeat, 'allowed-once');

  // 3. Multi-question flow with numeric + custom answers
  const qProm = ctrl.promptQuestion({
    questions: [
      { id: 'q1', question: 'Pick flavor?', options: [{ label: 'OptionA' }, { label: 'OptionB' }] },
      { id: 'q2', question: 'Extra note?' },
    ],
  });
  assert.equal(ctrl.handleInputLine('2'), true);
  assert.equal(ctrl.handleInputLine('Ship with soak'), true);
  const ans = await qProm;
  assert.equal(ans.cancelled, false);
  assert.deepEqual(ans.answers, [
    { id: 'q1', selected: ['OptionB'] },
    { id: 'q2', selected: [], custom: 'Ship with soak' },
  ]);
});

test('DSH Cordis plugin routes approval/user-questions inline when attached and falls through to WebUI on detach', async () => {
  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolsService);
  await ctx.plugin(CommandsService);

  const fakeAgent = {
    id: 'sess-tui-1',
    status: 'idle',
    session: { id: 'sess-tui-1', header: { cwd: process.cwd() }, append: () => 1 },
    model: { current: () => ({ provider: 'google-antigravity', model: 'antigravity-gemini-3.8-flash', reasoningEffort: 'high' }) },
    followup: () => {},
    cancel: () => {},
  } as never;

  ctx.provide('agents', {
    get: (id: string) => (String(id) === 'sess-tui-1' ? fakeAgent : undefined),
    list: () => [fakeAgent],
  });
  ctx.provide('sessions', {});

  const fiber = ctx.plugin(tuiPlugin, { interactive: false, appName: 'ns-dsh', version: '0.1.0' });
  await fiber;
  try {
    assert.ok(ctx.nsTui);
    assert.equal(ctx.nsTui.isAttached(), false);

    // Detached -> approval falls through to next() (WebUI answerer)
    const webApproval = await ctx.waterfall(
      'approval/request',
      { agent: fakeAgent, toolName: 'bash' },
      async () => 'allowed-once' as const,
    );
    assert.equal(webApproval, 'allowed-once');

    // Detached -> question falls through to next() (WebUI answerer)
    const webQuestion = await ctx.waterfall(
      'user-questions/request',
      { agent: fakeAgent, questions: [{ id: 'q1', question: 'Confirm?' }] },
      async () => ({ answers: [{ id: 'q1', selected: ['Yes'] }] }),
    );
    assert.deepEqual(webQuestion, { answers: [{ id: 'q1', selected: ['Yes'] }] });

    // Slash command execution works cleanly
    const statusOut = await ctx.nsTui.executeCommand('/status');
    assert.equal(statusOut?.kind, 'success');
    assert.match(statusOut?.text ?? '', /antigravity-gemini-3\.8-flash/);

    const planOut = await ctx.nsTui.executeCommand('/plan on');
    assert.equal(planOut?.kind, 'success');
    assert.match(planOut?.text ?? '', /ENABLED/);
    const guardDenial = ctx.tools.checkGuards({ name: 'edit_file', agent: fakeAgent, arguments: {} } as never);
    assert.ok(guardDenial, 'PLAN mode should block mutating tools via ctx.tools.guard');
  } finally {
    await fiber.dispose();
  }
});

test('Interactive attached TUI handles inline approvals, questions, ns_ask_user tool, and loopback HTTP /ns-tui API', async () => {
  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolsService);
  await ctx.plugin(CommandsService);

  const followups: unknown[] = [];
  const cancellations: unknown[] = [];
  let running = false;
  const fakeAgent = {
    id: 'sess-tui-2',
    get status() {
      return running ? 'running' : 'idle';
    },
    session: { id: 'sess-tui-2', header: { cwd: process.cwd() }, append: () => 1 },
    model: {
      current: () => ({ provider: 'openai-codex', model: 'gpt-6-luna', reasoningEffort: 'medium' }),
      select: () => {},
    },
    followup: (msg: unknown) => {
      followups.push(msg);
    },
    cancel: (cause: unknown) => {
      cancellations.push(cause);
    },
  } as never;

  ctx.provide('agents', {
    get: (id: string) => (String(id) === 'sess-tui-2' ? fakeAgent : undefined),
    list: () => [fakeAgent],
  });
  ctx.provide('sessions', {});
  ctx.provide('userQuestions', {
    ask: async (req: { questions: Array<{ id: string; question: string }> }) =>
      ctx.waterfall(
        'user-questions/request',
        { agent: fakeAgent, questions: req.questions },
        async () => ({ answers: [] }),
      ),
  });

  const routes = new Map<string, (req: any, res: any) => Promise<void> | void>();
  ctx.provide('webServer', {
    host: '127.0.0.1',
    register: (route: { path: string; handler: (req: any, res: any) => Promise<void> | void }) => {
      routes.set(route.path, route.handler);
      return () => routes.delete(route.path);
    },
  });

  let detachedCalled = 0;
  const prevTok = process.env.NS_DSH_TUI_TOKEN;
  process.env.NS_DSH_TUI_TOKEN = 'test-secret-token';
  const fiber = ctx.plugin(tuiPlugin, {
    interactive: true,
    appName: 'ns-dsh',
    version: '0.1.0',
    onDetach: () => {
      detachedCalled += 1;
    },
  });
  await fiber;
  try {
    assert.ok(ctx.nsTui);

  // Helper to invoke registered mock HTTP route handler
  const callHttp = async (
    path: string,
    opts: { method: string; headers?: Record<string, string>; body?: string; remoteAddress?: string },
  ): Promise<{ status: number; json: Record<string, unknown> }> => {
    const handler = routes.get(path);
    assert.ok(handler, `missing route ${path}`);
    const req = Object.assign(new EventEmitter(), {
      method: opts.method,
      headers: opts.headers ?? { host: '127.0.0.1:7430' },
      socket: { remoteAddress: opts.remoteAddress ?? '127.0.0.1' },
      pause: () => {},
      resume: () => {},
    });
    let status = 200;
    let raw = '';
    const done = new Promise<void>((resolve) => {
      const res = {
        writableEnded: false,
        destroyed: false,
        writeHead: (code: number) => {
          status = code;
        },
        end: (chunk = '') => {
          raw += String(chunk);
          res.writableEnded = true;
          resolve();
        },
      };
      void Promise.resolve(handler(req, res));
    });
    if (opts.body !== undefined) {
      queueMicrotask(() => {
        req.emit('data', Buffer.from(opts.body!));
        req.emit('end');
      });
    }
    await done;
    return { status, json: JSON.parse(raw) as Record<string, unknown> };
  };

  // Loopback HTTP tests
  const attachOn = await callHttp('/ns-tui/api/attach', {
    method: 'POST',
    headers: { host: '127.0.0.1:7430', 'x-ns-tui-token': process.env.NS_DSH_TUI_TOKEN ?? 'test-secret-token' },
    body: JSON.stringify({ attached: true }),
  });
  assert.equal(attachOn.status, 200);
  assert.equal(attachOn.json.attached, true);
  assert.equal(ctx.nsTui.isAttached(), true);

  const stOk = await callHttp('/ns-tui/api/status', { method: 'GET' });
  assert.equal(stOk.status, 200);
  assert.equal(stOk.json.attached, true);

  const stMethodErr = await callHttp('/ns-tui/api/status', { method: 'POST' });
  assert.equal(stMethodErr.status, 405);

  const stHostErr = await callHttp('/ns-tui/api/status', {
    method: 'GET',
    headers: { host: 'evil.example' },
  });
  assert.equal(stHostErr.status, 403);

  const stRemoteErr = await callHttp('/ns-tui/api/status', {
    method: 'GET',
    remoteAddress: '10.0.0.99',
  });
  assert.equal(stRemoteErr.status, 403);

  const missingTok = await callHttp('/ns-tui/api/attach', {
    method: 'POST',
    body: JSON.stringify({ attached: true }),
  });
  assert.equal(missingTok.status, 403);
  const validTok = await callHttp('/ns-tui/api/attach', {
    method: 'POST',
    headers: { host: '127.0.0.1:7430', 'x-ns-tui-token': 'test-secret-token' },
    body: JSON.stringify({ attached: true }),
  });
  assert.equal(validTok.status, 200);

  const attachBadJson = await callHttp('/ns-tui/api/attach', {
    method: 'POST',
    headers: { host: '127.0.0.1:7430', 'x-ns-tui-token': 'test-secret-token' },
    body: '{bad json',
  });
  assert.equal(attachBadJson.status, 400);

  const attachTooBig = await callHttp('/ns-tui/api/attach', {
    method: 'POST',
    headers: { host: '127.0.0.1:7430', 'x-ns-tui-token': 'test-secret-token' },
    body: 'x'.repeat(40_000),
  });
  assert.equal(attachTooBig.status, 413);

  const resumeMissing = await callHttp('/ns-tui/api/resume', {
    method: 'POST',
    headers: { host: '127.0.0.1:7430', 'x-ns-tui-token': 'test-secret-token' },
    body: '{}',
  });
  assert.equal(resumeMissing.status, 400);

  const resumeOk = await callHttp('/ns-tui/api/resume', {
    method: 'POST',
    headers: { host: '127.0.0.1:7430', 'x-ns-tui-token': 'test-secret-token' },
    body: JSON.stringify({ sessionId: 'sess-tui-2' }),
  });
  assert.equal(resumeOk.status, 200);
  assert.equal(resumeOk.json.sessionId, 'sess-tui-2');

  // Attached inline approval: [y] -> allowed-once
  const pAllow = ctx.waterfall(
    'approval/request',
    { agent: fakeAgent, toolName: 'edit_file', reason: 'Update auth.ts' },
    async () => 'unavailable' as const,
  );
  await new Promise((r) => setTimeout(r, 10));
  process.stdin.emit('data', Buffer.from('y\r'));
  assert.equal(await pAllow, 'allowed-once');

  // Attached inline approval: Ctrl+C -> rejected
  const pReject = ctx.waterfall(
    'approval/request',
    { agent: fakeAgent, toolName: 'write_file', reason: 'Risky write' },
    async () => 'unavailable' as const,
  );
  await new Promise((r) => setTimeout(r, 10));
  process.stdin.emit('data', Buffer.from('\x03'));
  assert.equal(await pReject, 'rejected');

  // Attached inline user-questions + ns_ask_user tool
  const askTool = ctx.tools.get('ns_ask_user');
  assert.ok(askTool, 'ns_ask_user tool should be registered');
  const toolProm = askTool.execute(
    { question: 'Proceed with deploy?', options: ['Ship', 'Hold'] },
    { agent: fakeAgent, signal: new AbortController().signal } as never,
  );
  await new Promise((r) => setTimeout(r, 10));
  process.stdin.emit('data', Buffer.from('1\r'));
  const toolRes = (await toolProm) as { answers: Array<{ id: string; selected: string[] }> };
  assert.deepEqual(toolRes.answers, [{ id: 'q1', selected: ['Ship'] }]);

  // Ctrl+C cancels running turn with AgentCancelCause { kind: 'user' }
  running = true;
  process.stdin.emit('data', Buffer.from('\x03'));
  assert.deepEqual(cancellations, [{ kind: 'user' }]);
  running = false;

  // Regular prompt submission + slash /help, /diff, /quota, /exit
  process.stdin.emit('data', Buffer.from('Hello agent\r'));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(followups.length, 1);

  const helpOut = await ctx.nsTui.executeCommand('/help');
  assert.equal(helpOut?.kind, 'success');
  assert.match(helpOut?.text ?? '', /\/exit/);

  // tools/result populates diff badge -> /diff renders patch
  ctx.emit(
    'tools/result',
    { name: 'edit_file', arguments: { path: 'src/auth.ts', oldText: 'old()', newText: 'new()' } } as never,
    { isError: false, content: [{ type: 'text', text: 'edited auth.ts' }] } as never,
  );
  const diffOut = await ctx.nsTui.executeCommand('/diff auth.ts');
  assert.equal(diffOut?.kind, 'success');
  assert.match(diffOut?.text ?? '', /\+ new\(\)/);

  const badEffort = await ctx.nsTui.executeCommand('/model openai-codex/gpt-6-luna bogus');
  assert.equal(badEffort?.kind, 'error');

  const histOut = await ctx.nsTui.executeCommand('/history');
  assert.equal(histOut?.kind, 'success');
  assert.match(histOut?.text ?? '', /Hello agent/);

    const exitOut = await ctx.nsTui.executeCommand('/exit');
    assert.equal(exitOut?.kind, 'success');
    assert.equal(ctx.nsTui.isAttached(), false);
    assert.equal(detachedCalled, 1);
  } finally {
    if (prevTok === undefined) delete process.env.NS_DSH_TUI_TOKEN;
    else process.env.NS_DSH_TUI_TOKEN = prevTok;
    await fiber.dispose();
  }
});
