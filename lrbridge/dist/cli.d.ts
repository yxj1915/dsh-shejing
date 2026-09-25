export interface ParsedCli {
    command: "stdio" | "install-plugin" | "help" | "version";
}
export declare function parseCli(argv: string[]): ParsedCli;
export declare function helpText(): string;
//# sourceMappingURL=cli.d.ts.map