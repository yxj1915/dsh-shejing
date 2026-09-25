export interface ClientActivityOptions {
    /** Injectable clock (tests). Defaults to Date.now. */
    now?: () => number;
    /**
     * Idle time after which a bridge that HAS served tool calls agrees to
     * yield to a waiting contender. Defaults to 10 minutes, override via
     * LIGHTROOM_MCP_IDLE_YIELD_MS (0 disables yielding entirely).
     */
    idleYieldMs?: number;
    /**
     * Idle time after which a bridge that has NEVER served a tool call
     * agrees to yield — Claude's era probes answer their one handshake and
     * then go silent forever, so this is what unblocks the respawn cycle.
     * Defaults to 10 seconds, override via LIGHTROOM_MCP_PROBE_YIELD_MS.
     */
    probeYieldMs?: number;
}
export declare class ClientActivityTracker {
    private readonly now;
    private readonly idleYieldMs;
    private readonly probeYieldMs;
    private lastMessageAt;
    private sawToolCall;
    constructor(options?: ClientActivityOptions);
    /** Records every JSON-RPC message received from the client. */
    noteMessage(method: string | undefined): void;
    /** Milliseconds since the last client message. */
    idleMs(): number;
    /** True once any request beyond the probe set arrived (tools/call et al.). */
    hasServedRealWork(): boolean;
    /**
     * Whether this bridge should hand the lock to a waiting contender: it is
     * either a probe that nobody ever used, or a bridge whose client has been
     * silent long enough that it can only be an abandoned session.
     */
    shouldYieldToContender(): boolean;
}
//# sourceMappingURL=client-activity.d.ts.map