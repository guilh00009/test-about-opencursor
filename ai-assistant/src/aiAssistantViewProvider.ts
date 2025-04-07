import * as vscode from 'vscode';
import { fetch } from './fetch-polyfill';
import { AgentUtils, AgentAction } from './agentUtils';

interface Message {
    role: 'user' | 'assistant' | 'system';
    content: string;
    timestamp: string;
}

// Default API key to use if none is provided in settings
const DEFAULT_API_KEY = 'fw_3ZM5QnSBpeAvHmRG6qB1FWCm';

// Translations for UI elements
interface Translations {
    welcomeMessage: string;
    workingMessage: string;
    taskCompletedMessage: string;
    errorMessage: string;
    inputPlaceholder: string;
    sendButton: string;
    clearButton: string;
    changeLanguageButton: string;
    loadingText: string;
}

const translations: Record<string, Translations> = {
    'en': {
        welcomeMessage: "Hello! I'm Samantha Coder, your AI assistant. Ask me anything or request help with your code. I can analyze and modify files in your workspace.",
        workingMessage: "🤖 I'm working on this task...",
        taskCompletedMessage: "✅ Task completed.",
        errorMessage: "Sorry, I encountered an error. Please check your API key and connection.",
        inputPlaceholder: "Ask something...",
        sendButton: "Send",
        clearButton: "Clear",
        changeLanguageButton: "PT-BR",
        loadingText: "Working on it..."
    },
    'pt-br': {
        welcomeMessage: "Olá! Eu sou Samantha Coder, sua assistente de IA. Pergunte qualquer coisa ou peça ajuda com seu código. Posso analisar e modificar arquivos no seu espaço de trabalho.",
        workingMessage: "🤖 Estou trabalhando nesta tarefa...",
        taskCompletedMessage: "✅ Tarefa concluída.",
        errorMessage: "Desculpe, encontrei um erro. Por favor, verifique sua chave de API e conexão.",
        inputPlaceholder: "Pergunte algo...",
        sendButton: "Enviar",
        clearButton: "Limpar",
        changeLanguageButton: "EN",
        loadingText: "Trabalhando nisso..."
    }
};

// Add Chat interface to store chat information
interface Chat {
    id: string;
    title: string;
    messages: Message[];
    createdAt: string;
    updatedAt: string;
}

// Add this interface near the top of the file, alongside the other interfaces
interface FileSnapshot {
    exists: boolean;
    content: string;
    version: number;
}

interface StateSnapshot {
    files: { [path: string]: FileSnapshot };
    timestamp: string;
    chatId: string | null;
    primaryFile?: string;
    trackedFiles: string[];
}

export class AIAssistantViewProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private _chats: Chat[] = [];
    private _currentChatId: string | null = null;
    private _agentUtils: AgentUtils;
    private _isProcessingAgentActions = false;
    private _lastEditedFile: string | null = null;
    private _lastEditTime: number = 0;
    private _language: string = 'en';
    private _conversationHistory: { [key: string]: any } = {}; // Store state snapshots
    private _trackedFiles: Set<string> = new Set();
    private _abortController: AbortController | null = null; // For canceling fetch requests
    private _isGeneratingResponse = false; // Flag to track if a response is being generated

    constructor(
        private readonly _extensionUri: vscode.Uri
    ) {
        this._agentUtils = new AgentUtils();

        // Load language setting
        const config = vscode.workspace.getConfiguration('aiAssistant');
        this._language = config.get('language') || 'en';

        // Track language setting changes
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('aiAssistant.language')) {
                const config = vscode.workspace.getConfiguration('aiAssistant');
                this._language = config.get('language') || 'en';
                this._updateWebviewContent();
            }
        });

        // Track file edits
        vscode.workspace.onDidChangeTextDocument(e => {
            this._lastEditedFile = e.document.uri.fsPath;
            this._lastEditTime = Date.now();
            this._trackedFiles.add(e.document.uri.fsPath);
        });

        // Track file system changes
        vscode.workspace.onDidCreateFiles(e => {
            e.files.forEach(uri => {
                this._trackedFiles.add(uri.fsPath);
            });
        });

        // Initialize with default chat
        this._ensureDefaultChat();
    }

    // Ensure there's at least one chat
    private _ensureDefaultChat(): void {
        if (this._chats.length === 0) {
            this._createNewChat();
        }
    }

    // Create a new chat
    private _createNewChat(title?: string): string {
        const id = Date.now().toString();
        const now = new Date().toISOString();

        const newChat: Chat = {
            id,
            title: title || `Chat ${this._chats.length + 1}`,
            messages: [],
            createdAt: now,
            updatedAt: now
        };

        this._chats.push(newChat);
        this._currentChatId = id;

        // Update the webview if it exists
        if (this._view) {
            this._postMessageToWebview({
                type: 'updateChats',
                chats: this._chats,
                currentChatId: this._currentChatId
            });
        }

        return id;
    }

    // Get the current chat
    private _getCurrentChat(): Chat | undefined {
        // Ensure we have at least one chat
        this._ensureDefaultChat();

        if (!this._currentChatId && this._chats.length > 0) {
            this._currentChatId = this._chats[0].id;
        }

        return this._chats.find(chat => chat.id === this._currentChatId);
    }

    // Filter out system messages for display
    private _getMessagesForDisplay(messages: Message[]): Message[] {
        return messages.filter(msg => msg.role !== 'system');
    }

    // Switch to a different chat
    private _switchChat(chatId: string): void {
        const chat = this._chats.find(c => c.id === chatId);
        if (chat) {
            this._currentChatId = chatId;

            // Update the webview with visible messages only
            this._postMessageToWebview({
                type: 'switchChat',
                chatId,
                messages: this._getMessagesForDisplay(chat.messages)
            });

            // Update chat list to reflect new active chat
            this._postMessageToWebview({
                type: 'updateChats',
                chats: this._chats,
                currentChatId: this._currentChatId
            });
        }
    }

    // Rename a chat
    private _renameChat(chatId: string, newTitle: string): void {
        const chat = this._chats.find(c => c.id === chatId);
        if (chat) {
            chat.title = newTitle;
            chat.updatedAt = new Date().toISOString();

            // Update the webview
            this._postMessageToWebview({
                type: 'updateChats',
                chats: this._chats,
                currentChatId: this._currentChatId
            });
        }
    }

    // Delete a chat
    private _deleteChat(chatId: string): void {
        const index = this._chats.findIndex(c => c.id === chatId);
        if (index !== -1) {
            // Store reference to the chat we're deleting
            const deletedChat = this._chats[index];

            // Remove the chat
            this._chats.splice(index, 1);

            // Remove all state snapshots associated with this chat's messages
            if (deletedChat && deletedChat.messages) {
                deletedChat.messages.forEach(msg => {
                    if (msg.timestamp && this._conversationHistory[msg.timestamp]) {
                        delete this._conversationHistory[msg.timestamp];
                    }
                });
            }

            // If we deleted the current chat, switch to another one or create a new one
            if (this._currentChatId === chatId) {
                if (this._chats.length > 0) {
                    this._currentChatId = this._chats[0].id;

                    // Get the new current chat
                    const newCurrentChat = this._getCurrentChat();

                    // Update the webview with the new chat's messages
                    if (newCurrentChat && this._view) {
                        this._postMessageToWebview({
                            type: 'switchChat',
                            chatId: this._currentChatId,
                            messages: this._getMessagesForDisplay(newCurrentChat.messages)
                        });
                    }
                } else {
                    // Create a new chat if no chats remain
                    this._createNewChat();

                    // Get the new chat
                    const newChat = this._getCurrentChat();

                    // Update the webview with the new chat
                    if (newChat && this._view) {
                        this._postMessageToWebview({
                            type: 'switchChat',
                            chatId: this._currentChatId,
                            messages: this._getMessagesForDisplay(newChat.messages)
                        });
                    }
                }
            }

            // Update the webview's chat list
            this._postMessageToWebview({
                type: 'updateChats',
                chats: this._chats,
                currentChatId: this._currentChatId
            });
        }
    }

    private _updateSystemMessage(chat: Chat) {
        // Remove existing system message
        chat.messages = chat.messages.filter(msg => msg.role !== 'system');

        // Get workspace info
        const workspaceFolders = vscode.workspace.workspaceFolders || [];
        const workspaceInfo = workspaceFolders.map(folder => folder.uri.fsPath).join(', ');

        // Add updated system message
        chat.messages.push({
            role: 'system',
            content: `You are a VS Code AI Assistant with agency capabilities. You can perform actions on the user's workspace.

            ENVIRONMENT CONTEXT:
            - OS: ${process.platform}
            - Workspace: ${workspaceInfo || 'No workspace open'}
            - Last edited file: ${this._lastEditedFile || 'None'}
            ${this._lastEditedFile ? `- Last edit: ${new Date(this._lastEditTime).toLocaleTimeString()}` : ''}

            When you need to perform actions, respond with JSON in the following format:
            \`\`\`json
            {
              "thoughts": "Your reasoning about what needs to be done",
              "actions": [
                {
                  "type": "read|write|search|command|analyze|execute|stop",
                  "data": { ... action specific data ... }
                }
              ]
            }
            \`\`\`

            Action types and their data:
            - read: { "path": "relative/or/absolute/path" }
            - write: { "path": "relative/or/absolute/path", "content": "file content" }
            - search: { "type": "files", "pattern": "glob pattern" } or { "type": "text", "text": "search text" }
            - command: { "command": "command string to execute in terminal" }
            - execute: { "language": "js|python|bash|...", "code": "code to execute" }
            - analyze: { "code": "code to analyze", "question": "what you want to analyze" }
            - browse: { "query": "search query", "numResults": 5 } (free web search using DuckDuckGo, optional numResults)
            - edit: {
                "path": "relative/or/absolute/path",
                "edits": {
                  "operations": [
                    { "type": "replace", "startLine": 10, "endLine": 15, "newText": "new code here" },
                    { "type": "replace", "pattern": "oldFunction\\(\\)", "replacement": "newFunction()", "flags": "g" },
                    { "type": "insert", "line": 20, "text": "new line of code here" },
                    { "type": "insert", "position": "start", "text": "// Header comment" },
                    { "type": "insert", "position": "end", "text": "// Footer comment" },
                    { "type": "delete", "startLine": 25, "endLine": 30 }
                  ]
                }
              } (edit specific parts of an existing file)
            - stop: {} (use this to indicate you're done with the task and no more actions are needed)

            CONTEXTUAL UNDERSTANDING:
            Before every response, I will automatically gather information about the user's current context, including:
            - Currently open files
            - Current editor selection
            - Recent edits
            - Terminal output (if available)

            By default, you will continue to take actions in a loop until you decide to stop with the 'stop' action type.
            Always wrap your JSON in markdown code blocks with the json language specifier.
            When executing code or commands that might be potentially harmful, explain what the code does before executing it.
            `,
            timestamp: new Date().toISOString()
        });
    }

    public async gatherUserContext(): Promise<string> {
        try {
            let context = "";

            // Get active editor and document info
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                const document = editor.document;
                const selection = editor.selection;
                const selectedText = document.getText(selection);

                context += `ACTIVE EDITOR:\n`;
                context += `- File: ${document.uri.fsPath}\n`;
                context += `- Language: ${document.languageId}\n`;

                if (!selection.isEmpty) {
                    context += `- Selection (Lines ${selection.start.line + 1}-${selection.end.line + 1}):\n`;
                    context += "```\n" + selectedText + "\n```\n";
                } else {
                    const lineCount = document.lineCount;
                    const visibleRange = editor.visibleRanges[0];
                    context += `- Visible Range: Lines ${visibleRange.start.line + 1}-${visibleRange.end.line + 1} of ${lineCount}\n`;

                    // Get a few lines around the cursor to provide context
                    const cursorPos = selection.active;
                    const startLine = Math.max(0, cursorPos.line - 3);
                    const endLine = Math.min(lineCount - 1, cursorPos.line + 3);
                    const contextLines = [];

                    for (let i = startLine; i <= endLine; i++) {
                        const line = document.lineAt(i);
                        contextLines.push(`${i === cursorPos.line ? '> ' : '  '}${line.text}`);
                    }

                    context += `- Code around cursor (Line ${cursorPos.line + 1}):\n`;
                    context += "```\n" + contextLines.join('\n') + "\n```\n";
                }
            } else {
                context += "No active editor\n";
            }

            // Get information about open editors
            const openEditors = vscode.window.visibleTextEditors.map(editor => {
                return {
                    path: editor.document.uri.fsPath,
                    viewColumn: editor.viewColumn
                };
            });

            if (openEditors.length > 0) {
                context += `\nOPEN EDITORS:\n`;
                openEditors.forEach(editor => {
                    context += `- ${editor.path}\n`;
                });
            }

            // Recent edits
            if (this._lastEditedFile) {
                context += `\nRECENT EDITS:\n`;
                context += `- Last modified: ${this._lastEditedFile} at ${new Date(this._lastEditTime).toLocaleTimeString()}\n`;
            }

            // Terminal output
            try {
                const terminalOutput = await this._agentUtils.getTerminalOutput();
                if (terminalOutput) {
                    context += `\nTERMINAL:\n${terminalOutput}\n`;
                }
            } catch (error) {
                console.error('Error getting terminal output:', error);
            }

            // Current extensions
            try {
                const extensions = vscode.extensions.all
                    .filter(ext => ext.isActive && !ext.packageJSON.isBuiltin)
                    .map(ext => `${ext.packageJSON.displayName || ext.packageJSON.name} (${ext.packageJSON.version})`);

                if (extensions.length > 0) {
                    context += `\nACTIVE EXTENSIONS (top 5):\n`;
                    extensions.slice(0, 5).forEach(ext => {
                        context += `- ${ext}\n`;
                    });
                }
            } catch (error) {
                console.error('Error getting extensions:', error);
            }

            return context;
        } catch (error) {
            console.error('Error gathering context:', error);
            return "Error gathering context";
        }
    }

    public ensureWebviewIsVisible() {
        try {
            if (!this._view) {
                // Try to show the view if not already visible
                vscode.commands.executeCommand('workbench.view.extension.ai-assistant-view');
                vscode.commands.executeCommand('aiAssistantView.focus');
            } else {
                // If view exists but might not be visible, try to show it
                this._view.show(true);
            }
        } catch (error) {
            console.error('Error ensuring webview is visible:', error);
        }
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        if (!this._extensionUri) {
            console.error('Extension URI is undefined in resolveWebviewView');
            return;
        }

        // Ensure default chat exists
        this._ensureDefaultChat();

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                this._extensionUri
            ]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        // Send initial chats data
        webviewView.webview.postMessage({
            type: 'updateChats',
            chats: this._chats,
            currentChatId: this._currentChatId
        });

        // If there's already a current chat, send its messages
        const currentChat = this._getCurrentChat();
        if (currentChat) {
            webviewView.webview.postMessage({
                type: 'restoreConversation',
                messages: this._getMessagesForDisplay(currentChat.messages)
            });
        }

        // Handle messages from the webview
        webviewView.webview.onDidReceiveMessage(async (message: any) => {
            switch (message.type) {
                case 'sendQuery':
                    await this.sendQueryToAI(message.value);
                    break;
                case 'clearConversation':
                    this.clearConversation();
                    break;
                case 'toggleLanguage':
                    this.toggleLanguage();
                    break;
                case 'restoreState':
                    await this.restoreToState(message.messageId);
                    break;
                case 'createNewChat':
                    this._createNewChat(message.title);
                    break;
                case 'switchChat':
                    this._switchChat(message.chatId);
                    break;
                case 'renameChat':
                    this._renameChat(message.chatId, message.newTitle);
                    break;
                case 'deleteChat':
                    this._deleteChat(message.chatId);
                    break;
            }
        });
    }

    public async sendQueryToAI(query: string) {
        if (!this._view) {
            this.ensureWebviewIsVisible();
            return;
        }

        // Don't start a new query if we're already generating a response
        if (this._isGeneratingResponse) {
            vscode.window.showInformationMessage('Already processing a request. Please wait or clear the conversation.');
            return;
        }

        // Get the current chat or create a new one if none exists
        let currentChat = this._getCurrentChat();
        if (!currentChat) {
            this._createNewChat();
            currentChat = this._getCurrentChat();
        }

        if (!currentChat) {
            console.error('Failed to get or create a chat');
            return;
        }

        // Add user message to conversation
        const userMessage: Message = {
            role: 'user',
            content: query,
            timestamp: new Date().toISOString()
        };
        currentChat.messages.push(userMessage);
        currentChat.updatedAt = new Date().toISOString();

        // Take a snapshot of the current state before processing
        await this._takeStateSnapshot(userMessage.timestamp);

        // Update the webview with the new message
        await this._postMessageToWebview({
            type: 'addMessage',
            message: userMessage
        });

        try {
            // Gather current context before sending query
            const userContext = await this.gatherUserContext();

            // Update the system message with fresh context
            this._updateSystemMessage(currentChat);

            // Update the system message to include a timestamp
            currentChat.messages.push({
                role: 'system',
                content: `Current user context:\n${userContext}`,
                timestamp: new Date().toISOString()
            });

            // Show loading indicator
            await this._postMessageToWebview({ type: 'setLoading', isLoading: true });

            // Get AI response
            await this._getAIResponse(currentChat);
        } catch (error) {
            console.error('Error in sendQueryToAI:', error);
            vscode.window.showErrorMessage(`Error: ${error instanceof Error ? error.message : String(error)}`);

            await this._postMessageToWebview({
                type: 'addMessage',
                message: {
                    role: 'assistant',
                    content: translations[this._language].errorMessage,
                    timestamp: new Date().toISOString()
                }
            });
        } finally {
            // Hide loading indicator
            await this._postMessageToWebview({ type: 'setLoading', isLoading: false });
        }
    }

    // Helper method to safely post messages to the webview
    private async _postMessageToWebview(message: any): Promise<void> {
        if (this._view?.webview) {
            try {
                await this._view.webview.postMessage(message);
            } catch (error) {
                console.error('Error posting message to webview:', error);
            }
        }
    }

    private async _getAIResponse(chat: Chat) {
        try {
            if (!this._view) {
                return;
            }

            // Set the generating flag
            this._isGeneratingResponse = true;

            // Create a new AbortController for this request
            this._abortController = new AbortController();

            // Get API key from settings or use default
            const config = vscode.workspace.getConfiguration('aiAssistant');
            let apiKey = config.get<string>('apiKey');

            // If no API key in settings, use the default one
            if (!apiKey || apiKey.trim() === '') {
                apiKey = DEFAULT_API_KEY;
            }

            const model = config.get<string>('model');

            // Strip out timestamp field from messages before sending to API
            const apiMessages = chat.messages.map(msg => ({
                role: msg.role,
                content: msg.content
            }));

            // Create request options
            const options: any = {
                method: "POST",
                headers: {
                    "Accept": "application/json",
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${apiKey}`
                },
                body: JSON.stringify({
                    model: model || "accounts/fireworks/models/deepseek-v3-0324",
                    max_tokens: 20480,
                    top_p: 1,
                    top_k: 40,
                    presence_penalty: 0,
                    frequency_penalty: 0,
                    temperature: 0.6,
                    messages: apiMessages
                })
            };

            // Add abort signal if available
            if (this._abortController) {
                options.signal = this._abortController.signal;
            }

            const response = await fetch("https://api.fireworks.ai/inference/v1/chat/completions", options);

            // Check if the request was aborted
            if (this._abortController && this._abortController.signal.aborted) {
                this._isGeneratingResponse = false;
                return;
            }

            if (!response.ok) {
                const errorData = await response.json().catch(() => null);
                let errorMessage = `API request failed: ${response.statusText}`;
                if (errorData?.error?.message) {
                    errorMessage = `API Error: ${errorData.error.message}`;
                } else if (response.status === 401) {
                    errorMessage = 'Invalid API key. Please check your API key in settings.';
                } else if (response.status === 429) {
                    errorMessage = 'Rate limit exceeded. Please try again later.';
                } else if (response.status >= 500) {
                    errorMessage = 'Server error. Please try again later.';
                }
                throw new Error(errorMessage);
            }

            const data = await response.json();
            if (!data?.choices?.[0]?.message?.content) {
                throw new Error('Invalid response format from API');
            }

            const assistantMessage = data.choices[0].message.content;

            // Update the agent working message to include a timestamp
            const timestamp = new Date().toISOString();
            await this._postMessageToWebview({
                type: 'addMessage',
                message: {
                    role: 'assistant',
                    content: 'Thinking...',
                    timestamp
                }
            });

            // Update the agent response message to include a timestamp
            chat.messages.push({
                role: 'assistant',
                content: assistantMessage,
                timestamp
            });

            // Update UI with agent response
            await this._postMessageToWebview({
                type: 'addMessage',
                message: {
                    role: 'assistant',
                    content: assistantMessage,
                    timestamp
                }
            });

            // Check if the message contains agent actions
            await this._processAgentActions(assistantMessage, chat);
        } catch (error) {
            console.error('Error calling Fireworks API:', error);

            // Show a more specific error message in the chat
            const errorMessage = error instanceof Error ? error.message : String(error);
            await this._postMessageToWebview({
                type: 'addMessage',
                message: {
                    role: 'assistant',
                    content: `❌ ${errorMessage}`,
                    timestamp: new Date().toISOString()
                }
            });

            throw error; // Rethrow to be handled by caller
        } finally {
            this._isGeneratingResponse = false;
            if (this._view) {
                this._view.webview.postMessage({ type: 'setLoading', isLoading: false });
            }
        }
    }

    private _updateWebviewContent() {
        if (this._view) {
            this._view.webview.html = this._getHtmlForWebview(this._view.webview);
            // Update welcome message
            this._postMessageToWebview({
                type: 'updateLanguage',
                translations: translations[this._language]
            });
        }
    }

    public async _processAgentActions(message: string, chat: Chat) {
        // If already processing actions, don't start another process
        if (this._isProcessingAgentActions) {
            return;
        }

        try {
            this._isProcessingAgentActions = true;

            // First try to extract JSON from markdown code blocks
            const jsonMatch = message.match(/```json\s*([\s\S]*?)\s*```/);

            if (jsonMatch) {
                // Process JSON from code block
                const jsonContent = jsonMatch[1].trim();
                this._agentUtils.log(`Extracted JSON from markdown: ${jsonContent ? jsonContent.substring(0, 100) + '...' : 'empty content'}`);

                try {
                    const actionData = JSON.parse(jsonContent);
                    this._agentUtils.log(`Successfully parsed JSON from code block`);

                    // Check if processing was cancelled
                    if (!this._isProcessingAgentActions) {
                        return;
                    }

                    await this._processJsonActions(actionData, chat);
                } catch (parseError) {
                    console.error('Error parsing JSON from code block:', parseError);
                    this._agentUtils.log(`Error parsing JSON from code block: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
                }
            } else {
                // Try extracting without code block markers
                try {
                    const jsonData = JSON.parse(message);
                    if (jsonData && jsonData.actions && Array.isArray(jsonData.actions)) {
                        this._agentUtils.log(`Found JSON without code block markers`);

                        // Check if processing was cancelled
                        if (!this._isProcessingAgentActions) {
                            return;
                        }

                        await this._processJsonActions(jsonData, chat);
                    } else {
                        this._agentUtils.log(`Parsed JSON but no valid actions array found`);
                    }
                } catch (e) {
                    // Not valid JSON
                    this._agentUtils.log(`No JSON code blocks found and content is not valid JSON`);
                }
            }
        } catch (error) {
            console.error('Error processing agent actions:', error);
            this._agentUtils.log(`Error processing agent actions: ${error instanceof Error ? error.message : String(error)}`);

            if (this._view) {
                this._view.webview.postMessage({
                    type: 'addMessage',
                    message: {
                        role: 'assistant',
                        content: `❌ ${error instanceof Error ? error.message : String(error)}`,
                        timestamp: new Date().toISOString()
                    }
                });
            }
        } finally {
            this._isProcessingAgentActions = false;
            if (this._view) {
                this._view.webview.postMessage({ type: 'setLoading', isLoading: false });
            }
        }
    }

    private async _processJsonActions(actionData: any, chat: Chat) {
        if (!actionData.actions || !Array.isArray(actionData.actions)) {
            this._agentUtils.log(`No valid actions array found in JSON`);
            return; // No valid actions array
        }

        // Check if there's a "stop" action which should halt the agent after executing all actions
        const hasStopAction = actionData.actions.some((action: AgentAction) => action.type === 'stop');

        // Show that the agent is working
        this._agentUtils.showOutputChannel();
        this._agentUtils.log(`Processing ${actionData.actions.length} agent actions...`);
        this._agentUtils.log(`Thoughts: ${actionData.thoughts || 'No thoughts provided'}`);

        // Log each action for debugging
        actionData.actions.forEach((action: AgentAction, index: number) => {
            const actionDataStr = action.data ?
                (typeof action.data === 'string' ?
                    action.data.substring(0, 150) :
                    JSON.stringify(action.data || {}).substring(0, 150)) :
                'undefined';
            this._agentUtils.log(`Action ${index + 1}: type=${action.type}, data=${actionDataStr}${actionDataStr && actionDataStr.length > 149 ? '...' : ''}`);
        });

        if (this._view) {
            this._view.webview.postMessage({
                type: 'addMessage',
                message: {
                    role: 'assistant',
                    content: translations[this._language].workingMessage,
                    timestamp: new Date().toISOString()
                }
            });
            this._view.webview.postMessage({ type: 'setLoading', isLoading: true });
        }

        // Execute actions
        try {
            // Check if processing was cancelled before executing actions
            if (!this._isProcessingAgentActions) {
                return;
            }

            const actionResults = await this._agentUtils.executeActions(actionData.actions);

            // Check again if processing was cancelled after executing actions
            if (!this._isProcessingAgentActions) {
                return;
            }

            this._agentUtils.log(`Actions executed successfully`);

            // Log results for debugging
            actionResults.forEach((result: AgentAction, index: number) => {
                let resultStr = 'undefined';
                if (result.result) {
                    if (typeof result.result === 'string') {
                        resultStr = result.result.substring(0, 100);
                    } else {
                        try {
                            resultStr = JSON.stringify(result.result).substring(0, 100);
                        } catch (e) {
                            resultStr = '[Object cannot be stringified]';
                        }
                    }
                }
                this._agentUtils.log(`Result ${index + 1}: ${resultStr}${resultStr.length >= 100 ? '...' : ''}`);
            });

            // If this batch included a stop action, stop after all actions complete
            if (hasStopAction) {
                this._agentUtils.log(`Stop action detected, halting after execution`);
                if (this._view) {
                    this._view.webview.postMessage({
                        type: 'addMessage',
                        message: {
                            role: 'assistant',
                            content: translations[this._language].taskCompletedMessage,
                            timestamp: new Date().toISOString()
                        }
                    });
                }
                return;
            }

            // Check if processing was cancelled before continuing
            if (!this._isProcessingAgentActions) {
                return;
            }

            // Format results to send back to AI
            const resultsForAI = JSON.stringify(actionResults, null, 2);

            // Update context after actions completed
            const updatedContext = await this.gatherUserContext();

            // First add context as a system message
            chat.messages.push({
                role: 'system',
                content: `Updated context after actions:\n${updatedContext}`,
                timestamp: new Date().toISOString()
            });

            // Add action results as a system message to the conversation (not shown in UI)
            chat.messages.push({
                role: 'system',
                content: `The assistant has completed the actions. Here are the results:\n\`\`\`json\n${resultsForAI}\n\`\`\`\n
                Based on these results, determine what to do next. You can:
                1. Continue with more actions by returning a new JSON with "actions" array
                2. Stop the iteration by including an action with "type": "stop" if the task is completed
                3. Provide a final response to the user with your findings

                Please analyze these results and respond appropriately.`,
                timestamp: new Date().toISOString()
            });

            // Check if processing was cancelled before calling API again
            if (!this._isProcessingAgentActions) {
                return;
            }

            // Call API again with updated conversation
            await this._getAIResponse(chat);
        } catch (error) {
            console.error('Error executing actions:', error);
            this._agentUtils.log(`Error executing actions: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
        }
    }

    public clearConversation() {
        // Abort any ongoing API request
        if (this._abortController && this._isGeneratingResponse) {
            this._abortController.abort();
            this._abortController = null;
            this._isGeneratingResponse = false;
        }

        // Stop any agent actions processing
        this._isProcessingAgentActions = false;

        // Get the current chat
        const currentChat = this._getCurrentChat();
        if (!currentChat) {
            return;
        }

        // Keep system message but clear the rest
        currentChat.messages = currentChat.messages.filter(msg => msg.role === 'system');

        // Update the webview
        this._postMessageToWebview({ type: 'clearConversation' });

        // Hide loading indicator if it's showing
        this._postMessageToWebview({ type: 'setLoading', isLoading: false });
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        // Create URLs for images
        let mediaPath: vscode.Uri | string = '';
        let infinityIconPath: string = '';

        if (this._extensionUri) {
            try {
                mediaPath = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media'));
                infinityIconPath = `${mediaPath}/infinity-icon.svg`;
            } catch (error) {
                console.error('Error creating webview URIs:', error);
            }
        } else {
            console.error('Extension URI is undefined');
        }

        return `<!DOCTYPE html>
        <html lang="${this._language}">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>AI Assistant</title>
            <style>
                :root {
                    --primary-color: #ff3333;
                    --primary-gradient: linear-gradient(135deg, #ff3333, #cc0000);
                    --secondary-gradient: linear-gradient(135deg, #ff6666, #ff3333);
                    --accent-color: #ff6666;
                    --text-on-primary: white;
                    --message-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
                    --hover-transform: translateY(-2px);
                }

                body {
                    font-family: var(--vscode-font-family);
                    padding: 0;
                    margin: 0;
                    color: var(--vscode-foreground);
                    background-color: var(--vscode-editor-background);
                    background-image:
                        radial-gradient(circle at 0% 0%, rgba(255, 51, 51, 0.03) 0%, transparent 50%),
                        radial-gradient(circle at 100% 100%, rgba(255, 102, 102, 0.03) 0%, transparent 50%);
                }

                .container {
                    display: flex;
                    flex-direction: column;
                    height: 100vh;
                    max-width: 100%;
                    box-sizing: border-box;
                }

                .header {
                    background: var(--primary-gradient);
                    color: var(--text-on-primary);
                    padding: 12px 16px;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
                    position: relative;
                    overflow: hidden;
                }

                .header::before {
                    content: '';
                    position: absolute;
                    top: 0;
                    left: 0;
                    right: 0;
                    bottom: 0;
                    background: linear-gradient(45deg, transparent 0%, rgba(255, 255, 255, 0.1) 50%, transparent 100%);
                    animation: shimmer 3s infinite;
                }

                @keyframes shimmer {
                    0% { transform: translateX(-100%); }
                    100% { transform: translateX(100%); }
                }

                .header-title {
                    display: flex;
                    align-items: center;
                    font-size: 16px;
                    font-weight: bold;
                    position: relative;
                    z-index: 1;
                }

                .profile-icon {
                    width: 32px;
                    height: 32px;
                    border-radius: 50%;
                    background: var(--secondary-gradient);
                    margin-right: 12px;
                    padding: 4px;
                    box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.2);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    transition: transform 0.3s ease;
                }

                .profile-icon:hover {
                    transform: scale(1.1);
                }

                .profile-icon img {
                    width: 24px;
                    height: 24px;
                    filter: brightness(0) invert(1);
                }

                .conversation {
                    flex: 1;
                    overflow-y: auto;
                    padding: 20px;
                    background-color: var(--vscode-editor-background);
                    background-image:
                        radial-gradient(circle at 10% 20%, rgba(255, 51, 51, 0.03) 0%, transparent 20%),
                        radial-gradient(circle at 90% 80%, rgba(255, 102, 102, 0.03) 0%, transparent 20%);
                }

                .message {
                    margin-bottom: 20px;
                    padding: 14px 18px;
                    border-radius: 12px;
                    max-width: 85%;
                    word-wrap: break-word;
                    animation: fadeIn 0.4s ease;
                    box-shadow: var(--message-shadow);
                    transition: transform 0.2s ease, box-shadow 0.2s ease;
                }

                .message:hover {
                    transform: var(--hover-transform);
                    box-shadow: 0 6px 12px rgba(0, 0, 0, 0.15);
                }

                @keyframes fadeIn {
                    from {
                        opacity: 0;
                        transform: translateY(20px);
                    }
                    to {
                        opacity: 1;
                        transform: translateY(0);
                    }
                }

                .user {
                    background: var(--primary-gradient);
                    color: var(--text-on-primary);
                    align-self: flex-end;
                    margin-left: auto;
                    border-top-right-radius: 4px;
                }

                .assistant {
                    background-color: var(--vscode-editor-inactiveSelectionBackground);
                    color: var(--vscode-foreground);
                    align-self: flex-start;
                    margin-right: auto;
                    border-top-left-radius: 4px;
                    position: relative;
                    padding-left: 24px;
                }

                .assistant::before {
                    content: '';
                    display: block;
                    position: absolute;
                    left: 0;
                    top: 0;
                    bottom: 0;
                    width: 4px;
                    background: var(--primary-gradient);
                    border-radius: 4px 0 0 4px;
                }

                .input-area {
                    display: flex;
                    padding: 16px;
                    border-top: 1px solid var(--vscode-panel-border);
                    background-color: var(--vscode-editor-background);
                    position: relative;
                }

                #query-input {
                    flex: 1;
                    padding: 14px;
                    border: 2px solid var(--vscode-input-border);
                    background-color: var(--vscode-input-background);
                    color: var(--vscode-input-foreground);
                    border-radius: 12px;
                    outline: none;
                    transition: all 0.3s ease;
                    font-size: 14px;
                }

                #query-input:focus {
                    border-color: var(--primary-color);
                    box-shadow: 0 0 0 3px rgba(255, 51, 51, 0.1);
                }

                .send-button {
                    margin-left: 10px;
                    padding: 10px 16px;
                    background: var(--primary-gradient);
                    color: var(--text-on-primary);
                    border: none;
                    border-radius: 12px;
                    cursor: pointer;
                    font-weight: bold;
                    transition: all 0.3s ease;
                    box-shadow: 0 2px 6px rgba(255, 51, 51, 0.3);
                    font-size: 13px;
                    position: relative;
                    overflow: hidden;
                }

                .send-button::before {
                    content: '';
                    position: absolute;
                    top: 0;
                    left: 0;
                    width: 100%;
                    height: 100%;
                    background: linear-gradient(45deg, transparent 0%, rgba(255, 255, 255, 0.2) 50%, transparent 100%);
                    transform: translateX(-100%);
                    transition: transform 0.6s ease;
                }

                .send-button:hover {
                    transform: var(--hover-transform);
                    box-shadow: 0 4px 12px rgba(255, 51, 51, 0.4);
                }

                .send-button:hover::before {
                    transform: translateX(100%);
                }

                .clear-button {
                    margin-left: 8px;
                    padding: 10px 16px;
                    background-color: transparent;
                    color: var(--vscode-errorForeground);
                    border: 2px solid var(--vscode-errorForeground);
                    border-radius: 12px;
                    cursor: pointer;
                    transition: all 0.3s ease;
                    font-size: 13px;
                    font-weight: 500;
                }

                .clear-button:hover {
                    background-color: var(--vscode-errorForeground);
                    color: white;
                    transform: var(--hover-transform);
                }

                .lang-button {
                    background-color: rgba(255, 255, 255, 0.1);
                    color: var(--text-on-primary);
                    border: 1px solid rgba(255, 255, 255, 0.2);
                    border-radius: 6px;
                    cursor: pointer;
                    padding: 6px 12px;
                    font-size: 12px;
                    transition: all 0.3s ease;
                    backdrop-filter: blur(4px);
                }

                .lang-button:hover {
                    background-color: rgba(255, 255, 255, 0.2);
                    transform: var(--hover-transform);
                }

                .loading {
                    display: none;
                    text-align: center;
                    margin: 24px 0;
                    padding: 24px;
                    border-radius: 12px;
                    background-color: rgba(0, 0, 0, 0.03);
                    animation: pulse 2s infinite;
                }

                @keyframes pulse {
                    0% { opacity: 0.6; }
                    50% { opacity: 1; }
                    100% { opacity: 0.6; }
                }

                .spinner {
                    display: inline-block;
                    position: relative;
                    width: 48px;
                    height: 48px;
                }

                .spinner::before {
                    content: "";
                    display: block;
                    position: absolute;
                    top: 0;
                    left: 0;
                    width: 100%;
                    height: 100%;
                    border-radius: 50%;
                    border: 4px solid rgba(255, 51, 51, 0.1);
                    border-top-color: var(--primary-color);
                    animation: spin 1s cubic-bezier(0.68, -0.55, 0.265, 1.55) infinite;
                }

                @keyframes spin {
                    to { transform: rotate(360deg); }
                }

                .loading-text {
                    margin-top: 12px;
                    color: var(--primary-color);
                    font-weight: 500;
                    font-size: 14px;
                }

                pre {
                    background-color: var(--vscode-textCodeBlock-background);
                    padding: 16px;
                    border-radius: 12px;
                    overflow-x: auto;
                    border-left: 4px solid var(--primary-color);
                    margin: 12px 0;
                    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
                }

                code {
                    font-family: var(--vscode-editor-font-family);
                    font-size: 13px;
                }

                .agent-working {
                    font-style: italic;
                    opacity: 0.9;
                    background-color: rgba(255, 51, 51, 0.05);
                    border-left: 4px solid var(--primary-color);
                    padding: 16px;
                    border-radius: 12px;
                    margin: 12px 0;
                    animation: pulse 2s infinite;
                }

                .message-actions {
                    display: flex;
                    justify-content: flex-end;
                    margin-top: 5px;
                }

                .restore-button {
                    background-color: var(--vscode-button-secondaryBackground);
                    color: var(--vscode-button-secondaryForeground);
                    border: none;
                    border-radius: 3px;
                    padding: 2px 8px;
                    font-size: 11px;
                    cursor: pointer;
                    margin-left: 5px;
                    display: flex;
                    align-items: center;
                    transition: all 0.2s ease;
                }

                .restore-button:hover {
                    background-color: var(--vscode-button-secondaryHoverBackground);
                    transform: translateY(-1px);
                }

                .restore-button::before {
                    content: "↺";
                    margin-right: 4px;
                    font-size: 12px;
                }

                /* Chat sidebar styles */
                .app-container {
                    display: flex;
                    height: 100vh;
                    width: 100%;
                }

                .chat-sidebar {
                    width: 250px;
                    background-color: var(--vscode-sideBar-background);
                    border-right: 1px solid var(--vscode-sideBar-border);
                    display: flex;
                    flex-direction: column;
                    overflow: hidden;
                }

                .chat-sidebar-header {
                    padding: 10px;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    border-bottom: 1px solid var(--vscode-sideBar-border);
                }

                .new-chat-button {
                    background-color: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    border: none;
                    border-radius: 3px;
                    padding: 5px 10px;
                    cursor: pointer;
                    font-size: 12px;
                    display: flex;
                    align-items: center;
                }

                .new-chat-button:hover {
                    background-color: var(--vscode-button-hoverBackground);
                }

                .new-chat-button svg {
                    margin-right: 5px;
                    width: 14px;
                    height: 14px;
                }

                .chat-list {
                    flex: 1;
                    overflow-y: auto;
                    padding: 5px;
                }

                .chat-item {
                    padding: 8px 10px;
                    margin-bottom: 2px;
                    border-radius: 4px;
                    cursor: pointer;
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    transition: background-color 0.2s;
                }

                .chat-item:hover {
                    background-color: var(--vscode-list-hoverBackground);
                }

                .chat-item.active {
                    background-color: var(--vscode-list-activeSelectionBackground);
                    color: var(--vscode-list-activeSelectionForeground);
                }

                .chat-title {
                    flex: 1;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    font-size: 13px;
                }

                .chat-actions {
                    display: none;
                    margin-left: 5px;
                }

                .chat-item:hover .chat-actions {
                    display: flex;
                }

                .chat-action-button {
                    background: none;
                    border: none;
                    color: var(--vscode-foreground);
                    cursor: pointer;
                    padding: 2px 5px;
                    font-size: 12px;
                    opacity: 0.7;
                }

                .chat-action-button:hover {
                    opacity: 1;
                }

                .main-content {
                    flex: 1;
                    display: flex;
                    flex-direction: column;
                    overflow: hidden;
                }
            </style>
        </head>
        <body>
            <div class="app-container">
                <div class="chat-sidebar">
                    <div class="chat-sidebar-header">
                        <h3>Chats</h3>
                        <button class="new-chat-button" id="new-chat-button">
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <line x1="12" y1="5" x2="12" y2="19"></line>
                                <line x1="5" y1="12" x2="19" y2="12"></line>
                            </svg>
                            New Chat
                        </button>
                    </div>
                    <div class="chat-list" id="chat-list">
                        <!-- Chat items will be added here dynamically -->
                    </div>
                </div>

                <div class="main-content">
                <div class="header">
                    <div class="header-title">
                        <div class="profile-icon">
                            <img src="${infinityIconPath}" alt="AI" />
                        </div>
                        <span>Samantha Coder</span>
                    </div>
                    <button class="lang-button" id="lang-button">${translations[this._language].changeLanguageButton}</button>
                </div>

                <div class="conversation" id="conversation">
                    <div class="message assistant">
                        ${translations[this._language].welcomeMessage}
                    </div>
                </div>

                <div class="loading" id="loading">
                    <div class="spinner"></div>
                    <div class="loading-text">${translations[this._language].loadingText}</div>
                </div>

                <div class="input-area">
                    <input type="text" id="query-input" placeholder="${translations[this._language].inputPlaceholder}" />
                    <button class="send-button" id="send-button">${translations[this._language].sendButton}</button>
                    <button class="clear-button" id="clear-button">${translations[this._language].clearButton}</button>
                    </div>
                </div>
            </div>

            <script>
                (function() {
                    const vscode = acquireVsCodeApi();
                    const conversationEl = document.getElementById('conversation');
                    const queryInput = document.getElementById('query-input');
                    const sendButton = document.getElementById('send-button');
                    const clearButton = document.getElementById('clear-button');
                    const langButton = document.getElementById('lang-button');
                    const loadingEl = document.getElementById('loading');
                    const chatListEl = document.getElementById('chat-list');
                    const newChatButton = document.getElementById('new-chat-button');

                    // Current translations
                    let currentTranslations = ${JSON.stringify(translations[this._language])};

                    // Current chat ID
                    let currentChatId = null;

                    // Format messages with markdown-like syntax
                    function formatMessage(text) {
                        // Handle code blocks
                        text = text.replace(/\`\`\`([^\`]+)\`\`\`/g, '<pre><code>$1</code></pre>');

                        // Handle inline code
                        text = text.replace(/\`([^\`]+)\`/g, '<code>$1</code>');

                        // Handle line breaks
                        text = text.replace(/\\n/g, '<br>');

                        return text;
                    }

                    function addMessageToUI(message) {
                        const messageEl = document.createElement('div');
                        messageEl.className = \`message \${message.role}\`;
                        messageEl.dataset.timestamp = message.timestamp;

                        // Add agent-working class if it's the agent working message
                        if (message.role === 'assistant' && message.content.includes(currentTranslations.workingMessage)) {
                            messageEl.classList.add('agent-working');
                        }

                        const contentDiv = document.createElement('div');
                        contentDiv.className = 'message-content';
                        contentDiv.innerHTML = formatMessage(message.content);

                        // Add restore button for user messages
                        if (message.role === 'user') {
                            const actionsDiv = document.createElement('div');
                            actionsDiv.className = 'message-actions';

                            const restoreButton = document.createElement('button');
                            restoreButton.className = 'restore-button';
                            restoreButton.textContent = 'Restore state';
                            restoreButton.title = 'Restore workspace to the state before this message was sent';
                            restoreButton.onclick = () => {
                                if (confirm('Are you sure you want to restore to the state before this message? Any files created or modified since then may be affected.')) {
                                    vscode.postMessage({
                                        type: 'restoreState',
                                        messageId: message.timestamp
                                    });
                                }
                            };

                            actionsDiv.appendChild(restoreButton);
                            messageEl.appendChild(contentDiv);
                            messageEl.appendChild(actionsDiv);
                        } else {
                            messageEl.appendChild(contentDiv);
                        }

                        conversationEl.appendChild(messageEl);
                        conversationEl.scrollTop = conversationEl.scrollHeight;
                    }

                    // Update UI text elements based on language
                    function updateUILanguage(trans) {
                        currentTranslations = trans;
                        document.documentElement.lang = currentTranslations.changeLanguageButton === 'EN' ? 'pt-br' : 'en';

                        // Update placeholders and button texts
                        queryInput.placeholder = currentTranslations.inputPlaceholder;
                        sendButton.textContent = currentTranslations.sendButton;
                        clearButton.textContent = currentTranslations.clearButton;
                        langButton.textContent = currentTranslations.changeLanguageButton;

                        // Update loading text
                        document.querySelector('.loading-text').textContent = currentTranslations.loadingText;
                    }

                    // Handle sending query
                    function sendQuery() {
                        const query = queryInput.value.trim();
                        if (query) {
                            vscode.postMessage({
                                type: 'sendQuery',
                                value: query
                            });
                            queryInput.value = '';
                        }
                    }

                    // Create a chat item element
                    function createChatItem(chat) {
                        const chatItem = document.createElement('div');
                        chatItem.className = 'chat-item';
                        if (chat.id === currentChatId) {
                            chatItem.classList.add('active');
                        }
                        chatItem.dataset.chatId = chat.id;

                        const titleSpan = document.createElement('span');
                        titleSpan.className = 'chat-title';
                        titleSpan.textContent = chat.title;

                        const actionsDiv = document.createElement('div');
                        actionsDiv.className = 'chat-actions';

                        const renameButton = document.createElement('button');
                        renameButton.className = 'chat-action-button';
                        renameButton.innerHTML = '✏️';
                        renameButton.title = 'Rename';
                        renameButton.onclick = (e) => {
                            e.stopPropagation();
                            const newTitle = prompt('Enter new chat title:', chat.title);
                            if (newTitle && newTitle.trim() !== '') {
                                vscode.postMessage({
                                    type: 'renameChat',
                                    chatId: chat.id,
                                    newTitle: newTitle.trim()
                                });
                            }
                        };

                        const deleteButton = document.createElement('button');
                        deleteButton.className = 'chat-action-button';
                        deleteButton.innerHTML = '🗑️';
                        deleteButton.title = 'Delete';
                        deleteButton.onclick = (e) => {
                            e.stopPropagation();
                            // Prevent deleting the only chat
                            const chatCount = document.querySelectorAll('.chat-item').length;
                            if (chatCount <= 1) {
                                alert('Cannot delete the only chat. Create a new chat first.');
                                return;
                            }

                            if (confirm('Are you sure you want to delete this chat?')) {
                                vscode.postMessage({
                                    type: 'deleteChat',
                                    chatId: chat.id
                                });
                            }
                        };

                        actionsDiv.appendChild(renameButton);
                        actionsDiv.appendChild(deleteButton);

                        chatItem.appendChild(titleSpan);
                        chatItem.appendChild(actionsDiv);

                        chatItem.onclick = () => {
                            // Don't switch if already active
                            if (chat.id !== currentChatId) {
                                vscode.postMessage({
                                    type: 'switchChat',
                                    chatId: chat.id
                                });
                            }
                        };

                        return chatItem;
                    }

                    // Update the chat list
                    function updateChatList(chats, activeChatId) {
                        chatListEl.innerHTML = '';
                        currentChatId = activeChatId;

                        chats.forEach(chat => {
                            chatListEl.appendChild(createChatItem(chat));
                        });
                    }

                    // Event listeners
                    sendButton.addEventListener('click', sendQuery);

                    queryInput.addEventListener('keydown', (e) => {
                        if (e.key === 'Enter') {
                            sendQuery();
                        }
                    });

                    clearButton.addEventListener('click', () => {
                        vscode.postMessage({
                            type: 'clearConversation'
                        });
                    });

                    langButton.addEventListener('click', () => {
                        vscode.postMessage({
                            type: 'toggleLanguage'
                        });
                    });

                    newChatButton.addEventListener('click', () => {
                        const title = prompt('Enter chat title:', 'New Chat');
                        if (title && title.trim() !== '') {
                            vscode.postMessage({
                                type: 'createNewChat',
                                title: title.trim()
                            });
                        } else {
                            vscode.postMessage({
                                type: 'createNewChat'
                            });
                        }
                    });

                    // Handle messages from the extension
                    window.addEventListener('message', event => {
                        const message = event.data;
                        switch (message.type) {
                            case 'addMessage':
                                addMessageToUI(message.message);
                                break;
                            case 'clearConversation':
                                conversationEl.innerHTML = '';
                                addMessageToUI({
                                    role: 'assistant',
                                    content: currentTranslations.welcomeMessage,
                                    timestamp: new Date().toISOString()
                                });
                                break;
                            case 'setLoading':
                                loadingEl.style.display = message.isLoading ? 'block' : 'none';
                                break;
                            case 'updateLanguage':
                                updateUILanguage(message.translations);
                                break;
                            case 'restoreConversation':
                                conversationEl.innerHTML = '';
                                if (Array.isArray(message.messages)) {
                                    message.messages.forEach(msg => {
                                        addMessageToUI(msg);
                                    });
                                }
                                break;
                            case 'updateChats':
                                updateChatList(message.chats, message.currentChatId);
                                break;
                            case 'switchChat':
                                currentChatId = message.chatId;
                                conversationEl.innerHTML = '';
                                if (Array.isArray(message.messages)) {
                                    message.messages.forEach(msg => {
                                        addMessageToUI(msg);
                                    });
                                }
                                // Update active chat in the sidebar
                                document.querySelectorAll('.chat-item').forEach(item => {
                                    if (item.dataset.chatId === message.chatId) {
                                        item.classList.add('active');
                                    } else {
                                        item.classList.remove('active');
                                    }
                                });
                                break;
                        }
                    });
                })();
            </script>
        </body>
        </html>`;
    }

    public getAgentUtils(): AgentUtils {
        return this._agentUtils;
    }

    public toggleLanguage() {
        // Toggle between English and Portuguese
        this._language = this._language === 'en' ? 'pt-br' : 'en';

        // Update the configuration
        const config = vscode.workspace.getConfiguration('aiAssistant');
        config.update('language', this._language, true);

        // Update the webview content while preserving chat history
        if (this._view) {
            this._view.webview.html = this._getHtmlForWebview(this._view.webview);

            // Send current chat state to webview
            this._postMessageToWebview({
                type: 'updateLanguage',
                translations: translations[this._language]
            });

            // Restore current chat messages
            const currentChat = this._getCurrentChat();
            if (currentChat) {
                this._postMessageToWebview({
                    type: 'restoreConversation',
                    messages: this._getMessagesForDisplay(currentChat.messages)
                });
            }

            // Update chat list
            this._postMessageToWebview({
                type: 'updateChats',
                chats: this._chats,
                currentChatId: this._currentChatId
            });
        }
    }

    // Take a snapshot of the current state
    private async _takeStateSnapshot(messageId: string) {
        try {
            // Create a snapshot even if no editor is active
            const snapshot: StateSnapshot = {
                files: {},
                timestamp: new Date().toISOString(),
                chatId: this._currentChatId,
                trackedFiles: [...this._trackedFiles] // Store the set of tracked files at this point
            };

            // Track open editors and their content
            for (const editor of vscode.window.visibleTextEditors) {
                const document = editor.document;
                snapshot.files[document.uri.fsPath] = {
                    exists: true,
                    content: document.getText(),
                    version: document.version
                };
            }

            // Store the snapshot
            this._conversationHistory[messageId] = snapshot;

            // If there's an active editor, mark its file as the primary focus
            const activeEditor = vscode.window.activeTextEditor;
            if (activeEditor) {
                const document = activeEditor.document;
                if (snapshot.files[document.uri.fsPath]) {
                    snapshot.primaryFile = document.uri.fsPath;
                }
            }

            // Reset the tracked files set after taking a snapshot
            this._trackedFiles.clear();

            // Re-add the currently open files to the tracked set
            vscode.window.visibleTextEditors.forEach(editor => {
                this._trackedFiles.add(editor.document.uri.fsPath);
            });
        } catch (error) {
            console.error('Error taking state snapshot:', error);
        }
    }

    // Restore to the state before a specific message
    public async restoreToState(messageId: string) {
        try {
            const snapshot = this._conversationHistory[messageId] as StateSnapshot;
            if (!snapshot) {
                vscode.window.showErrorMessage('No previous state found for this message');
                return;
            }

            // Get the current chat
            const currentChat = this._getCurrentChat();
            if (!currentChat) {
                return;
            }

            // Find the message in the conversation
            const messageIndex = currentChat.messages.findIndex(msg => msg.timestamp === messageId);
            if (messageIndex === -1) {
                vscode.window.showErrorMessage('Message not found in conversation');
                return;
            }

            // Get a list of files that were created or modified after this snapshot
            const filesCreatedAfter = new Set<string>(this._trackedFiles);

            // If the snapshot has trackedFiles, remove them from the current set
            if (snapshot.trackedFiles) {
                snapshot.trackedFiles.forEach(file => {
                    filesCreatedAfter.delete(file);
                });
            }

            // Check if there are files that were created after this message
            if (filesCreatedAfter.size > 0) {
                // Ask user if they want to delete newly created files
                const deleteNewFiles = await vscode.window.showInformationMessage(
                    `${filesCreatedAfter.size} file(s) were created after this message. Delete them?`,
                    'Yes', 'No'
                );

                if (deleteNewFiles === 'Yes') {
                    // Delete files created after the snapshot
                    const deletedCount = await this._deleteFiles(filesCreatedAfter);
                    if (deletedCount > 0) {
                        vscode.window.showInformationMessage(`Deleted ${deletedCount} file(s) created after the message`);
                    }
                }
            }

            // Implement restoration logic
            if (snapshot.files) {
                // Keep track of successful restorations
                let restoredCount = 0;
                let primaryFileOpened = false;

                // Process each file in the snapshot
                for (const [filePath, fileData] of Object.entries(snapshot.files)) {
                    try {
                        // Restore file content if it existed at the time of snapshot
                        if (fileData.exists && fileData.content) {
                            await this._agentUtils.writeFile(filePath, fileData.content);
                            restoredCount++;

                            // Open the primary file (the one that was active when snapshot was taken)
                            if (snapshot.primaryFile === filePath && !primaryFileOpened) {
                                const uri = vscode.Uri.file(filePath);
                                const document = await vscode.workspace.openTextDocument(uri);
                                await vscode.window.showTextDocument(document);
                                primaryFileOpened = true;
                            }
                        }
                    } catch (fileError) {
                        console.error(`Error restoring file ${filePath}:`, fileError);
                    }
                }

                // If we have a primary file but couldn't open it, try opening the first restored file
                if (!primaryFileOpened && restoredCount > 0 && snapshot.primaryFile) {
                    try {
                        const uri = vscode.Uri.file(snapshot.primaryFile);
                        const document = await vscode.workspace.openTextDocument(uri);
                        await vscode.window.showTextDocument(document);
                    } catch (error) {
                        console.error('Error opening primary file:', error);
                    }
                }

                // Show restoration success message
                if (restoredCount > 0) {
                    vscode.window.showInformationMessage(`Restored ${restoredCount} file(s) to state before message`);
                } else {
                    // If no files were in the snapshot, this was likely the start of the conversation
                    vscode.window.showInformationMessage('Restored to initial state before any changes');
                }
            }

            // Remove all messages after this one from the conversation
            currentChat.messages = currentChat.messages.slice(0, messageIndex + 1);
            currentChat.updatedAt = new Date().toISOString();

            // Update the webview to reflect the changes
            await this._postMessageToWebview({
                type: 'restoreConversation',
                messages: this._getMessagesForDisplay(currentChat.messages)
            });

            // Reset the tracked files to the state at the time of the snapshot
            this._trackedFiles.clear();
            if (snapshot.trackedFiles) {
                snapshot.trackedFiles.forEach(file => {
                    this._trackedFiles.add(file);
                });
            }
        } catch (error) {
            console.error('Error restoring state:', error);
            vscode.window.showErrorMessage(`Failed to restore state: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    // Helper method to delete multiple files
    private async _deleteFiles(filesToDelete: Set<string>): Promise<number> {
        let deletedCount = 0;

        for (const filePath of filesToDelete) {
            try {
                const uri = vscode.Uri.file(filePath);

                // Check if the file exists before attempting to delete
                try {
                    await vscode.workspace.fs.stat(uri);

                    // File exists, delete it
                    await vscode.workspace.fs.delete(uri, { useTrash: false });
                    deletedCount++;
                } catch (statError) {
                    // File doesn't exist, skip it
                    console.log(`File ${filePath} doesn't exist, skipping deletion`);
                }
            } catch (error) {
                console.error(`Error deleting file ${filePath}:`, error);
            }
        }

        return deletedCount;
    }
}
