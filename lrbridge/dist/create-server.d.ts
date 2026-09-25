import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Dispatcher } from "./dispatcher.js";
export interface ServerDeps {
    dispatcher: Pick<Dispatcher, "call">;
    isReady: () => boolean;
    notReadyMessage?: () => string;
    settleReadiness?: () => Promise<void>;
    /** Override for the LIGHTROOM_MCP_TOOLS env var (tests). */
    toolFilter?: string;
}
export declare function createMcpServer(deps: ServerDeps): Server;
//# sourceMappingURL=create-server.d.ts.map