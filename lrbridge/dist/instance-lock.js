import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const DEFAULT_WAIT_MS = 15_000;
const DEFAULT_POLL_MS = 250;
const DEFAULT_STALE_MS = 60_000;
// tryCreate opens the file and writes the pid in two steps, so a contender
// polling in between sees an empty file. Anything younger than this is
// assumed to be that in-flight creation; older empties are corruption.
const EMPTY_GRACE_MS = 5_000;
const DEFAULT_YIELD_REQUEST_DELAY_MS = 5_000;
const DEFAULT_YIELD_CHECK_MS = 1_000;
const DEFAULT_REFRESH_MS = 5_000;
function pidIsAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (err) {
        return err.code === "EPERM";
    }
}
function readPid(pidFile) {
    try {
        const raw = fs.readFileSync(pidFile, "utf8").trim();
        const parsed = Number(raw);
        return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
    }
    catch {
        return null;
    }
}
function isEmptyFile(pidFile) {
    try {
        return fs.readFileSync(pidFile, "utf8").trim() === "";
    }
    catch {
        return false;
    }
}
function mtimeMs(file) {
    try {
        return fs.statSync(file).mtimeMs;
    }
    catch {
        return null;
    }
}
function envWaitMs() {
    const raw = process.env["LIGHTROOM_MCP_LOCK_WAIT_MS"];
    if (raw === undefined)
        return undefined;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}
function tryCreate(lockFile) {
    let fd = null;
    try {
        fd = fs.openSync(lockFile, "wx", 0o600);
        fs.writeFileSync(fd, `${process.pid}\n`, { encoding: "utf8" });
        return true;
    }
    catch (err) {
        if (err.code !== "EEXIST") {
            throw err;
        }
        return false;
    }
    finally {
        if (fd !== null)
            fs.closeSync(fd);
    }
}
function unlinkQuiet(file) {
    try {
        fs.unlinkSync(file);
    }
    catch (err) {
        if (err.code !== "ENOENT")
            throw err;
    }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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
export async function acquireInstanceLock(requestPort, responsePort, options = {}) {
    const baseDir = options.baseDir ?? path.join(os.homedir(), ".config", "lightroom-mcp");
    const waitMs = options.waitMs ?? envWaitMs() ?? DEFAULT_WAIT_MS;
    const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
    const yieldRequestDelayMs = options.yieldRequestDelayMs ?? DEFAULT_YIELD_REQUEST_DELAY_MS;
    const isAlive = options.isAlive ?? pidIsAlive;
    const now = options.now ?? Date.now;
    const exitFn = options.exit ?? ((code) => process.exit(code));
    fs.mkdirSync(baseDir, { recursive: true, mode: 0o700 });
    const lockFile = path.join(baseDir, `bridge-${requestPort}-${responsePort}.lock`);
    const yieldFile = path.join(baseDir, `bridge-${requestPort}-${responsePort}.yield-request`);
    const startedAt = now();
    while (true) {
        if (tryCreate(lockFile))
            break;
        const existingPid = readPid(lockFile);
        const age = now() - (mtimeMs(lockFile) ?? 0);
        const elapsedMs = now() - startedAt;
        if (elapsedMs >= waitMs) {
            throw new Error(existingPid !== null
                ? `Another Lightroom MCP bridge is still running for ports ${requestPort}/${responsePort} ` +
                    `(pid ${existingPid}) and did not exit within ${Math.round(waitMs / 1000)}s. ` +
                    (fs.existsSync(yieldFile)
                        ? `It was asked to yield but appears to be actively serving another client. `
                        : ``) +
                    `If no other client is using it, stop that process and retry. ` +
                    `PowerShell: Stop-Process -Id ${existingPid} -Force`
                : `Another Lightroom MCP bridge is still running for ports ${requestPort}/${responsePort}, ` +
                    `but its lock file is unreadable; if this persists, delete it and retry: ${lockFile}`);
        }
        if (existingPid === null) {
            // Empty or corrupt. An empty file that just appeared is the holder's
            // create/write window — give it a moment instead of stealing.
            if (isEmptyFile(lockFile) && age < EMPTY_GRACE_MS) {
                await sleep(Math.max(1, Math.min(pollMs, waitMs - elapsedMs)));
                continue;
            }
            unlinkQuiet(lockFile);
            continue;
        }
        if (age >= staleMs) {
            // Holder never refreshes the lock: every release before 3.1.2 (the
            // zombies that survive a 15s wait), a hung process, or a pid that
            // Windows already handed to an unrelated process. Take over.
            unlinkQuiet(lockFile);
            continue;
        }
        if (!isAlive(existingPid)) {
            // Stale lock: the holder crashed or was hard-killed (TerminateProcess
            // skips every Node hook, so this is the normal post-kill state).
            try {
                fs.unlinkSync(lockFile);
            }
            catch (unlinkErr) {
                if (unlinkErr.code !== "ENOENT")
                    throw unlinkErr;
            }
            continue;
        }
        if (elapsedMs >= yieldRequestDelayMs && !fs.existsSync(yieldFile)) {
            // Ask the holder to yield — abandoned-but-open bridges (Claude
            // Desktop's probe cycle) only ever leave through this door.
            try {
                fs.writeFileSync(yieldFile, `${process.pid}\n`, { encoding: "utf8", mode: 0o600 });
            }
            catch {
                // Best effort: the plain wait still works.
            }
        }
        options.onWait?.({ pid: existingPid, elapsedMs });
        await sleep(Math.max(1, Math.min(pollMs, waitMs - elapsedMs)));
    }
    // We own the lock: clear any yield request we (or a late contender that
    // already lost) left behind so a fresh contender has to ask again.
    unlinkQuiet(yieldFile);
    let released = false;
    let refreshTimer = null;
    let yieldTimer = null;
    const stopSupervision = () => {
        if (refreshTimer)
            clearInterval(refreshTimer);
        if (yieldTimer)
            clearInterval(yieldTimer);
        refreshTimer = null;
        yieldTimer = null;
    };
    const release = () => {
        if (released)
            return;
        released = true;
        stopSupervision();
        process.off("exit", exitHandler);
        process.off("SIGINT", signalHandler);
        process.off("SIGTERM", signalHandler);
        if (process.platform === "win32") {
            process.off("SIGBREAK", signalHandler);
        }
        if (readPid(lockFile) === process.pid) {
            fs.unlinkSync(lockFile);
        }
    };
    const exitHandler = () => release();
    const signalHandler = () => {
        release();
        exitFn(0);
    };
    process.once("exit", exitHandler);
    process.once("SIGINT", signalHandler);
    process.once("SIGTERM", signalHandler);
    if (process.platform === "win32") {
        process.once("SIGBREAK", signalHandler);
    }
    // Keep the lock file's mtime fresh so contenders can tell a live v3.1.2
    // holder from an abandoned one, and notice (then exit) when somebody
    // takes the lock away from us.
    refreshTimer = setInterval(() => {
        try {
            if (readPid(lockFile) !== process.pid) {
                stopSupervision();
                options.onStolen?.(readPid(lockFile));
                release();
                exitFn(0);
            }
            else {
                fs.utimesSync(lockFile, new Date(now()), new Date(now()));
            }
        }
        catch (err) {
            if (err.code === "ENOENT") {
                stopSupervision();
                options.onStolen?.(null);
                release();
                exitFn(0);
            }
        }
    }, options.refreshMs ?? DEFAULT_REFRESH_MS);
    refreshTimer.unref?.();
    // A contender that has been waiting asks us to yield. Only exit when the
    // policy approves — an actively used bridge outlives the contender's
    // patience and the contender reports the actionable timeout error.
    yieldTimer = setInterval(() => {
        if (!fs.existsSync(yieldFile))
            return;
        const contenderPid = readPid(yieldFile);
        if (contenderPid === null)
            return;
        if (!isAlive(contenderPid)) {
            unlinkQuiet(yieldFile);
            return;
        }
        if (options.shouldYield?.() ?? false) {
            stopSupervision();
            options.onYield?.(contenderPid);
            release();
            exitFn(0);
        }
    }, options.yieldCheckMs ?? DEFAULT_YIELD_CHECK_MS);
    yieldTimer.unref?.();
    return { release };
}
//# sourceMappingURL=instance-lock.js.map