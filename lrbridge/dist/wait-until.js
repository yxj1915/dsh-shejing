/**
 * Polls `predicate` until it holds or the timeout elapses. Returns whether it
 * held. Used to wait out the socket connect that follows process start, so a
 * tool call made in that window is not answered with a false "not connected".
 */
export async function waitUntil(predicate, timeoutMs, pollMs, now = () => Date.now(), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
    const deadline = now() + timeoutMs;
    while (!predicate()) {
        if (now() >= deadline)
            return false;
        await sleep(pollMs);
    }
    return true;
}
//# sourceMappingURL=wait-until.js.map