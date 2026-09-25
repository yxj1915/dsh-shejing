/**
 * Polls `predicate` until it holds or the timeout elapses. Returns whether it
 * held. Used to wait out the socket connect that follows process start, so a
 * tool call made in that window is not answered with a false "not connected".
 */
export declare function waitUntil(predicate: () => boolean, timeoutMs: number, pollMs: number, now?: () => number, sleep?: (ms: number) => Promise<void>): Promise<boolean>;
//# sourceMappingURL=wait-until.d.ts.map