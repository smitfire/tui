export interface TuiStatusSnapshot {
  appName?: string;
  version?: string;
  cwd: string;
  branch?: string;
  sessionId: string;
  model: string;
  provider?: string;
  effort?: string;
  switchyardTier?: string;
  switchyardEscalations?: number;
  contextPercent?: number;
  forewispStrategy?: string;
  forewispOffers?: number;
  jevCostUsd?: number;
  cugaMode?: string;
  cugaBlocks?: number;
  activeCard?: string;
  tokensUsed?: number;
  planMode?: boolean;
  attached?: boolean;
  running?: boolean;
}

export interface ToolBadgeEntry {
  callId?: string;
  toolName: string;
  summary: string;
  detail?: string;
  ok: boolean;
  diff?: { path: string; oldText: string | null; newText: string };
  ptcSavedPercent?: number;
  ptcToolCalls?: number;
  durationMs?: number;
}

export interface PendingApprovalPrompt {
  id: string;
  toolName: string;
  code?: string;
  reason?: string;
  commandPreview?: string;
  allowSessionGrant?: boolean;
}

export interface PendingQuestionOption {
  label: string;
  description?: string;
}

export interface PendingQuestionItem {
  id: string;
  question: string;
  detail?: string;
  header?: string;
  options?: PendingQuestionOption[];
  multiSelect?: boolean;
}

export interface PendingQuestionPrompt {
  id: string;
  questions: PendingQuestionItem[];
}

export interface QuestionAnswerItem {
  id: string;
  selected: string[];
  custom?: string;
}

export interface NsTuiService {
  isAttached(): boolean;
  setAttached(attached: boolean, ttyPath?: string): void;
  activeSessionId(): string | undefined;
  detach(): void;
  resume(sessionId: string): Promise<{ sessionId: string }>;
  getStatus(): TuiStatusSnapshot;
  submitPrompt(text: string): Promise<void>;
  executeCommand(line: string): Promise<{ kind: string; text: string } | undefined>;
  pendingInteractions(): {
    approval: PendingApprovalPrompt | null;
    question: PendingQuestionPrompt | null;
  };
}
