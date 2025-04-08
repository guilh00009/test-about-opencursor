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
exports.AIAssistantViewProvider = void 0;
const vscode = __importStar(require("vscode"));
const fetch_polyfill_1 = require("./fetch-polyfill");
const agentUtils_1 = require("./agentUtils");
// Default API key to use if none is provided in settings
const DEFAULT_API_KEY = 'fw_3ZMEgbYxRkZNQPUwxnjuCkMD';
const translations = {
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
class AIAssistantViewProvider {
    constructor(_extensionUri) {
        this._extensionUri = _extensionUri;
        this._conversation = [];
        this._isProcessingAgentActions = false;
        this._lastEditedFile = null;
        this._lastEditTime = 0;
        this._language = 'en';
        this._agentUtils = new agentUtils_1.AgentUtils();
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
        });
        // Initialize with system message for agent capabilities
        this._updateSystemMessage();
    }
    _updateSystemMessage() {
        // Remove existing system message
        this._conversation = this._conversation.filter(msg => msg.role !== 'system');
        // Get workspace info
        const workspaceFolders = vscode.workspace.workspaceFolders || [];
        const workspaceInfo = workspaceFolders.map(folder => folder.uri.fsPath).join(', ');
        // Add updated system message
        this._conversation.push({
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
            `
        });
    }
    async gatherUserContext() {
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
                }
                else {
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
            }
            else {
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
            }
            catch (error) {
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
            }
            catch (error) {
                console.error('Error getting extensions:', error);
            }
            return context;
        }
        catch (error) {
            console.error('Error gathering context:', error);
            return "Error gathering context";
        }
    }
    ensureWebviewIsVisible() {
        try {
            if (!this._view) {
                // Try to show the view if not already visible
                vscode.commands.executeCommand('workbench.view.extension.ai-assistant-view');
                vscode.commands.executeCommand('aiAssistantView.focus');
            }
            else {
                // If view exists but might not be visible, try to show it
                this._view.show(true);
            }
        }
        catch (error) {
            console.error('Error ensuring webview is visible:', error);
        }
    }
    resolveWebviewView(webviewView, context, _token) {
        this._view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                this._extensionUri
            ]
        };
        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);
        // Handle messages from the webview
        webviewView.webview.onDidReceiveMessage(async (message) => {
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
            }
        });
    }
    async sendQueryToAI(query) {
        try {
            if (!this._view) {
                return;
            }
            // Gather current context before sending query
            const userContext = await this.gatherUserContext();
            // Update the system message with fresh context
            this._updateSystemMessage();
            // Add context as a separate system message
            this._conversation.push({
                role: 'system',
                content: `Current user context:\n${userContext}`
            });
            // Add user message to conversation
            this._conversation.push({
                role: 'user',
                content: query
            });
            // Update UI with user message
            this._view.webview.postMessage({
                type: 'addMessage',
                message: { role: 'user', content: query }
            });
            // Show loading indicator
            this._view.webview.postMessage({ type: 'setLoading', isLoading: true });
            // Get AI response
            await this._getAIResponse();
        }
        catch (error) {
            console.error('Error in sendQueryToAI:', error);
            vscode.window.showErrorMessage(`Error: ${error instanceof Error ? error.message : String(error)}`);
            if (this._view) {
                this._view.webview.postMessage({
                    type: 'addMessage',
                    message: {
                        role: 'assistant',
                        content: translations[this._language].errorMessage
                    }
                });
            }
        }
        finally {
            // Hide loading indicator
            if (this._view) {
                this._view.webview.postMessage({ type: 'setLoading', isLoading: false });
            }
        }
    }
    async _getAIResponse() {
        try {
            if (!this._view) {
                return;
            }
            // Get API key from settings or use default
            const config = vscode.workspace.getConfiguration('aiAssistant');
            let apiKey = config.get('apiKey');
            // If no API key in settings, use the default one
            if (!apiKey || apiKey.trim() === '') {
                apiKey = DEFAULT_API_KEY;
            }
            const model = config.get('model');
            // Call Fireworks API
            const response = await (0, fetch_polyfill_1.fetch)("https://api.fireworks.ai/inference/v1/chat/completions", {
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
                    messages: this._conversation
                })
            });
            if (!response.ok) {
                throw new Error(`API request failed: ${response.statusText}`);
            }
            const data = await response.json();
            const assistantMessage = data.choices[0].message.content;
            // Add assistant response to conversation
            this._conversation.push({
                role: 'assistant',
                content: assistantMessage
            });
            // Update UI with assistant message
            this._view.webview.postMessage({
                type: 'addMessage',
                message: { role: 'assistant', content: assistantMessage }
            });
            // Check if the message contains agent actions
            await this._processAgentActions(assistantMessage);
        }
        catch (error) {
            console.error('Error calling Fireworks API:', error);
            throw error; // Rethrow to be handled by caller
        }
    }
    _updateWebviewContent() {
        if (this._view) {
            this._view.webview.html = this._getHtmlForWebview(this._view.webview);
            // Update welcome message
            this._view.webview.postMessage({
                type: 'updateLanguage',
                translations: translations[this._language]
            });
        }
    }
    async _processAgentActions(message) {
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
                    await this._processJsonActions(actionData);
                }
                catch (parseError) {
                    console.error('Error parsing JSON from code block:', parseError);
                    this._agentUtils.log(`Error parsing JSON from code block: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
                }
            }
            else {
                // Try extracting without code block markers
                try {
                    const jsonData = JSON.parse(message);
                    if (jsonData && jsonData.actions && Array.isArray(jsonData.actions)) {
                        this._agentUtils.log(`Found JSON without code block markers`);
                        await this._processJsonActions(jsonData);
                    }
                    else {
                        this._agentUtils.log(`Parsed JSON but no valid actions array found`);
                    }
                }
                catch (e) {
                    // Not valid JSON
                    this._agentUtils.log(`No JSON code blocks found and content is not valid JSON`);
                }
            }
        }
        catch (error) {
            console.error('Error processing agent actions:', error);
            this._agentUtils.log(`Error processing agent actions: ${error instanceof Error ? error.message : String(error)}`);
            if (this._view) {
                this._view.webview.postMessage({
                    type: 'addMessage',
                    message: {
                        role: 'assistant',
                        content: `❌ ${error instanceof Error ? error.message : String(error)}`
                    }
                });
            }
        }
        finally {
            this._isProcessingAgentActions = false;
            if (this._view) {
                this._view.webview.postMessage({ type: 'setLoading', isLoading: false });
            }
        }
    }
    async _processJsonActions(actionData) {
        if (!actionData.actions || !Array.isArray(actionData.actions)) {
            this._agentUtils.log(`No valid actions array found in JSON`);
            return; // No valid actions array
        }
        // Check if there's a "stop" action which should halt the agent after executing all actions
        const hasStopAction = actionData.actions.some((action) => action.type === 'stop');
        // Show that the agent is working
        this._agentUtils.showOutputChannel();
        this._agentUtils.log(`Processing ${actionData.actions.length} agent actions...`);
        this._agentUtils.log(`Thoughts: ${actionData.thoughts || 'No thoughts provided'}`);
        // Log each action for debugging
        actionData.actions.forEach((action, index) => {
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
                    content: translations[this._language].workingMessage
                }
            });
            this._view.webview.postMessage({ type: 'setLoading', isLoading: true });
        }
        // Execute actions
        try {
            const actionResults = await this._agentUtils.executeActions(actionData.actions);
            this._agentUtils.log(`Actions executed successfully`);
            // Log results for debugging
            actionResults.forEach((result, index) => {
                let resultStr = 'undefined';
                if (result.result) {
                    if (typeof result.result === 'string') {
                        resultStr = result.result.substring(0, 100);
                    }
                    else {
                        try {
                            resultStr = JSON.stringify(result.result).substring(0, 100);
                        }
                        catch (e) {
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
                            content: translations[this._language].taskCompletedMessage
                        }
                    });
                }
                return;
            }
            // Format results to send back to AI
            const resultsForAI = JSON.stringify(actionResults, null, 2);
            // Update context after actions completed
            const updatedContext = await this.gatherUserContext();
            // First add context as a system message
            this._conversation.push({
                role: 'system',
                content: `Updated context after actions:\n${updatedContext}`
            });
            // Add action results as a system message to the conversation (not shown in UI)
            this._conversation.push({
                role: 'system',
                content: `The assistant has completed the actions. Here are the results:\n\`\`\`json\n${resultsForAI}\n\`\`\`\n
                Based on these results, determine what to do next. You can:
                1. Continue with more actions by returning a new JSON with "actions" array
                2. Stop the iteration by including an action with "type": "stop" if the task is completed
                3. Provide a final response to the user with your findings

                Please analyze these results and respond appropriately.`
            });
            // Call API again with updated conversation
            await this._getAIResponse();
        }
        catch (error) {
            console.error('Error executing actions:', error);
            this._agentUtils.log(`Error executing actions: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
        }
    }
    clearConversation() {
        // Keep system message but clear the rest
        this._conversation = this._conversation.filter(msg => msg.role === 'system');
        if (this._view) {
            this._view.webview.postMessage({ type: 'clearConversation' });
        }
    }
    _getHtmlForWebview(webview) {
        // Criar URLs para imagens
        const mediaPath = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media'));
        const infinityIconPath = `${mediaPath}/infinity-icon.svg`;
        // Escapar caracteres especiais para evitar problemas com a template string
        const currentLang = this._language;
        const langButton = translations[currentLang].changeLanguageButton;
        const welcomeMsg = translations[currentLang].welcomeMessage;
        const loadingText = translations[currentLang].loadingText;
        const inputPlaceholder = translations[currentLang].inputPlaceholder;
        const sendButtonText = translations[currentLang].sendButton;
        const clearButtonText = translations[currentLang].clearButton;
        const translationsJson = JSON.stringify(translations[currentLang])
            .replace(/`/g, '\\`') // Escape backticks
            .replace(/\$/g, '\\$'); // Escape $ to prevent template substitution
        // Construir o HTML como uma string
        return `<!DOCTYPE html>
<html lang="${currentLang}">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>AI Assistant</title>
    <style>
        :root {
            --primary-color: #ff3333;
            --primary-gradient: linear-gradient(135deg, #ff3333, #cc0000);
            --accent-color: #ff6666;
            --text-on-primary: white;
        }

        body {
            font-family: var(--vscode-font-family);
            padding: 0;
            margin: 0;
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
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
            padding: 10px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            box-shadow: 0 2px 5px rgba(0,0,0,0.2);
        }
        .header-title {
            display: flex;
            align-items: center;
            font-size: 16px;
            font-weight: bold;
        }
        .profile-icon {
            width: 28px;
            height: 28px;
            border-radius: 50%;
            background: var(--primary-color);
            margin-right: 10px;
            padding: 4px;
            box-shadow: 0 0 0 2px rgba(255,255,255,0.2);
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .profile-icon img {
            width: 24px;
            height: 24px;
            filter: brightness(0) invert(1);
        }
        .conversation {
            flex: 1;
            overflow-y: auto;
            padding: 15px;
            background-color: var(--vscode-editor-background);
            background-image: radial-gradient(circle at 10% 20%, rgba(255, 0, 0, 0.03) 0%, transparent 20%);
        }
        .message {
            margin-bottom: 16px;
            padding: 12px 16px;
            border-radius: 8px;
            max-width: 85%;
            word-wrap: break-word;
            animation: fadeIn 0.3s ease;
            box-shadow: 0 1px 3px rgba(0,0,0,0.1);
        }
        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(10px); }
            to { opacity: 1; transform: translateY(0); }
        }
        .user {
            background-color: var(--primary-color);
            color: var(--text-on-primary);
            align-self: flex-end;
            margin-left: auto;
            border-top-right-radius: 2px;
        }
        .assistant {
            background-color: var(--vscode-editor-inactiveSelectionBackground);
            color: var(--vscode-foreground);
            align-self: flex-start;
            margin-right: auto;
            border-top-left-radius: 2px;
            position: relative;
            padding-left: 20px;
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
            padding: 15px;
            border-top: 1px solid var(--vscode-panel-border);
            background-color: var(--vscode-editor-background);
        }
        #query-input {
            flex: 1;
            padding: 12px;
            border: 1px solid var(--vscode-input-border);
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border-radius: 8px;
            outline: none;
            transition: border-color 0.2s;
        }
        #query-input:focus {
            border-color: var(--primary-color);
            box-shadow: 0 0 0 1px var(--primary-color);
        }
        .send-button {
            margin-left: 8px;
            padding: 8px 12px;
            background: var(--primary-gradient);
            color: var(--text-on-primary);
            border: none;
            border-radius: 8px;
            cursor: pointer;
            font-weight: bold;
            transition: all 0.2s;
            box-shadow: 0 2px 5px rgba(255, 0, 0, 0.25);
            font-size: 12px;
        }
        .send-button:hover {
            transform: translateY(-1px);
            box-shadow: 0 4px 8px rgba(255, 0, 0, 0.3);
        }
        .clear-button {
            margin-left: 6px;
            padding: 8px 12px;
            background-color: var(--vscode-editor-background);
            color: var(--vscode-errorForeground);
            border: 1px solid var(--vscode-errorForeground);
            border-radius: 8px;
            cursor: pointer;
            transition: all 0.2s;
            font-size: 12px;
        }
        .clear-button:hover {
            background-color: var(--vscode-errorForeground);
            color: white;
        }
        .lang-button {
            background-color: transparent;
            color: var(--text-on-primary);
            border: 1px solid rgba(255, 255, 255, 0.3);
            border-radius: 4px;
            cursor: pointer;
            padding: 4px 8px;
            font-size: 11px;
            transition: all 0.2s;
        }
        .lang-button:hover {
            background-color: rgba(255, 255, 255, 0.1);
        }
        .loading {
            display: none;
            text-align: center;
            margin: 20px 0;
            padding: 20px;
            border-radius: 8px;
            background-color: rgba(0, 0, 0, 0.05);
        }
        .spinner {
            display: inline-block;
            position: relative;
            width: 40px;
            height: 40px;
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
            border: 3px solid rgba(255, 0, 0, 0.1);
            border-top-color: var(--primary-color);
            animation: spin 1s ease-in-out infinite;
        }
        @keyframes spin {
            to { transform: rotate(360deg); }
        }
        .loading-text {
            margin-top: 10px;
            color: var(--primary-color);
            font-weight: 500;
        }
        pre {
            background-color: var(--vscode-textCodeBlock-background);
            padding: 12px;
            border-radius: 8px;
            overflow-x: auto;
            border-left: 3px solid var(--primary-color);
        }
        code {
            font-family: var(--vscode-editor-font-family);
        }
        .agent-working {
            font-style: italic;
            opacity: 0.8;
            background-color: rgba(255, 0, 0, 0.05);
            border-left: 3px solid var(--primary-color);
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div class="header-title">
                <div class="profile-icon">
                    <img src="${infinityIconPath}" alt="AI" />
                </div>
                <span>Samantha Coder</span>
            </div>
            <button class="lang-button" id="lang-button">${langButton}</button>
        </div>

        <div class="conversation" id="conversation">
            <div class="message assistant">
                ${welcomeMsg}
            </div>
        </div>

        <div class="loading" id="loading">
            <div class="spinner"></div>
            <div class="loading-text">${loadingText}</div>
        </div>

        <div class="input-area">
            <input type="text" id="query-input" placeholder="${inputPlaceholder}" />
            <button class="send-button" id="send-button">${sendButtonText}</button>
            <button class="clear-button" id="clear-button">${clearButtonText}</button>
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

            // Current translations
            let currentTranslations = ${translationsJson};

            // Format messages with markdown-like syntax
            function formatMessage(text) {
                // Handle code blocks
                text = text.replace(/` ``([ ^ `]+)` `` / g, '<pre><code>$1</code></pre>']);
        // Handle inline code
        text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
        // Handle line breaks
        text = text.replace(/\\n/g, '<br>');
        return text;
    }
}
exports.AIAssistantViewProvider = AIAssistantViewProvider;
function addMessageToUI(message) {
    const messageEl = document.createElement('div');
    messageEl.className = "message " + message.role;
    // Add agent-working class if it's the agent working message
    if (message.role === 'assistant' && message.content.includes(currentTranslations.workingMessage)) {
        messageEl.classList.add('agent-working');
    }
    messageEl.innerHTML = formatMessage(message.content);
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
                content: currentTranslations.welcomeMessage
            });
            break;
        case 'setLoading':
            loadingEl.style.display = message.isLoading ? 'block' : 'none';
            break;
        case 'updateLanguage':
            updateUILanguage(message.translations);
            break;
    }
});
();
/script>
    < /body>
    < /html>`;;
getAgentUtils();
agentUtils_1.AgentUtils;
{
    return this._agentUtils;
}
toggleLanguage();
{
    // Toggle between English and Portuguese
    this._language = this._language === 'en' ? 'pt-br' : 'en';
    // Update the configuration
    const config = vscode.workspace.getConfiguration('aiAssistant');
    config.update('language', this._language, true);
    // Update the webview content
    this._updateWebviewContent();
}
//# sourceMappingURL=aiAssistantViewProvider.js.map