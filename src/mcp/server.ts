#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { parseCommand } from '@deepseek-ai/dsh-commands';
import { renderDiffBlock, renderFooter, renderHeader, type TuiStatusSnapshot } from '../core/index.js';

const PKG_VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: string };
    return pkg.version ?? '0.1.0';
  } catch {
    return '0.1.0';
  }
})();

const TOOLS = [
  {
    name: 'tui_format_status',
    description: 'Render Claude Code / agy-style header & 2-line terminal status footer.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string' },
        sessionId: { type: 'string' },
        model: { type: 'string' },
        effort: { type: 'string' },
        branch: { type: 'string' },
        columns: { type: 'integer' },
        planMode: { type: 'boolean' },
        switchyardTier: { type: 'string' },
        contextPercent: { type: 'number' },
        forewispStrategy: { type: 'string' },
        forewispOffers: { type: 'integer' },
        cugaMode: { type: 'string' },
        tokensUsed: { type: 'integer' },
        running: { type: 'boolean' },
      },
      required: ['model'],
    },
  },
  {
    name: 'tui_format_diff',
    description: 'Format a bounded unified diff card for terminal display.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        oldText: { type: ['string', 'null'] },
        newText: { type: 'string' },
        maxLines: { type: 'integer' },
      },
      required: ['path', 'newText'],
    },
  },
  {
    name: 'tui_parse_command',
    description: 'Parse a TUI slash command line into { isCommand, name, rawInput }.',
    inputSchema: {
      type: 'object',
      properties: {
        line: { type: 'string' },
      },
      required: ['line'],
    },
  },
];

const SUPPORTED_PROTOCOLS = new Set(['2024-11-05', '2025-03-26', '2025-06-18']);

export async function startMcpServer(): Promise<void> {
  const write = (msg: unknown) => process.stdout.write(`${JSON.stringify(msg)}\n`);
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let parsedRaw: unknown;
    try {
      parsedRaw = JSON.parse(line);
    } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      continue;
    }
    if (!parsedRaw || typeof parsedRaw !== 'object' || Array.isArray(parsedRaw)) {
      write({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
      continue;
    }
    const req = parsedRaw as { id?: string | number | null; method?: string; params?: Record<string, unknown> };
    if (req.method === 'notifications/initialized' || (req.id === undefined && typeof req.method === 'string' && req.method.startsWith('notifications/'))) {
      continue;
    }
    if (req.id === undefined || typeof req.method !== 'string') {
      if (req.id !== undefined) {
        write({ jsonrpc: '2.0', id: req.id, error: { code: -32600, message: 'Invalid Request' } });
      }
      continue;
    }

    try {
      if (req.method === 'initialize') {
        const reqProto = typeof req.params?.protocolVersion === 'string' ? req.params.protocolVersion : '';
        const protocolVersion = SUPPORTED_PROTOCOLS.has(reqProto) ? reqProto : '2024-11-05';
        write({
          jsonrpc: '2.0',
          id: req.id,
          result: {
            protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'ns-tui', version: PKG_VERSION },
          },
        });
      } else if (req.method === 'tools/list') {
        write({ jsonrpc: '2.0', id: req.id, result: { tools: TOOLS } });
      } else if (req.method === 'tools/call') {
        try {
          const params = (req.params ?? {}) as { name?: string; arguments?: unknown };
          const toolName = params.name ?? '';
          const rawArgs = params.arguments;
          if (rawArgs !== undefined && (typeof rawArgs !== 'object' || rawArgs === null || Array.isArray(rawArgs))) {
            write({
              jsonrpc: '2.0',
              id: req.id,
              error: { code: -32602, message: 'Invalid params: arguments must be an object' },
            });
            continue;
          }
          const a = (rawArgs as Record<string, unknown>) ?? {};
          let out: unknown;
          if (toolName === 'tui_format_status') {
            const modelName = typeof a.model === 'string' ? a.model.trim() : '';
            if (!modelName) {
              throw new Error('model string is required');
            }
            const cols = Number.isFinite(a.columns) ? Math.max(40, Math.min(400, Math.trunc(Number(a.columns)))) : 100;
            const snap: TuiStatusSnapshot = {
              cwd: typeof a.cwd === 'string' && a.cwd ? a.cwd : process.cwd(),
              sessionId: typeof a.sessionId === 'string' && a.sessionId ? a.sessionId : 'new',
              model: modelName,
              effort: typeof a.effort === 'string' ? a.effort : undefined,
              branch: typeof a.branch === 'string' ? a.branch : undefined,
              planMode: typeof a.planMode === 'boolean' ? a.planMode : undefined,
              switchyardTier: typeof a.switchyardTier === 'string' ? a.switchyardTier : undefined,
              contextPercent: Number.isFinite(a.contextPercent) ? Number(a.contextPercent) : undefined,
              forewispStrategy: typeof a.forewispStrategy === 'string' ? a.forewispStrategy : undefined,
              forewispOffers: Number.isFinite(a.forewispOffers) ? Math.trunc(Number(a.forewispOffers)) : undefined,
              cugaMode: typeof a.cugaMode === 'string' ? a.cugaMode : undefined,
              tokensUsed: Number.isFinite(a.tokensUsed) ? Math.trunc(Number(a.tokensUsed)) : undefined,
              running: typeof a.running === 'boolean' ? a.running : undefined,
            };
            out = {
              rendered: `${renderHeader(snap, cols, true)}\n${renderFooter(snap, cols, true)}`,
            };
          } else if (toolName === 'tui_format_diff') {
            if (typeof a.path !== 'string' || typeof a.newText !== 'string') {
              throw new Error('path and newText strings are required');
            }
            if (a.newText.length > 262_144 || (typeof a.oldText === 'string' && a.oldText.length > 262_144)) {
              throw new Error('Diff text exceeds 256KB display cap');
            }
            if (a.oldText !== undefined && a.oldText !== null && typeof a.oldText !== 'string') {
              throw new Error('oldText must be a string or null');
            }
            const maxLines = Number.isFinite(a.maxLines) ? Math.max(4, Math.min(500, Math.trunc(Number(a.maxLines)))) : 24;
            out = {
              rendered: renderDiffBlock(
                {
                  path: a.path,
                  oldText: typeof a.oldText === 'string' ? a.oldText : null,
                  newText: a.newText,
                },
                { maxLines, noColor: true },
              ),
            };
          } else if (toolName === 'tui_parse_command') {
            if (typeof a.line !== 'string') throw new Error('line string is required');
            const parsed = parseCommand(a.line);
            out = {
              isCommand: Boolean(parsed),
              name: parsed?.name ?? null,
              rawInput: parsed?.rawInput ?? '',
            };
          } else {
            throw new Error(`Unknown tool: ${toolName}`);
          }
          write({
            jsonrpc: '2.0',
            id: req.id,
            result: { content: [{ type: 'text', text: JSON.stringify(out) }] },
          });
        } catch (toolErr) {
          write({
            jsonrpc: '2.0',
            id: req.id,
            result: {
              content: [{ type: 'text', text: toolErr instanceof Error ? toolErr.message : String(toolErr) }],
              isError: true,
            },
          });
        }
      } else if (req.method === 'ping') {
        write({ jsonrpc: '2.0', id: req.id, result: {} });
      } else {
        write({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: `Method not found: ${req.method}` } });
      }
    } catch (err) {
      write({
        jsonrpc: '2.0',
        id: req.id,
        error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
      });
    }
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  startMcpServer().catch((err) => {
    process.stderr.write(`ns-tui MCP server fatal error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
