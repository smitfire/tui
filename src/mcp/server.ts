#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { renderDiffBlock, renderFooter, renderHeader, type TuiStatusSnapshot } from '../core/index.js';

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
      },
      required: ['cwd', 'sessionId', 'model'],
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
    description: 'Parse a TUI slash command line into { name, rawInput }.',
    inputSchema: {
      type: 'object',
      properties: {
        line: { type: 'string' },
      },
      required: ['line'],
    },
  },
];

class RpcParamError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

export async function startMcpServer(): Promise<void> {
  const write = (msg: unknown) => process.stdout.write(`${JSON.stringify(msg)}\n`);
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let req: { id?: string | number | null; method?: string; params?: Record<string, unknown> };
    try {
      req = JSON.parse(line);
    } catch {
      continue;
    }
    if (req.id === undefined || req.method === undefined) continue;

    try {
      if (req.method === 'initialize') {
        write({
          jsonrpc: '2.0',
          id: req.id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'ns-tui', version: '0.1.0' },
          },
        });
      } else if (req.method === 'notifications/initialized') {
        continue;
      } else if (req.method === 'tools/list') {
        write({ jsonrpc: '2.0', id: req.id, result: { tools: TOOLS } });
      } else if (req.method === 'tools/call') {
        const params = (req.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
        const toolName = params.name ?? '';
        const a = params.arguments ?? {};
        let out: unknown;
        if (toolName === 'tui_format_status') {
          if (typeof a.cwd !== 'string' || typeof a.sessionId !== 'string' || typeof a.model !== 'string') {
            throw new RpcParamError(-32602, 'cwd, sessionId, and model strings are required');
          }
          const cols = typeof a.columns === 'number' ? a.columns : 100;
          const snap: TuiStatusSnapshot = {
            cwd: a.cwd,
            sessionId: a.sessionId,
            model: a.model,
            effort: typeof a.effort === 'string' ? a.effort : undefined,
            branch: typeof a.branch === 'string' ? a.branch : undefined,
          };
          out = {
            rendered: `${renderHeader(snap, cols, true)}\n${renderFooter(snap, cols, true)}`,
          };
        } else if (toolName === 'tui_format_diff') {
          if (typeof a.path !== 'string' || typeof a.newText !== 'string') {
            throw new RpcParamError(-32602, 'path and newText strings are required');
          }
          out = {
            rendered: renderDiffBlock(
              {
                path: a.path,
                oldText: typeof a.oldText === 'string' ? a.oldText : null,
                newText: a.newText,
              },
              { maxLines: typeof a.maxLines === 'number' ? a.maxLines : 24, noColor: true },
            ),
          };
        } else if (toolName === 'tui_parse_command') {
          if (typeof a.line !== 'string') throw new RpcParamError(-32602, 'line string is required');
          const m = a.line.trim().match(/^\/([a-z0-9-]+)(?:\s+(.*))?$/i);
          out = m ? { isCommand: true, name: m[1].toLowerCase(), rawInput: m[2] ?? '' } : { isCommand: false };
        } else {
          throw new RpcParamError(-32602, `Unknown tool: ${toolName}`);
        }
        write({
          jsonrpc: '2.0',
          id: req.id,
          result: { content: [{ type: 'text', text: JSON.stringify(out) }] },
        });
      } else {
        write({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: `Method not found: ${req.method}` } });
      }
    } catch (err) {
      const code = err instanceof RpcParamError ? err.code : -32603;
      write({
        jsonrpc: '2.0',
        id: req.id,
        error: { code, message: err instanceof Error ? err.message : String(err) },
      });
    }
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  void startMcpServer();
}
