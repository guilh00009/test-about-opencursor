import * as vscode from 'vscode';
export interface AgentAction {
    type: 'read' | 'write' | 'search' | 'command' | 'execute' | 'analyze' | 'browse' | 'edit' | 'stop';
    data: any;
    result?: any;
}
export declare class AgentUtils {
    private _outputChannel;
    private _workspaceRoot;
    constructor();
    log(message: string): void;
    showOutputChannel(): void;
    readFile(filePath: string): Promise<string>;
    writeFile(filePath: string, content: string): Promise<void>;
    runCommand(command: string): Promise<string>;
    searchFiles(pattern: string): Promise<vscode.Uri[]>;
    searchText(searchText: string): Promise<vscode.Location[]>;
    executeActions(actions: AgentAction[]): Promise<AgentAction[]>;
    executeCode(language: string, code: string): Promise<string>;
    browseWeb(query: string, numResults?: number): Promise<any>;
    private duckDuckGoSearch;
    private _decodeHtmlEntities;
    getTerminalOutput(maxLines?: number): Promise<string>;
    private _getFileExtension;
    private _resolveFilePath;
    editFile(filePath: string, edits: any): Promise<any>;
}
//# sourceMappingURL=agentUtils.d.ts.map