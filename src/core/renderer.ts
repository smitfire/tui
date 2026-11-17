import { basename } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type {
  PendingApprovalPrompt,
  PendingQuestionPrompt,
  ToolBadgeEntry,
  TuiStatusSnapshot,
} from './types.js';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';

function useColor(noColor = Boolean(process.env.NO_COLOR)): boolean {
  return !noColor;
}

function paint(text: string, ansi: string, noColor?: boolean): string {
  if (!useColor(noColor)) return text;
  return `${ansi}${text}${RESET}`;
}

const ANSI_CSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

function visibleLength(text: string): number {
  return text.replace(ANSI_CSI_RE, '').length;
}

export function clampColumns(text: string, columns = 100): string {
  const width = Math.max(40, Number.isFinite(columns) ? Math.trunc(columns) : 100);
  if (visibleLength(text) <= width) return text;
  const maxVisible = width - 1;
  let visible = 0;
  let i = 0;
  let out = '';
  let sawAnsi = false;
  while (i < text.length && visible < maxVisible) {
    if (text[i] === '\x1b' && text[i + 1] === '[') {
      const m = text.slice(i).match(/^\x1b\[[0-9;]*[A-Za-z]/);
      if (m) {
        out += m[0];
        i += m[0].length;
        sawAnsi = true;
        continue;
      }
    }
    const cp = text.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    out += ch;
    i += ch.length;
    visible += 1;
  }
  return `${out}…${sawAnsi ? RESET : ''}`;
}

export function renderHeader(status: TuiStatusSnapshot, columns = 100, noColor?: boolean): string {
  const width = Math.max(44, columns);
  const app = status.appName ?? 'ns-dsh';
  const ver = status.version ?? '0.1.0';
  const dir = basename(status.cwd || '.') || status.cwd;
  const branch = status.branch ? ` (${status.branch})` : '';
  const shortSid = (status.sessionId || 'new').slice(0, 8);
  const title = ` ${app} v${ver} · ${dir}${branch} · ${shortSid} `;
  const fill = Math.max(2, width - title.length - 4);
  const top = `╭─${title}${'─'.repeat(fill)}╮`;
  return paint(clampColumns(top, width), CYAN, noColor);
}

export function renderToolBadge(badge: ToolBadgeEntry, expanded = false, columns = 100, noColor?: boolean): string {
  const dot = paint('⏺', badge.ok ? GREEN : RED, noColor);
  const name = paint(badge.toolName, BOLD, noColor);
  const ptc =
    typeof badge.ptcSavedPercent === 'number'
      ? paint(` · PTC ${badge.ptcSavedPercent.toFixed(1)}% saved`, CYAN, noColor)
      : '';
  const hint = badge.diff && !expanded ? paint(' [Ctrl+O diff]', DIM, noColor) : '';
  const head = clampColumns(`${dot} ${name} ${badge.summary}${ptc}${hint}`, columns);
  if (!expanded) return head;

  const extra: string[] = [head];
  if (badge.detail) {
    for (const line of badge.detail.split(/\r?\n/).slice(0, 20)) {
      extra.push(paint(`  │ ${clampColumns(line, columns - 4)}`, DIM, noColor));
    }
  }
  if (badge.diff) {
    extra.push(renderDiffBlock(badge.diff, { maxLines: 30, columns, noColor }));
  }
  return extra.join('\n');
}

export function renderDiffBlock(
  diff: { path: string; oldText: string | null; newText: string },
  opts: { maxLines?: number; columns?: number; noColor?: boolean } = {},
): string {
  const maxLines = opts.maxLines ?? 24;
  const columns = opts.columns ?? 100;
  const oldLines = diff.oldText === null ? [] : diff.oldText.split(/\r?\n/);
  const newLines = diff.newText.split(/\r?\n/);
  const out: string[] = [paint(`  @@ ${diff.path} @@`, CYAN, opts.noColor)];

  const maxLen = Math.max(oldLines.length, newLines.length);
  let shown = 0;
  let remainingChanged = 0;
  for (let i = 0; i < maxLen; i += 1) {
    const a = oldLines[i];
    const b = newLines[i];
    if (a === b) continue;
    if (a !== undefined) {
      if (shown < maxLines) {
        out.push(paint(`  - ${clampColumns(a, columns - 6)}`, RED, opts.noColor));
        shown += 1;
      } else {
        remainingChanged += 1;
      }
    }
    if (b !== undefined) {
      if (shown < maxLines) {
        out.push(paint(`  + ${clampColumns(b, columns - 6)}`, GREEN, opts.noColor));
        shown += 1;
      } else {
        remainingChanged += 1;
      }
    }
  }
  if (remainingChanged > 0) {
    out.push(paint(`  … (${remainingChanged} more changed lines; use /diff to inspect full patch)`, DIM, opts.noColor));
  }
  return out.join('\n');
}

export function renderApprovalBox(prompt: PendingApprovalPrompt, columns = 100, noColor?: boolean): string {
  const width = Math.max(44, columns);
  const code = prompt.code ? ` [${prompt.code}]` : '';
  const line1 = paint(`? Approval Required${code}: ${clampColumns(prompt.toolName, width - 26)}`, YELLOW + BOLD, noColor);
  const line2 = prompt.reason ? `  ${clampColumns(prompt.reason, width - 4)}` : '';
  const line3 = prompt.commandPreview ? paint(`  $ ${clampColumns(prompt.commandPreview, width - 6)}`, CYAN, noColor) : '';
  const allowChoice = prompt.allowSessionGrant !== false ? '  [y] Allow once   [a] Allow tool for session   [n / Esc / Ctrl+C] Deny' : '  [y] Allow once   [n / Esc / Ctrl+C] Deny';
  const choices = paint(allowChoice, BOLD, noColor);
  return [line1, line2, line3, choices].filter(Boolean).join('\n');
}

export function renderQuestionBox(prompt: PendingQuestionPrompt, columns = 100, noColor?: boolean): string {
  const width = Math.max(44, columns);
  const out: string[] = [];
  for (const q of prompt.questions) {
    const hdr = q.header ? `[${q.header}] ` : '';
    out.push(paint(`? ${hdr}${clampColumns(q.question, width - 4)}`, BLUE + BOLD, noColor));
    if (q.detail) out.push(paint(`  ${clampColumns(q.detail, width - 4)}`, DIM, noColor));
    if (Array.isArray(q.options) && q.options.length > 0) {
      q.options.forEach((opt, idx) => {
        const desc = opt.description ? ` — ${opt.description}` : '';
        out.push(`  [${idx + 1}] ${clampColumns(`${opt.label}${desc}`, width - 8)}`);
      });
      const hint = q.multiSelect ? 'Select comma list (e.g. 1,2) or type answer:' : 'Press 1-9, Enter, or type custom answer:';
      out.push(paint(`  ${hint}`, DIM, noColor));
    } else {
      out.push(paint('  Type answer and press Enter (Esc/Ctrl+C cancels):', DIM, noColor));
    }
  }
  return out.join('\n');
}

export function renderFooter(status: TuiStatusSnapshot, columns = 100, noColor?: boolean): string {
  const width = Math.max(44, columns);
  const rule = paint('─'.repeat(Math.min(width, 120)), DIM, noColor);
  const effort = status.effort ? ` (${status.effort})` : '';
  const modeTag = status.planMode ? paint('[PLAN] ', YELLOW + BOLD, noColor) : '';
  const swEsc = status.switchyardEscalations ? `↑${status.switchyardEscalations}` : '';
  const sw = status.switchyardTier ? `Switchyard: ${status.switchyardTier}${swEsc}` : 'Switchyard: direct';
  const ctx = typeof status.contextPercent === 'number' ? `ctx ${status.contextPercent}%` : 'ctx 0%';
  const fw = `Forewisp: ${status.forewispStrategy ?? 'local'} (${status.forewispOffers ?? 0})`;
  const jev = typeof status.jevCostUsd === 'number' && status.jevCostUsd > 0 ? ` · JEV $${status.jevCostUsd.toFixed(4)}` : '';

  const line1 = clampColumns(`${modeTag}${status.model}${effort} · ${sw} · ${ctx} · ${fw}${jev}`, width);

  const cuga = `CUGA: ${status.cugaMode ?? 'enforce'}${status.cugaBlocks ? ` (${status.cugaBlocks} blocked)` : ''}`;
  const card = `Card: ${status.activeCard ?? 'none'}`;
  const tok = `${status.tokensUsed ?? 0} tok`;
  const runFlag = status.running ? paint(' [RUNNING]', CYAN, noColor) : '';
  const line2 = clampColumns(`${cuga} · ${card} · ${tok}${runFlag} · Ctrl+O expand · Ctrl+B d detach`, width);

  return `${rule}\n${paint(line1, DIM, noColor)}\n${paint(line2, DIM, noColor)}`;
}

export interface ParsedKeyToken {
  type: 'paste' | 'ctrl_c' | 'ctrl_o' | 'ctrl_l' | 'enter' | 'escape' | 'backspace' | 'text';
  text?: string;
}

/**
 * Stateful VT/PTY input parser handling bracketed paste (\x1b[200~...\x1b[201~),
 * multi-byte UTF-8 Unicode (e.g. "Zürich 日本語"), and control keys without splitting paste chunks.
 */
export class BracketedPasteParser {
  private readonly decoder = new StringDecoder('utf8');
  private buf = '';
  private inPaste = false;
  private pasteBuf = '';

  feed(chunk: Buffer | string): ParsedKeyToken[] {
    const str = typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    this.buf += str;
    const tokens: ParsedKeyToken[] = [];

    while (this.buf.length > 0) {
      if (this.inPaste) {
        const endIdx = this.buf.indexOf('\x1b[201~');
        if (endIdx < 0) {
          // Hold possible partial ESC sequence at tail
          const escIdx = this.buf.lastIndexOf('\x1b');
          if (escIdx >= 0 && this.buf.length - escIdx < 6) {
            this.pasteBuf += this.buf.slice(0, escIdx);
            this.buf = this.buf.slice(escIdx);
          } else {
            this.pasteBuf += this.buf;
            this.buf = '';
          }
          break;
        }
        this.pasteBuf += this.buf.slice(0, endIdx);
        this.buf = this.buf.slice(endIdx + 6);
        this.inPaste = false;
        tokens.push({ type: 'paste', text: this.pasteBuf });
        this.pasteBuf = '';
        continue;
      }

      if (this.buf.startsWith('\x1b[200~')) {
        this.buf = this.buf.slice(6);
        this.inPaste = true;
        this.pasteBuf = '';
        continue;
      }
      if (this.buf.startsWith('\x1b') && this.buf.length < 6 && '\x1b[200~'.startsWith(this.buf)) {
        break;
      }

      const ch = this.buf[0];
      if (ch === '\x03') {
        this.buf = this.buf.slice(1);
        tokens.push({ type: 'ctrl_c' });
        continue;
      }
      if (ch === '\x0f') {
        this.buf = this.buf.slice(1);
        tokens.push({ type: 'ctrl_o' });
        continue;
      }
      if (ch === '\x0c') {
        this.buf = this.buf.slice(1);
        tokens.push({ type: 'ctrl_l' });
        continue;
      }
      if (ch === '\r' || ch === '\n') {
        if (this.buf.startsWith('\r\n')) this.buf = this.buf.slice(2);
        else this.buf = this.buf.slice(1);
        tokens.push({ type: 'enter' });
        continue;
      }
      if (ch === '\x7f' || ch === '\b') {
        this.buf = this.buf.slice(1);
        tokens.push({ type: 'backspace' });
        continue;
      }
      if (ch === '\x1b') {
        // Consume CSI/SS3 sequences (e.g. arrows) safely, bare ESC cancels
        const csi = this.buf.match(/^\x1b\[[0-9;?]*[A-Za-z~]/);
        if (csi) {
          this.buf = this.buf.slice(csi[0].length);
          continue;
        }
        if (this.buf.length === 1) {
          this.buf = '';
          tokens.push({ type: 'escape' });
          continue;
        }
        this.buf = this.buf.slice(1);
        continue;
      }

      // Collect contiguous printable text until next control / escape byte
      let end = 0;
      while (end < this.buf.length) {
        const code = this.buf.charCodeAt(end);
        if (code < 0x20 || code === 0x7f) break;
        end += 1;
      }
      if (end > 0) {
        tokens.push({ type: 'text', text: this.buf.slice(0, end) });
        this.buf = this.buf.slice(end);
      } else {
        this.buf = this.buf.slice(1);
      }
    }

    return tokens;
  }
}
