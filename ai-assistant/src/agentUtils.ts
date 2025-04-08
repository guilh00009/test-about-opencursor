import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as util from 'util';
import * as cp from 'child_process';
import * as os from 'os';
import { fetch } from './fetch-polyfill';

// Promisified versions of functions
const readFile = util.promisify(fs.readFile);
const writeFile = util.promisify(fs.writeFile);
const mkdir = util.promisify(fs.mkdir);
const exec = util.promisify(cp.exec);

export interface AgentAction {
	type: 'read' | 'write' | 'search' | 'command' | 'execute' | 'analyze' | 'browse' | 'edit' | 'stop';
	data: any;
	result?: any;
}

export class AgentUtils {
	private _outputChannel: vscode.OutputChannel;
	private _workspaceRoot: string | undefined;

	constructor() {
		this._outputChannel = vscode.window.createOutputChannel('AI Assistant Agent');
		this._workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	}

	// Log to output channel
	public log(message: string): void {
		this._outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
	}

	// Show the output channel
	public showOutputChannel(): void {
		this._outputChannel.show();
	}

	// Read a file with optional path resolution
	public async readFile(filePath: string, maxTokens?: number): Promise<string> {
		try {
			// Check if we need to resolve from workspace root
			const resolvedPath = this._resolveFilePath(filePath);
			let content = await readFile(resolvedPath, 'utf8');

			// If maxTokens is specified, ensure the content is within limits
			if (maxTokens && maxTokens > 0) {
				// Estimate token count (roughly 4 chars per token)
				const estimatedTokens = Math.ceil(content.length / 4);

				if (estimatedTokens > maxTokens) {
					this.log(`File content exceeds token limit (est. ${estimatedTokens} tokens). Truncating to ~${maxTokens} tokens.`);

					// Calculate how much content to keep (roughly)
					const keepChars = maxTokens * 4;
					const halfKeep = Math.floor(keepChars / 2);

					// Keep beginning and ending portions for context, with a message in the middle
					const firstPart = content.substring(0, halfKeep);
					const lastPart = content.substring(content.length - halfKeep);

					content = `${firstPart}\n\n[...Content truncated to fit within ${maxTokens} token limit...]\n\n${lastPart}`;
				}
			}

			return content;
		} catch (error) {
			this.log(`Error reading file: ${error instanceof Error ? error.message : String(error)}`);
			throw error;
		}
	}

	// Write to a file with optional path resolution and directory creation
	public async writeFile(filePath: string, content: string): Promise<void> {
		try {
			const resolvedPath = this._resolveFilePath(filePath);
			const dirPath = path.dirname(resolvedPath);

			// Ensure directory exists
			if (!fs.existsSync(dirPath)) {
				await mkdir(dirPath, { recursive: true });
			}

			await writeFile(resolvedPath, content);
			this.log(`File written: ${resolvedPath}`);
		} catch (error) {
			this.log(`Error writing file: ${error instanceof Error ? error.message : String(error)}`);
			throw error;
		}
	}

	// Run a command and get output
	public async runCommand(command: string): Promise<string> {
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
		} catch (error) {
			this.log(`Error running command: ${error instanceof Error ? error.message : String(error)}`);
			throw error;
		}
	}

	// Search files in workspace
	public async searchFiles(pattern: string): Promise<vscode.Uri[]> {
		try {
			this.log(`Searching files with pattern: ${pattern}`);
			return await vscode.workspace.findFiles(pattern);
		} catch (error) {
			this.log(`Error searching files: ${error instanceof Error ? error.message : String(error)}`);
			throw error;
		}
	}

	// Search for text in files
	public async searchText(searchText: string): Promise<vscode.Location[]> {
		try {
			this.log(`Searching for text: ${searchText}`);
			// Use the built-in search API in VSCode
			const results = await vscode.commands.executeCommand<vscode.Location[]>(
				'vscode.executeTextSearchCommand',
				{
					pattern: searchText
				}
			);
			return results || [];
		} catch (error) {
			this.log(`Error searching text: ${error instanceof Error ? error.message : String(error)}`);
			throw error;
		}
	}

	// Execute a series of agent actions
	public async executeActions(actions: AgentAction[]): Promise<AgentAction[]> {
		const results: AgentAction[] = [];

		// Get the max tokens from configuration
		const config = vscode.workspace.getConfiguration('aiAssistant');
		const maxTokens = config.get<number>('maxTokens') || 120000;

		for (const action of actions) {
			try {
				let result: any;

				switch (action.type) {
					case 'read':
						result = await this.readFile(action.data.path, maxTokens);
						break;

					case 'write':
						await this.writeFile(action.data.path, action.data.content);
						result = { success: true };
						break;

					case 'search':
						if (action.data.type === 'files') {
							result = await this.searchFiles(action.data.pattern);
						} else if (action.data.type === 'text') {
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

			} catch (error) {
				results.push({
					...action,
					result: { error: error instanceof Error ? error.message : String(error) }
				});
			}
		}

		return results;
	}

	// Execute code in different languages
	public async executeCode(language: string, code: string): Promise<string> {
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
			} catch (e) {
				// Ignore cleanup errors
			}

			return result;
		} catch (error) {
			this.log(`Error executing code: ${error instanceof Error ? error.message : String(error)}`);
			throw error;
		}
	}

	// Browse the web
	public async browseWeb(query: string, numResults: number = 5): Promise<any> {
		try {
			this.log(`Searching the web for: ${query}`);
			// Using DuckDuckGo which doesn't require an API key
			return await this.duckDuckGoSearch(query, numResults);
		} catch (error) {
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
	private async duckDuckGoSearch(query: string, numResults: number = 5): Promise<any> {
		try {
			this.log(`Performing DuckDuckGo search for: ${query}`);

			// Using DuckDuckGo HTML search which doesn't require API keys
			const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

			const response = await fetch(searchUrl, {
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
			const titles: { url: string, title: string }[] = [];
			while ((match = titleRegex.exec(html)) !== null && index < numResults) {
				titles.push({
					url: match[1],
					title: this._decodeHtmlEntities(match[2])
				});
				index++;
			}

			// Extract snippets
			const snippets: string[] = [];
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
		} catch (error) {
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
	private _decodeHtmlEntities(html: string): string {
		return html
			.replace(/&lt;/g, '<')
			.replace(/&gt;/g, '>')
			.replace(/&quot;/g, '"')
			.replace(/&#39;/g, "'")
			.replace(/&amp;/g, '&')
			.replace(/<[^>]*>/g, ''); // Strip HTML tags
	}

	// Get recent terminal output
	public async getTerminalOutput(maxLines: number = 20): Promise<string> {
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
			} else {
				// Unix-like (Linux/macOS)
				historyCommand = 'cat ~/.bash_history | tail -n ' + maxLines;
			}

			// Execute command and capture output
			try {
				const output = await this.runCommand(historyCommand);
				return `Terminal "${activeTerminal.name}" recent history:\n${output}`;
			} catch (error) {
				// Fall back to just listing available terminals
				const terminalInfo = terminals.map(t => `- ${t.name}`).join('\n');
				return `Available terminals:\n${terminalInfo}\n(Unable to retrieve terminal history)`;
			}
		} catch (error) {
			this.log(`Error getting terminal output: ${error instanceof Error ? error.message : String(error)}`);
			return "Error retrieving terminal information";
		}
	}

	// Get file extension for a language
	private _getFileExtension(language: string): string | null {
		const langMap: Record<string, string> = {
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
	private _resolveFilePath(filePath: string): string {
		if (path.isAbsolute(filePath)) {
			return filePath;
		} else if (this._workspaceRoot) {
			return path.join(this._workspaceRoot, filePath);
		}
		// If no workspace root is available, use the current directory
		this.log('Warning: No workspace root available, using current directory');
		return path.join(process.cwd(), filePath);
	}

	// Edit a file at specific positions
	public async editFile(filePath: string, edits: any): Promise<any> {
		try {
			this.log(`Editing file: ${filePath}`);
			const resolvedPath = this._resolveFilePath(filePath);

			// Check if file exists, if not create it with empty content
			if (!fs.existsSync(resolvedPath)) {
				this.log(`File does not exist: ${filePath}, creating it`);
				await writeFile(resolvedPath, '');
			}

			const originalContent = await readFile(resolvedPath, 'utf8');
			let newContent = originalContent;
			const editResults: any[] = [];

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
							} else if (operation.pattern) {
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
							} else if (operation.position === 'start') {
								// Insert at start of file
								newContent = operation.text + newContent;
								editResults.push({
									operation: 'insert',
									position: 'start',
									success: true
								});
							} else if (operation.position === 'end') {
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
			} else if (typeof edits === 'string') {
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
		} catch (error) {
			this.log(`Error editing file: ${error instanceof Error ? error.message : String(error)}`);
			throw error;
		}
	}
}
