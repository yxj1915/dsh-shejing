export interface InstanceLock {
    release: () => void;
}
export interface LockWaitInfo {
    /** Pid of the process currently holding the lock. */
    pid: number;
    /** Milliseconds since we started waiting. */
    elapsedMs: number;
}
export interface AcquireOptions {
    /** Directory holding the lock file. Defaults to ~/.config/lightroom-mcp. */
    baseDir?: string;
    /**
     * How long to wait for a conflicting holder to exit before failing.
     * MCP clients routinely spawn a short-lived probe process before the real
     * one (Claude Desktop does this on every restart); waiting lets the real
     * instance take over instead of dying on a lock held by a process that is
     * on its way out. Defaults to 15000, override via LIGHTROOM_MCP_LOCK_WAIT_MS.
     */
    waitMs?: number;
    /** Poll interval while waiting. Defaults to 250. */
    pollMs?: number;
    /** Liveness check override (tests). Defaults to process.kill(pid, 0). */
    isAlive?: (pid: number) => boolean;
    /** Progress callback while waiting for the holder to exit. */
    onWait?: (info: LockWaitInfo) => void;
    /**
     * Holder side: consulted when a waiting contender asks this bridge to
     * yield. Return true to exit and hand over the lock. Defaults to never
     * yielding (tests and simple embeds); index.ts wires the real policy
     * (idle client / never-used bridge).
     */
    shouldYield?: () => boolean;
    /** Holder side: called right before yielding to a contender. */
    onYield?: (contenderPid: number) => void;
    /** Holder side: called when another process took the lock from us. */
    onStolen?: (newHolderPid: number | null) => void;
    /**
     * A lock file whose mtime is older than this is considered abandoned
     * (pre-3.1.2 builds never refresh it, and a hung holder cannot either)
     * and gets taken over even when the recorded pid still matches some
     * living process — Windows reuses pids aggressively. Defaults to 60000.
     */
    staleMs?: number;
    /** How long a contender waits before asking the holder to yield. Defaults to 5000. */
    yieldRequestDelayMs?: number;
    /** Holder-side poll interval for yield requests. Defaults to 1000. */
    yieldCheckMs?: number;
    /** Holder-side lock refresh interval. Defaults to 5000. */
    refreshMs?: number;
    /** Injectable clock (tests). Defaults to Date.now. */
    now?: () => number;
    /** Injectable exit (tests). Defaults to process.exit. */
    exit?: (code: number) => void;
}
/**
 * Acquires the single-bridge lock for a port pair.
 *
 * The lock exists because the Lightroom plugin serves one bridge at a time.
 * Contender side: a dead holder (or one that stopped refreshing its lock
 * file — every release before 3.1.2) is taken over; a live, fresh holder is
 * first asked to yield (`.yield-request` sidecar file) and then waited out
 * up to `waitMs`. Holder side: the lock file is refreshed every few seconds
 * so future contenders can tell this bridge is alive, and a yield request
 * from a waiting contender makes this bridge exit when `shouldYield`
 * approves — that is what lets Claude Desktop's respawn cycle replace an
 * abandoned-but-not-closed bridge instead of dying on its lock.
 */
export declare function acquireInstanceLock(requestPort: number, responsePort: number, options?: AcquireOptions): Promise<InstanceLock>;
//# sourceMappingURL=instance-lock.d.ts.map