import * as vscode from 'vscode';
import { AgentUtils } from './agentUtils';
interface Message {
    role: 'user' | 'assistant' | 'system';
    content: string;
    timestamp: string;
}
interface Chat {
    id: string;
    title: string;
    messages: Message[];
    createdAt: string;
    updatedAt: string;
}
export declare class AIAssistantViewProvider implements vscode.WebviewViewProvider {
    private readonly _extensionUri;
    private _view?;
    private _chats;
    private _currentChatId;
    private _agentUtils;
    private _isProcessingAgentActions;
    private _lastEditedFile;
    private _lastEditTime;
    private _language;
    private _conversationHistory;
    private _trackedFiles;
    private _abortController;
    private _isGeneratingResponse;
    constructor(_extensionUri: vscode.Uri);
    private _ensureDefaultChat;
    private _createNewChat;
    private _getCurrentChat;
    private _getMessagesForDisplay;
    private _switchChat;
    private _renameChat;
    private _deleteChat;
    private _updateSystemMessage;
    gatherUserContext(): Promise<string>;
    ensureWebviewIsVisible(): void;
    resolveWebviewView(webviewView: vscode.WebviewView, _context: vscode.WebviewViewResolveContext, _token: vscode.CancellationToken): void;
    sendQueryToAI(query: string): Promise<void>;
    private _postMessageToWebview;
    private _getAIResponse;
    private _updateWebviewContent;
    _processAgentActions(message: string, chat: Chat): Promise<void>;
    private _processJsonActions;
    clearConversation(): void;
    private _getHtmlForWebview;
    getAgentUtils(): AgentUtils;
    toggleLanguage(): void;
    private _takeStateSnapshot;
    restoreToState(messageId: string): Promise<void>;
    private _deleteFiles;
    private _getConfiguration;
    private _saveConfiguration;
}
export {};
//# sourceMappingURL=aiAssistantViewProvider.d.ts.map