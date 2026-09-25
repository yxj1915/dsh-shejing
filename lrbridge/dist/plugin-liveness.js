export const SHADOW_BRIDGE_MESSAGE = "Connected to the Lightroom plugin's ports, but it is not answering. " +
    "The plugin serves one client at a time, so another lightroom-mcp process " +
    "is most likely holding the connection. Quit any other MCP client or stale " +
    "bridge process (pgrep -fl lightroom-mcp), or restart the plugin from " +
    "Lightroom's Plug-in Manager.";
export class PluginLiveness {
    state = "unknown";
    pending = null;
    resolvePending = null;
    generation = 0;
    markResponsive() {
        this.state = "responsive";
        this.release();
    }
    markUnresponsive() {
        this.state = "unresponsive";
        this.release();
    }
    reset() {
        this.state = "unknown";
        this.generation += 1;
        this.release();
    }
    /**
     * Claims the right to probe. Returns a token to hand back to settleProbe, or
     * null when a probe is already running: without this the recovery interval
     * could stack probes whose verdicts then land in arbitrary order, letting a
     * slow timeout overwrite a fast success.
     */
    beginProbe() {
        if (this.pending)
            return null;
        this.pending = new Promise((resolve) => {
            this.resolvePending = resolve;
        });
        return this.generation;
    }
    /**
     * Records a probe verdict, ignoring one that belongs to a connection already
     * torn down (reset bumps the generation). Returns whether it was applied.
     */
    settleProbe(token, responsive) {
        if (token !== this.generation)
            return false;
        if (responsive) {
            this.markResponsive();
        }
        else {
            this.markUnresponsive();
        }
        return true;
    }
    /**
     * Resolves once the current probe has settled. Returns immediately when the
     * state is already known or no probe is running.
     */
    async settled() {
        if (this.state !== "unknown" || !this.pending)
            return;
        await this.pending;
    }
    current() {
        return this.state;
    }
    isUsable() {
        return this.state !== "unresponsive";
    }
    release() {
        const resolve = this.resolvePending;
        this.pending = null;
        this.resolvePending = null;
        resolve?.();
    }
}
//# sourceMappingURL=plugin-liveness.js.map