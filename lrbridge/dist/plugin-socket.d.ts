export interface PluginSocketOptions {
    port: number;
    label: string;
    host?: string;
    reconnectDelayMs?: number;
    onLine?: (line: string) => void;
    onConnect?: () => void;
    onDisconnect?: () => void;
    log?: (msg: string) => void;
}
export declare class PluginSocket {
    private socket;
    private connected;
    private buffer;
    private reconnectTimer;
    private stopped;
    private readonly port;
    private readonly host;
    private readonly label;
    private readonly reconnectDelayMs;
    private readonly onLine?;
    private readonly onConnect?;
    private readonly onDisconnect?;
    private readonly log;
    constructor(opts: PluginSocketOptions);
    connect(): void;
    private scheduleReconnect;
    send(line: string): boolean;
    isConnected(): boolean;
    stop(): void;
}
//# sourceMappingURL=plugin-socket.d.ts.map