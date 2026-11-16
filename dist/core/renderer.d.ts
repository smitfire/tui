import type { PendingApprovalPrompt, PendingQuestionPrompt, ToolBadgeEntry, TuiStatusSnapshot } from './types.js';
export declare function clampColumns(text: string, columns?: number): string;
export declare function renderHeader(status: TuiStatusSnapshot, columns?: number, noColor?: boolean): string;
export declare function renderToolBadge(badge: ToolBadgeEntry, expanded?: boolean, columns?: number, noColor?: boolean): string;
export declare function renderDiffBlock(diff: {
    path: string;
    oldText: string | null;
    newText: string;
}, opts?: {
    maxLines?: number;
    columns?: number;
    noColor?: boolean;
}): string;
export declare function renderApprovalBox(prompt: PendingApprovalPrompt, columns?: number, noColor?: boolean): string;
export declare function renderQuestionBox(prompt: PendingQuestionPrompt, columns?: number, noColor?: boolean): string;
export declare function renderFooter(status: TuiStatusSnapshot, columns?: number, noColor?: boolean): string;
export interface ParsedKeyToken {
    type: 'paste' | 'ctrl_c' | 'ctrl_o' | 'ctrl_l' | 'enter' | 'escape' | 'backspace' | 'text';
    text?: string;
}
/**
 * Stateful VT/PTY input parser handling bracketed paste (\x1b[200~...\x1b[201~),
 * multi-byte UTF-8 Unicode (e.g. "Zürich 日本語"), and control keys without splitting paste chunks.
 */
export declare class BracketedPasteParser {
    private buf;
    private inPaste;
    private pasteBuf;
    feed(chunk: Buffer | string): ParsedKeyToken[];
}
//# sourceMappingURL=renderer.d.ts.map