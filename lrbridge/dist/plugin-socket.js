import net from "node:net";
export class PluginSocket {
    socket = null;
    connected = false;
    buffer = "";
    reconnectTimer = null;
    stopped = false;
    port;
    host;
    label;
    reconnectDelayMs;
    onLine;
    onConnect;
    onDisconnect;
    log;
    constructor(opts) {
        this.port = opts.port;
        this.label = opts.label;
        this.host = opts.host ?? "127.0.0.1";
        this.reconnectDelayMs = opts.reconnectDelayMs ?? 1000;
        this.onLine = opts.onLine;
        this.onConnect = opts.onConnect;
        this.onDisconnect = opts.onDisconnect;
        this.log = opts.log ?? ((msg) => console.error(msg));
    }
    connect() {
        if (this.stopped || this.socket)
            return;
        const sock = new net.Socket();
        sock.setEncoding("utf8");
        this.socket = sock;
        sock.on("connect", () => {
            this.connected = true;
            this.log(`[${this.label}] connected to ${this.host}:${this.port}`);
            this.onConnect?.();
        });
        sock.on("data", (chunk) => {
            if (!this.onLine)
                return;
            this.buffer += chunk;
            let idx;
            while ((idx = this.buffer.indexOf("\n")) !== -1) {
                const line = this.buffer.slice(0, idx).trim();
                this.buffer = this.buffer.slice(idx + 1);
                if (line)
                    this.onLine(line);
            }
        });
        sock.on("error", (err) => {
            if (err.code !== "ECONNREFUSED") {
                this.log(`[${this.label}] error: ${err.message}`);
            }
        });
        sock.on("close", () => {
            const wasConnected = this.connected;
            this.connected = false;
            this.socket = null;
            this.buffer = "";
            if (wasConnected)
                this.log(`[${this.label}] disconnected, reconnecting`);
            if (wasConnected)
                this.onDisconnect?.();
            this.scheduleReconnect();
        });
        sock.connect(this.port, this.host);
    }
    scheduleReconnect() {
        if (this.stopped || this.reconnectTimer)
            return;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, this.reconnectDelayMs);
    }
    send(line) {
        if (!this.socket || !this.connected)
            return false;
        this.socket.write(line + "\n");
        return true;
    }
    isConnected() {
        return this.connected;
    }
    stop() {
        this.stopped = true;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.socket) {
            this.socket.destroy();
            this.socket = null;
        }
        this.connected = false;
    }
}
//# sourceMappingURL=plugin-socket.js.map