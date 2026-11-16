import { randomUUID } from 'node:crypto';
import { renderApprovalBox, renderQuestionBox } from './renderer.js';
const HIGH_RISK_TOOLS = new Set(['bash', 'shell', 'exec', 'run_command']);
function isSessionGrantEligible(toolName, code) {
    if (code?.startsWith('CUGA_'))
        return false;
    return !HIGH_RISK_TOOLS.has(toolName.toLowerCase());
}
export class TerminalInteractionController {
    sessionAllowedTools = new Set();
    activeApproval = null;
    activeQuestion = null;
    writeFn;
    columnsFn;
    constructor(opts = {}) {
        this.writeFn = opts.write ?? ((t) => process.stdout.write(t));
        this.columnsFn = opts.columns ?? (() => process.stdout.columns ?? 100);
    }
    pending() {
        return {
            approval: this.activeApproval?.prompt ?? null,
            question: this.activeQuestion?.prompt ?? null,
        };
    }
    hasActivePrompt() {
        return Boolean(this.activeApproval || this.activeQuestion);
    }
    hasSessionGrant(toolName) {
        return this.sessionAllowedTools.has(toolName);
    }
    clearSessionGrants() {
        this.sessionAllowedTools.clear();
    }
    async promptApproval(req) {
        if (req.signal?.aborted)
            return 'cancelled';
        if (isSessionGrantEligible(req.toolName, req.code) && this.sessionAllowedTools.has(req.toolName)) {
            return 'allowed-once';
        }
        if (this.activeApproval) {
            this.activeApproval.cleanup();
            this.activeApproval.resolve('rejected');
            this.activeApproval = null;
        }
        const prompt = {
            id: randomUUID(),
            toolName: req.toolName,
            code: req.code,
            reason: req.reason,
            commandPreview: req.commandPreview,
            allowSessionGrant: isSessionGrantEligible(req.toolName, req.code),
        };
        return new Promise((resolve) => {
            let settled = false;
            const onAbort = () => {
                if (settled)
                    return;
                settled = true;
                cleanup();
                resolve('cancelled');
            };
            const cleanup = () => {
                if (this.activeApproval?.prompt.id === prompt.id) {
                    this.activeApproval = null;
                }
                req.signal?.removeEventListener('abort', onAbort);
            };
            if (req.signal)
                req.signal.addEventListener('abort', onAbort, { once: true });
            this.activeApproval = {
                prompt,
                cleanup,
                resolve: (outcome) => {
                    if (settled)
                        return;
                    settled = true;
                    cleanup();
                    resolve(outcome);
                },
            };
            this.writeFn(`\n${renderApprovalBox(prompt, this.columnsFn())}\n`);
        });
    }
    async promptQuestion(req) {
        if (!Array.isArray(req.questions) || req.questions.length === 0) {
            return { cancelled: false, answers: [] };
        }
        if (req.signal?.aborted)
            return { cancelled: true, answers: [] };
        if (this.activeQuestion) {
            this.activeQuestion.cleanup();
            this.activeQuestion.resolve({ cancelled: true, answers: [] });
            this.activeQuestion = null;
        }
        const prompt = {
            id: randomUUID(),
            questions: req.questions,
        };
        return new Promise((resolve) => {
            let settled = false;
            const onAbort = () => {
                if (settled)
                    return;
                settled = true;
                cleanup();
                resolve({ cancelled: true, answers: [] });
            };
            const cleanup = () => {
                if (this.activeQuestion?.prompt.id === prompt.id) {
                    this.activeQuestion = null;
                }
                req.signal?.removeEventListener('abort', onAbort);
            };
            if (req.signal)
                req.signal.addEventListener('abort', onAbort, { once: true });
            this.activeQuestion = {
                prompt,
                index: 0,
                answers: [],
                cleanup,
                resolve: (res) => {
                    if (settled)
                        return;
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
    handleCtrlC() {
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
    handleInputLine(line) {
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
                this.sessionAllowedTools.add(approval.prompt.toolName);
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
            if (!item)
                return false;
            if (trimmed.toLowerCase() === 'cancel' || trimmed === '\x1b') {
                active.resolve({ cancelled: true, answers: [] });
                return true;
            }
            const selected = [];
            let custom;
            if (Array.isArray(item.options) && item.options.length > 0) {
                const parts = item.multiSelect ? trimmed.split(',').map((s) => s.trim()).filter(Boolean) : [trimmed];
                for (const p of parts) {
                    const num = Number(p);
                    if (Number.isInteger(num) && num >= 1 && num <= item.options.length) {
                        selected.push(item.options[num - 1].label);
                    }
                    else if (item.options.some((o) => o.label === p)) {
                        selected.push(p);
                    }
                }
                if (selected.length === 0) {
                    if (trimmed === '')
                        selected.push(item.options[0].label);
                    else
                        custom = trimmed;
                }
            }
            else {
                custom = trimmed;
            }
            active.answers.push({ id: item.id, selected, ...(custom ? { custom } : {}) });
            active.index += 1;
            if (active.index >= active.prompt.questions.length) {
                active.resolve({ cancelled: false, answers: active.answers });
            }
            else {
                const nextItem = active.prompt.questions[active.index];
                this.writeFn(`\n${renderQuestionBox({ id: active.prompt.id, questions: [nextItem] }, this.columnsFn())}\n`);
            }
            return true;
        }
        return false;
    }
}
//# sourceMappingURL=interactions.js.map