"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AgentUtils = void 0;
const vscode = __importStar(require("vscode"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const util = __importStar(require("util"));
const cp = __importStar(require("child_process"));
const os = __importStar(require("os"));
const fetch_polyfill_1 = require("./fetch-polyfill");
// Promisified versions of functions
const readFile = util.promisify(fs.readFile);
const writeFile = util.promisify(fs.writeFile);
const mkdir = util.promisify(fs.mkdir);
const exec = util.promisify(cp.exec);
class AgentUtils {
    constructor() {
        this._outputChannel = vscode.window.createOutputChannel('AI Assistant Agent');
        this._workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    }
    // Log to output channel
    log(message) {
        this._outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
    }
    // Show the output channel
    showOutputChannel() {
        this._outputChannel.show();
    }
    // Read a file with optional path resolution
    async readFile(filePath) {
        try {
            // Check if we need to resolve from workspace root
            const resolvedPath = this._resolveFilePath(filePath);
            return await readFile(resolvedPath, 'utf8');
        }
        catch (error) {
            this.log(`Error reading file: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
        }
    }
    // Write to a file with optional path resolution and directory creation
    async writeFile(filePath, content) {
        try {
            const resolvedPath = this._resolveFilePath(filePath);
            const dirPath = path.dirname(resolvedPath);
            // Ensure directory exists
            if (!fs.existsSync(dirPath)) {
                await mkdir(dirPath, { recursive: true });
            }
            await writeFile(resolvedPath, content);
            this.log(`File written: ${resolvedPath}`);
        }
        catch (error) {
            this.log(`Error writing file: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
        }
    }
    // Run a command and get output
    async runCommand(command) {
        try {
            this.log(`Running command: ${command}`);
            const { stdout, stderr } = await exec(command, {
                cwd: this._workspaceRoot,
                maxBuffer: 1024 * 1024 * 5 // 5MB
            });
            if (stderr) {
                this.log(`Command stderr: ${stderr}`);
            }
            return stdout;
        }
        catch (error) {
            this.log(`Error running command: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
        }
    }
    // Search files in workspace
    async searchFiles(pattern) {
        try {
            this.log(`Searching files with pattern: ${pattern}`);
            return await vscode.workspace.findFiles(pattern);
        }
        catch (error) {
            this.log(`Error searching files: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
        }
    }
    // Search for text in files
    async searchText(searchText) {
        try {
            this.log(`Searching for text: ${searchText}`);
            // Use the built-in search API in VSCode
            const results = await vscode.commands.executeCommand('vscode.executeTextSearchCommand', {
                pattern: searchText
            });
            return results || [];
        }
        catch (error) {
            this.log(`Error searching text: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
        }
    }
    // Execute a series of agent actions
    async executeActions(actions) {
        const results = [];
        for (const action of actions) {
            try {
                let result;
                switch (action.type) {
                    case 'read':
                        result = await this.readFile(action.data.path);
                        break;
                    case 'write':
                        await this.writeFile(action.data.path, action.data.content);
                        result = { success: true };
                        break;
                    case 'search':
                        if (action.data.type === 'files') {
                            result = await this.searchFiles(action.data.pattern);
                        }
                        else if (action.data.type === 'text') {
                            result = await this.searchText(action.data.text);
                        }
                        break;
                    case 'command':
                        result = await this.runCommand(action.data.command);
                        break;
                    case 'execute':
                        result = await this.executeCode(action.data.language, action.data.code);
                        break;
                    case 'analyze':
                        // This is for code analysis, we'll pass it to the AI
                        result = action.data;
                        break;
                    case 'browse':
                        result = await this.browseWeb(action.data.query, action.data.numResults);
                        break;
                    case 'edit':
                        result = await this.editFile(action.data.path, action.data.edits);
                        break;
                    case 'stop':
                        // Just a signal to stop, no actual execution needed
                        result = { stopped: true };
                        break;
                }
                results.push({
                    ...action,
                    result
                });
            }
            catch (error) {
                results.push({
                    ...action,
                    result: { error: error instanceof Error ? error.message : String(error) }
                });
            }
        }
        return results;
    }
    // Execute code in different languages
    async executeCode(language, code) {
        try {
            this.log(`Executing ${language} code`);
            // Create a temporary file to execute
            const extension = this._getFileExtension(language);
            if (!extension) {
                throw new Error(`Unsupported language: ${language}`);
            }
            const tempDir = path.join(this._workspaceRoot || os.tmpdir(), '.ai-assistant-temp');
            if (!fs.existsSync(tempDir)) {
                await mkdir(tempDir, { recursive: true });
            }
            const tempFile = path.join(tempDir, `code_${Date.now()}${extension}`);
            await writeFile(tempFile, code);
            // Execute the code based on language
            let command = '';
            switch (language.toLowerCase()) {
                case 'js':
                case 'javascript':
                    command = `node "${tempFile}"`;
                    break;
                case 'ts':
                case 'typescript':
                    command = `npx ts-node "${tempFile}"`;
                    break;
                case 'py':
                case 'python':
                    command = `python "${tempFile}"`;
                    break;
                case 'bash':
                case 'sh':
                    // Make sure the file is executable on Unix systems
                    if (process.platform !== 'win32') {
                        await util.promisify(fs.chmod)(tempFile, '755');
                    }
                    command = process.platform === 'win32' ? `bash "${tempFile}"` : `"${tempFile}"`;
                    break;
                default:
                    throw new Error(`Execution of ${language} is not supported`);
            }
            // Execute and capture output
            const result = await this.runCommand(command);
            // Clean up the temp file
            try {
                fs.unlinkSync(tempFile);
            }
            catch (e) {
                // Ignore cleanup errors
            }
            return result;
        }
        catch (error) {
            this.log(`Error executing code: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
        }
    }
    // Browse the web
    async browseWeb(query, numResults = 5) {
        try {
            this.log(`Searching the web for: ${query}`);
            // Using DuckDuckGo which doesn't require an API key
            return await this.duckDuckGoSearch(query, numResults);
        }
        catch (error) {
            this.log(`Error browsing web: ${error instanceof Error ? error.message : String(error)}`);
            // Return an error object
            return {
                query,
                error: `Search failed: ${error instanceof Error ? error.message : String(error)}`,
                results: []
            };
        }
    }
    // DuckDuckGo search (no API key required)
    async duckDuckGoSearch(query, numResults = 5) {
        try {
            this.log(`Performing DuckDuckGo search for: ${query}`);
            // Using DuckDuckGo HTML search which doesn't require API keys
            const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
            const response = await (0, fetch_polyfill_1.fetch)(searchUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                }
            });
            if (!response.ok) {
                throw new Error(`Search request failed: ${response.statusText}`);
            }
            const html = await response.text();
            // Extract search results from HTML
            const results = [];
            const titleRegex = /<a class="result__a" href="(.*?)".*?>(.*?)<\/a>/g;
            const snippetRegex = /<a class="result__snippet".*?>(.*?)<\/a>/g;
            let match;
            let index = 0;
            // Extract titles and URLs
            const titles = [];
            while ((match = titleRegex.exec(html)) !== null && index < numResults) {
                titles.push({
                    url: match[1],
                    title: this._decodeHtmlEntities(match[2])
                });
                index++;
            }
            // Extract snippets
            const snippets = [];
            while ((match = snippetRegex.exec(html)) !== null && snippets.length < numResults) {
                snippets.push(this._decodeHtmlEntities(match[1]));
            }
            // Combine results
            for (let i = 0; i < Math.min(titles.length, snippets.length); i++) {
                results.push({
                    title: titles[i].title,
                    url: titles[i].url,
                    snippet: snippets[i]
                });
            }
            return {
                query,
                results: results.slice(0, numResults)
            };
        }
        catch (error) {
            this.log(`Error in DuckDuckGo search: ${error instanceof Error ? error.message : String(error)}`);
            // Return a basic error result
            return {
                query,
                error: `Search failed: ${error instanceof Error ? error.message : String(error)}`,
                results: []
            };
        }
    }
    // Utility function to decode HTML entities in search results
    _decodeHtmlEntities(html) {
        return html
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&amp;/g, '&')
            .replace(/<[^>]*>/g, ''); // Strip HTML tags
    }
    // Get recent terminal output
    async getTerminalOutput(maxLines = 20) {
        try {
            // Check if there are any terminals
            const terminals = vscode.window.terminals;
            if (terminals.length === 0) {
                return "No active terminals";
            }
            // Get the active terminal or the most recently created one
            const activeTerminal = vscode.window.activeTerminal || terminals[terminals.length - 1];
            // Create a new terminal that will execute a command to retrieve the history
            // We can't directly access terminal buffer, so we use a workaround
            let historyCommand = '';
            if (process.platform === 'win32') {
                // Windows
                historyCommand = 'doskey /history';
            }
            else {
                // Unix-like (Linux/macOS)
                historyCommand = 'cat ~/.bash_history | tail -n ' + maxLines;
            }
            // Execute command and capture output
            try {
                const output = await this.runCommand(historyCommand);
                return `Terminal "${activeTerminal.name}" recent history:\n${output}`;
            }
            catch (error) {
                // Fall back to just listing available terminals
                const terminalInfo = terminals.map(t => `- ${t.name}`).join('\n');
                return `Available terminals:\n${terminalInfo}\n(Unable to retrieve terminal history)`;
            }
        }
        catch (error) {
            this.log(`Error getting terminal output: ${error instanceof Error ? error.message : String(error)}`);
            return "Error retrieving terminal information";
        }
    }
    // Get file extension for a language
    _getFileExtension(language) {
        const langMap = {
            'js': '.js',
            'javascript': '.js',
            'ts': '.ts',
            'typescript': '.ts',
            'py': '.py',
            'python': '.py',
            'bash': '.sh',
            'sh': '.sh',
            'rb': '.rb',
            'ruby': '.rb',
            'ps1': '.ps1',
            'powershell': '.ps1'
        };
        return langMap[language.toLowerCase()] || null;
    }
    // Resolve a file path (relative to workspace root if needed)
    _resolveFilePath(filePath) {
        if (path.isAbsolute(filePath)) {
            return filePath;
        }
        else if (this._workspaceRoot) {
            return path.join(this._workspaceRoot, filePath);
        }
        throw new Error('Cannot resolve relative path: no workspace root available');
    }
    // Edit a file at specific positions
    async editFile(filePath, edits) {
        try {
            this.log(`Editing file: ${filePath}`);
            const resolvedPath = this._resolveFilePath(filePath);
            // Check if file exists
            if (!fs.existsSync(resolvedPath)) {
                throw new Error(`File does not exist: ${filePath}`);
            }
            // Read the file content
            const originalContent = await readFile(resolvedPath, 'utf8');
            let newContent = originalContent;
            const editResults = [];
            // Apply edits (operations can be of different types)
            if (Array.isArray(edits.operations)) {
                for (const operation of edits.operations) {
                    switch (operation.type) {
                        case 'replace':
                            // Replace content between specific lines or by pattern
                            if (operation.startLine && operation.endLine) {
                                // Line-based replacement
                                const lines = newContent.split('\n');
                                const startIdx = Math.max(0, operation.startLine - 1); // Convert to 0-based
                                const endIdx = Math.min(lines.length, operation.endLine); // Convert to 0-based
                                const beforeLines = lines.slice(0, startIdx);
                                const afterLines = lines.slice(endIdx);
                                // Replace the specified lines with new content
                                newContent = [...beforeLines, operation.newText, ...afterLines].join('\n');
                                editResults.push({
                                    operation: 'replace',
                                    startLine: operation.startLine,
                                    endLine: operation.endLine,
                                    success: true
                                });
                            }
                            else if (operation.pattern) {
                                // Pattern-based replacement
                                const regex = new RegExp(operation.pattern, operation.flags || 'g');
                                const oldContent = newContent;
                                newContent = newContent.replace(regex, operation.replacement || '');
                                editResults.push({
                                    operation: 'replace',
                                    pattern: operation.pattern,
                                    occurrences: (oldContent.match(regex) || []).length,
                                    success: true
                                });
                            }
                            break;
                        case 'insert':
                            // Insert at specific line
                            if (operation.line) {
                                const lines = newContent.split('\n');
                                const insertIdx = Math.min(lines.length, Math.max(0, operation.line - 1)); // Convert to 0-based
                                lines.splice(insertIdx, 0, operation.text);
                                newContent = lines.join('\n');
                                editResults.push({
                                    operation: 'insert',
                                    line: operation.line,
                                    success: true
                                });
                            }
                            else if (operation.position === 'start') {
                                // Insert at start of file
                                newContent = operation.text + newContent;
                                editResults.push({
                                    operation: 'insert',
                                    position: 'start',
                                    success: true
                                });
                            }
                            else if (operation.position === 'end') {
                                // Insert at end of file
                                newContent = newContent + operation.text;
                                editResults.push({
                                    operation: 'insert',
                                    position: 'end',
                                    success: true
                                });
                            }
                            break;
                        case 'delete':
                            // Delete specific lines
                            if (operation.startLine && operation.endLine) {
                                const lines = newContent.split('\n');
                                const startIdx = Math.max(0, operation.startLine - 1); // Convert to 0-based
                                const endIdx = Math.min(lines.length, operation.endLine); // Convert to 0-based
                                const beforeLines = lines.slice(0, startIdx);
                                const afterLines = lines.slice(endIdx);
                                newContent = [...beforeLines, ...afterLines].join('\n');
                                editResults.push({
                                    operation: 'delete',
                                    startLine: operation.startLine,
                                    endLine: operation.endLine,
                                    success: true
                                });
                            }
                            break;
                    }
                }
            }
            else if (typeof edits === 'string') {
                // Simple replacement of the entire file
                newContent = edits;
                editResults.push({
                    operation: 'replace-all',
                    success: true
                });
            }
            // Write the updated content back to the file
            await writeFile(resolvedPath, newContent);
            this.log(`File edited successfully: ${resolvedPath}`);
            return {
                success: true,
                path: filePath,
                operations: editResults,
                diff: {
                    before: originalContent.length,
                    after: newContent.length,
                    changeSize: newContent.length - originalContent.length
                }
            };
        }
        catch (error) {
            this.log(`Error editing file: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
        }
    }
}
exports.AgentUtils = AgentUtils;
//# sourceMappingURL=agentUtils.js.map