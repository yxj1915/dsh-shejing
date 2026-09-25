import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, } from "@modelcontextprotocol/sdk/types.js";
import { createCallToolHandler } from "./tool-handler.js";
import { listToolsHandler, TOOL_FILTER_ENV_VAR } from "./list-tools-handler.js";
import { VERSION } from "./version.js";
export function createMcpServer(deps) {
    const server = new Server({ name: "lightroom-mcp-server", version: VERSION }, { capabilities: { tools: {} } });
    const toolFilter = deps.toolFilter ?? process.env[TOOL_FILTER_ENV_VAR];
    server.setRequestHandler(ListToolsRequestSchema, async () => listToolsHandler(toolFilter, (m) => console.error(m)));
    const callTool = createCallToolHandler(deps);
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;
        return callTool(name, args ?? {});
    });
    return server;
}
//# sourceMappingURL=create-server.js.map