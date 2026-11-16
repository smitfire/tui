import { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { type NsTuiService } from '../core/index.js';
export declare const name = "ns-tui";
export declare const inject: readonly ["agents", "commands", "tools", "sessions", "systemPrompt"];
export interface PluginConfig {
    interactive?: boolean;
    resume?: string;
    appName?: string;
    version?: string;
    onDetach?: () => void;
}
export declare const Config: z<PluginConfig>;
declare module '@deepseek-ai/cordis' {
    interface Context {
        nsTui?: NsTuiService;
    }
}
export declare function apply(ctx: Context, rawConfig?: Partial<PluginConfig>): void;
//# sourceMappingURL=index.d.ts.map