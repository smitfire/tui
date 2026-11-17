import { randomUUID } from 'node:crypto';
import type {
  PendingApprovalPrompt,
  PendingQuestionPrompt,
  QuestionAnswerItem,
} from './types.js';
import { renderApprovalBox, renderQuestionBox } from './renderer.js';

export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled';

interface ActiveApproval {
  prompt: PendingApprovalPrompt;
  resolve: (outcome: ApprovalOutcome) => void;
  cleanup: () => void;
}

interface ActiveQuestion {
  prompt: PendingQuestionPrompt;
  index: number;
  answers: QuestionAnswerItem[];
  resolve: (result: { cancelled: boolean; answers: QuestionAnswerItem[] }) => void;
  cleanup: () => void;
}

const HIGH_RISK_EXACT = new Set(['bash', 'shell', 'exec', 'run_command', 'terminal']);
const HIGH_RISK_PREFIXES = ['write', 'edit', 'patch', 'delete', 'rm', 'run_'];

function isSessionGrantEligible(toolName: string, code?: string): boolean {
  if (code?.startsWith('CUGA_')) return false;
  const norm = toolName.trim().toLowerCase();
  if (!norm || HIGH_RISK_EXACT.has(norm)) return false;
  return !HIGH_RISK_PREFIXES.some((p) => norm.startsWith(p));
}

export class TerminalInteractionController {
  private readonly sessionAllowedTools = new Set<string>();
  private activeApproval: ActiveApproval | null = null;
  private activeQuestion: ActiveQuestion | null = null;
  private writeFn: (text: string) => void;
  private columnsFn: () => number;

  constructor(opts: { write?: (text: string) => void; columns?: () => number } = {}) {
    this.writeFn = opts.write ?? ((t) => process.stdout.write(t));
    this.columnsFn = opts.columns ?? (() => process.stdout.columns ?? 100);
  }

  pending(): { approval: PendingApprovalPrompt | null; question: PendingQuestionPrompt | null } {
    return {
      approval: this.activeApproval?.prompt ?? null,
      question: this.activeQuestion?.prompt ?? null,
    };
  }

  hasActivePrompt(): boolean {
    return Boolean(this.activeApproval || this.activeQuestion);
  }

  private static grantKey(toolName: string): string {
    return toolName.trim().toLowerCase();
  }

  hasSessionGrant(toolName: string, code?: string): boolean {
    return isSessionGrantEligible(toolName, code) && this.sessionAllowedTools.has(TerminalInteractionController.grantKey(toolName));
  }

  clearSessionGrants(): void {
    this.sessionAllowedTools.clear();
  }

  async promptApproval(req: {
    toolName: string;
    reason?: string;
    code?: string;
    commandPreview?: string;
    signal?: AbortSignal;
  }): Promise<ApprovalOutcome> {
    if (req.signal?.aborted) return 'cancelled';
    if (this.hasSessionGrant(req.toolName, req.code)) {
      return 'allowed-once';
    }

    if (this.activeApproval) {
      this.activeApproval.cleanup();
      this.activeApproval.resolve('rejected');
      this.activeApproval = null;
    }

    const prompt: PendingApprovalPrompt = {
      id: randomUUID(),
      toolName: req.toolName,
      code: req.code,
      reason: req.reason,
      commandPreview: req.commandPreview,
      allowSessionGrant: isSessionGrantEligible(req.toolName, req.code),
    };

    return new Promise<ApprovalOutcome>((resolve) => {
      let settled = false;
      const cleanup = () => {
        if (this.activeApproval?.prompt.id === prompt.id) {
          this.activeApproval = null;
        }
        req.signal?.removeEventListener('abort', onAbort);
      };
      function onAbort() {
        if (settled) return;
        settled = true;
        cleanup();
        resolve('cancelled');
      }
      if (req.signal) req.signal.addEventListener('abort', onAbort, { once: true });
      this.activeApproval = {
        prompt,
        cleanup,
        resolve: (outcome) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(outcome);
        },
      };
      this.writeFn(`\n${renderApprovalBox(prompt, this.columnsFn())}\n`);
    });
  }

  async promptQuestion(req: {
    questions: PendingQuestionPrompt['questions'];
    signal?: AbortSignal;
  }): Promise<{ cancelled: boolean; answers: QuestionAnswerItem[] }> {
    if (!Array.isArray(req.questions) || req.questions.length === 0) {
      return { cancelled: true, answers: [] };
    }
    if (req.signal?.aborted) return { cancelled: true, answers: [] };
    if (this.activeQuestion) {
      this.activeQuestion.cleanup();
      this.activeQuestion.resolve({ cancelled: true, answers: [] });
      this.activeQuestion = null;
    }

    const prompt: PendingQuestionPrompt = {
      id: randomUUID(),
      questions: req.questions,
    };

    return new Promise((resolve) => {
      let settled = false;
      const cleanup = () => {
        if (this.activeQuestion?.prompt.id === prompt.id) {
          this.activeQuestion = null;
        }
        req.signal?.removeEventListener('abort', onAbort);
      };
      function onAbort() {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ cancelled: true, answers: [] });
      }
      if (req.signal) req.signal.addEventListener('abort', onAbort, { once: true });
      this.activeQuestion = {
        prompt,
        index: 0,
        answers: [],
        cleanup,
        resolve: (res) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(res);
        },
      };
      this.writeFn(`\n${renderQuestionBox({ id: prompt.id, questions: [prompt.questions[0]] }, this.columnsFn())}\n`);
    });
  }

  /**
   * Handles Ctrl+C while an inline interaction is open.
   * Returns true if an inline approval/question was dismissed (caller should NOT abort foreground turn).
   */
  handleCtrlC(): boolean {
    if (this.activeApproval) {
      const a = this.activeApproval;
      this.writeFn('\n[Denied via Ctrl+C]\n');
      a.resolve('rejected');
      return true;
    }
    if (this.activeQuestion) {
      const q = this.activeQuestion;
      this.writeFn('\n[Question cancelled via Ctrl+C]\n');
      q.resolve({ cancelled: true, answers: [] });
      return true;
    }
    return false;
  }

  /**
   * Feeds a submitted line of user input while an interaction is active.
   * Returns true if the input was consumed by an active prompt.
   */
  handleInputLine(line: string): boolean {
    const trimmed = line.trim();
    if (this.activeApproval) {
      const lower = trimmed.toLowerCase();
      const approval = this.activeApproval;
      if (lower === 'y' || lower === 'yes' || lower === 'allow') {
        this.writeFn(`[Allowed once: ${approval.prompt.toolName}]\n`);
        approval.resolve('allowed-once');
        return true;
      }
      if (lower === 'a' || lower === 'always') {
        if (!isSessionGrantEligible(approval.prompt.toolName, approval.prompt.code)) {
          this.writeFn(`[One-off approval only for high-risk tool: ${approval.prompt.toolName}; enter [y] once or [n] deny]\n`);
          return true;
        }
        this.sessionAllowedTools.add(TerminalInteractionController.grantKey(approval.prompt.toolName));
        this.writeFn(`[Allowed for session: ${approval.prompt.toolName}]\n`);
        approval.resolve('allowed-once');
        return true;
      }
      if (lower === 'n' || lower === 'no' || lower === 'deny') {
        this.writeFn(`[Denied: ${approval.prompt.toolName}]\n`);
        approval.resolve('rejected');
        return true;
      }
      this.writeFn('Please answer [y] once, [a] session, or [n] deny:\n');
      return true;
    }

    if (this.activeQuestion) {
      const active = this.activeQuestion;
      const item = active.prompt.questions[active.index];
      if (!item) return false;
      if (trimmed.toLowerCase() === 'cancel' || trimmed === '\x1b') {
        active.resolve({ cancelled: true, answers: [] });
        return true;
      }
      const selected: string[] = [];
      let custom: string | undefined;
      if (Array.isArray(item.options) && item.options.length > 0) {
        const parts = item.multiSelect ? trimmed.split(',').map((s) => s.trim()).filter(Boolean) : [trimmed];
        for (const p of parts) {
          const num = Number(p);
          if (Number.isInteger(num) && num >= 1 && num <= item.options.length) {
            selected.push(item.options[num - 1].label);
          } else if (item.options.some((o) => o.label === p)) {
            selected.push(p);
          }
        }
        if (selected.length === 0) {
          if (trimmed === '') selected.push(item.options[0].label);
          else custom = trimmed;
        }
      } else {
        custom = trimmed;
      }
      active.answers.push({ id: item.id, selected, ...(custom ? { custom } : {}) });
      active.index += 1;
      if (active.index >= active.prompt.questions.length) {
        active.resolve({ cancelled: false, answers: active.answers });
      } else {
        const nextItem = active.prompt.questions[active.index];
        this.writeFn(`\n${renderQuestionBox({ id: active.prompt.id, questions: [nextItem] }, this.columnsFn())}\n`);
      }
      return true;
    }

    return false;
  }
}
