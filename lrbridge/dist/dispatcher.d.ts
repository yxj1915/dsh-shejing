export interface PluginResponse {
    id: string;
    result?: unknown;
    error?: string;
}
export interface DispatcherOptions {
    send: (line: string) => boolean;
    getToken: () => string;
    timeoutMs?: number;
    /**
     * Per-action timeout overrides (ms), keyed by action name. Long-running
     * actions like batch export/import need far more than the default before a
     * healthy plugin can reply; with too short a timeout the call reports a
     * false failure, and the plugin's eventual (correct) response arrives after
     * the pending entry is gone, so it is dropped as an unknown id. Actions
     * absent here -- or mapped to a non-positive value -- use `timeoutMs`.
     */
    actionTimeoutsMs?: Record<string, number>;
    log?: (msg: string) => void;
}
export declare class Dispatcher {
    private pending;
    private idCounter;
    private readonly timeoutMs;
    private readonly actionTimeoutsMs;
    private readonly send;
    private readonly getToken;
    private readonly log;
    constructor(opts: DispatcherOptions);
    handleResponseLine(line: string): void;
    call(action: string, params: unknown, timeoutOverrideMs?: number): Promise<PluginResponse>;
    pendingCount(): number;
}
//# sourceMappingURL=dispatcher.d.ts.map