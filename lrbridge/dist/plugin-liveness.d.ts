/**
 * Whether the plugin is actually answering, as opposed to merely accepting TCP
 * connections.
 *
 * The plugin serves one client per port. A second bridge still connects
 * successfully -- the kernel accepts, the plugin never reads -- so socket state
 * alone reports "ready" while every request sits unanswered until it times out
 * (issue 215). Pings settle that question, so readiness follows the pings:
 *
 *   unknown      no ping has settled yet. A tool call waits for the in-flight
 *                probe rather than racing it, so no call is ever dispatched
 *                into a connection nobody is reading.
 *   responsive   a ping came back.
 *   unresponsive a ping timed out. Tool calls fail immediately with an
 *                explanation instead of burning the full request timeout each.
 */
export type PluginLivenessState = "unknown" | "responsive" | "unresponsive";
export declare const SHADOW_BRIDGE_MESSAGE: string;
export declare class PluginLiveness {
    private state;
    private pending;
    private resolvePending;
    private generation;
    markResponsive(): void;
    markUnresponsive(): void;
    reset(): void;
    /**
     * Claims the right to probe. Returns a token to hand back to settleProbe, or
     * null when a probe is already running: without this the recovery interval
     * could stack probes whose verdicts then land in arbitrary order, letting a
     * slow timeout overwrite a fast success.
     */
    beginProbe(): number | null;
    /**
     * Records a probe verdict, ignoring one that belongs to a connection already
     * torn down (reset bumps the generation). Returns whether it was applied.
     */
    settleProbe(token: number, responsive: boolean): boolean;
    /**
     * Resolves once the current probe has settled. Returns immediately when the
     * state is already known or no probe is running.
     */
    settled(): Promise<void>;
    current(): PluginLivenessState;
    isUsable(): boolean;
    private release;
}
//# sourceMappingURL=plugin-liveness.d.ts.map