import type { PendingApprovalPrompt, PendingQuestionPrompt, QuestionAnswerItem } from './types.js';
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled';
export declare class TerminalInteractionController {
    private readonly sessionAllowedTools;
    private activeApproval;
    private activeQuestion;
    private writeFn;
    private columnsFn;
    constructor(opts?: {
        write?: (text: string) => void;
        columns?: () => number;
    });
    pending(): {
        approval: PendingApprovalPrompt | null;
        question: PendingQuestionPrompt | null;
    };
    hasActivePrompt(): boolean;
    hasSessionGrant(toolName: string, code?: string): boolean;
    clearSessionGrants(): void;
    promptApproval(req: {
        toolName: string;
        reason?: string;
        code?: string;
        commandPreview?: string;
        signal?: AbortSignal;
    }): Promise<ApprovalOutcome>;
    promptQuestion(req: {
        questions: PendingQuestionPrompt['questions'];
        signal?: AbortSignal;
    }): Promise<{
        cancelled: boolean;
        answers: QuestionAnswerItem[];
    }>;
    /**
     * Handles Ctrl+C while an inline interaction is open.
     * Returns true if an inline approval/question was dismissed (caller should NOT abort foreground turn).
     */
    handleCtrlC(): boolean;
    /**
     * Feeds a submitted line of user input while an interaction is active.
     * Returns true if the input was consumed by an active prompt.
     */
    handleInputLine(line: string): boolean;
}
//# sourceMappingURL=interactions.d.ts.map