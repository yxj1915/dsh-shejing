export interface HeartbeatDispatcher {
    call(action: string, params: unknown, timeoutMs?: number): Promise<unknown>;
}
/**
 * Starts a fire-and-forget ping loop against the dispatcher and returns the
 * timer handle so the caller can clearInterval() it (e.g. on shutdown).
 * dispatcher.call() rejects on its own if the request socket is currently
 * disconnected, so this is safe to run unconditionally regardless of
 * connection state -- a failed ping is just logged via onError, never thrown.
 */
export declare function startHeartbeat(dispatcher: HeartbeatDispatcher, intervalMs: number, onError?: (err: Error) => void, onSuccess?: () => void): NodeJS.Timeout;
/**
 * One ping outside the interval loop, for probing a freshly opened connection.
 * Resolves true when the plugin answered.
 */
export declare function probePlugin(dispatcher: HeartbeatDispatcher, timeoutMs?: number): Promise<boolean>;
//# sourceMappingURL=heartbeat.d.ts.map