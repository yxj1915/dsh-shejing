import type { Tool } from "@modelcontextprotocol/sdk/types.js";
/**
 * `annotations` is what tells a client which tools merely read and which can
 * destroy work — the difference between an agent that can explore this
 * server's 56 tools safely and one that cannot. A contract may carry its own;
 * otherwise it is derived from the classification in tool-contracts.ts.
 */
export declare const TOOL_DEFINITIONS: Tool[];
/**
 * Server-side tool filtering, primarily for token-constrained MCP clients
 * (e.g., a DeepSeek harness with function calling): set LIGHTROOM_MCP_TOOLS
 * to a comma-separated list of tool names to expose only those, or "all"
 * (the default) for the full set. Unknown names are reported on stderr and
 * skipped rather than failing the server — a typo should not take the
 * bridge down, and the mistake stays visible in the client's logs.
 */
export declare const TOOL_FILTER_ENV_VAR = "LIGHTROOM_MCP_TOOLS";
export declare function selectToolDefinitions(filterRaw: string | undefined, onWarning?: (message: string) => void): Tool[];
export declare function listToolsHandler(toolFilterRaw?: string, onWarning?: (message: string) => void): {
    tools: Tool[];
};
//# sourceMappingURL=list-tools-handler.d.ts.map