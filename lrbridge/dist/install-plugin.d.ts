export interface InstallResult {
    status: "installed" | "already-present" | "skipped";
    destination: string;
    reason?: string;
}
export declare function lightroomModulesDir(): string;
export declare function lightroomPluginsDir(): string;
export declare function isPluginInstalledAnywhere(): boolean;
export declare function findBundledPlugin(startDir: string): string | null;
export declare function installPlugin(opts: {
    source: string;
    destDir?: string;
    force?: boolean;
}): InstallResult;
export declare function ensurePluginInstalled(startDir: string, log: (msg: string) => void): void;
//# sourceMappingURL=install-plugin.d.ts.map