import type { Dispatcher } from "./dispatcher.js";
export interface ToolHandlerDeps {
    dispatcher: Pick<Dispatcher, "call">;
    isReady: () => boolean;
    notReadyMessage?: () => string;
    settleReadiness?: () => Promise<void>;
}
export type ToolContentBlock = {
    type: "text";
    text: string;
} | {
    type: "image";
    data: string;
    mimeType: string;
};
export interface ToolResponse {
    content: ToolContentBlock[];
    isError?: boolean;
    [key: string]: unknown;
}
export declare const NOT_CONNECTED_MESSAGE = "Lightroom plugin not connected. Open Lightroom and click 'Start Server' in Plug-in Manager.";
export declare function createCallToolHandler(deps: ToolHandlerDeps): (name: string, args: unknown) => Promise<ToolResponse>;
//# sourceMappingURL=tool-handler.d.ts.map