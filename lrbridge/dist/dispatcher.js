export class Dispatcher {
    pending = new Map();
    idCounter = 0;
    timeoutMs;
    actionTimeoutsMs;
    send;
    getToken;
    log;
    constructor(opts) {
        this.send = opts.send;
        this.getToken = opts.getToken;
        this.timeoutMs = opts.timeoutMs ?? 30_000;
        this.actionTimeoutsMs = opts.actionTimeoutsMs ?? {};
        this.log = opts.log ?? ((msg) => console.error(msg));
    }
    handleResponseLine(line) {
        let resp;
        try {
            resp = JSON.parse(line);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.log(`Bad JSON from plugin (${msg}): ${line}`);
            return;
        }
        const p = this.pending.get(resp.id);
        if (!p) {
            this.log(`Response for unknown id: ${resp.id}`);
            return;
        }
        clearTimeout(p.timer);
        this.pending.delete(resp.id);
        p.resolve(resp);
    }
    async call(action, params, timeoutOverrideMs) {
        const id = `req_${Date.now()}_${this.idCounter++}`;
        // A non-positive override means "no override": `0` would otherwise arm a
        // 0 ms timer that rejects on the next tick.
        const override = timeoutOverrideMs ?? this.actionTimeoutsMs[action];
        const timeoutMs = override !== undefined && override > 0 ? override : this.timeoutMs;
        const responsePromise = new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                // A bare "timeout" reads as "the plugin is dead", which sends people
                // restarting Lightroom and killing processes. Usually it is the
                // opposite: the request WAS delivered and one slow action is blocking.
                // The two cases have different fixes, so name both and say how to tell
                // them apart.
                reject(new Error(`Plugin response timeout (${timeoutMs / 1000}s) for '${action}'. ` +
                    "The request was delivered; the plugin never answered. If other " +
                    "tools still work, Lightroom is alive and this one action is slow " +
                    "or blocked — a render, import, export or preview rebuild in " +
                    "progress — so retry when it finishes. If every tool times out, " +
                    "the plugin stopped serving: check LightroomMCP.log for whether " +
                    "the request was logged at all."));
            }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
        });
        const cleanup = () => {
            const p = this.pending.get(id);
            if (p)
                clearTimeout(p.timer);
            this.pending.delete(id);
        };
        let payload;
        try {
            payload = JSON.stringify({ hello: this.getToken(), id, action, params: params ?? {} });
        }
        catch (err) {
            cleanup();
            throw err;
        }
        if (!this.send(payload)) {
            cleanup();
            throw new Error("Failed to send request to plugin (socket dropped)");
        }
        return responsePromise;
    }
    pendingCount() {
        return this.pending.size;
    }
}
//# sourceMappingURL=dispatcher.js.map