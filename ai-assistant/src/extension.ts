import * as vscode from 'vscode';
import { AIAssistantViewProvider } from './aiAssistantViewProvider';

export function activate(context: vscode.ExtensionContext) {
	console.log('AI Assistant extension activated');

	// Create the provider instance
	const aiAssistantProvider = new AIAssistantViewProvider(context.extensionUri);

	// Register the webview view provider first before anything else
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(
			'aiAssistantView',  // This must match exactly with the id in package.json
			aiAssistantProvider,
			{
				webviewOptions: {
					retainContextWhenHidden: true,
				}
			}
		)
	);

	// Register commands
	context.subscriptions.push(
		vscode.commands.registerCommand('aiAssistant.sendQuery', () => {
			vscode.window.showInputBox({
				placeHolder: 'Enter your question for the AI Assistant',
				prompt: 'Press Enter to send'
			}).then((query: string | undefined) => {
				if (query) {
					aiAssistantProvider.sendQueryToAI(query);
				}
			});
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('aiAssistant.clear', () => {
			aiAssistantProvider.clearConversation();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('aiAssistant.toggleLanguage', () => {
			aiAssistantProvider.toggleLanguage();
		})
	);

	// Test command to verify file writing
	context.subscriptions.push(
		vscode.commands.registerCommand('aiAssistant.testFileWrite', async () => {
			try {
				const utils = aiAssistantProvider.getAgentUtils();
				await utils.writeFile('test_file.txt', 'This is a test file to verify writing capabilities.');
				vscode.window.showInformationMessage('Test file created successfully!');
			} catch (error) {
				vscode.window.showErrorMessage(`Error creating test file: ${error instanceof Error ? error.message : String(error)}`);
			}
		})
	);

	// Create a status bar item to indicate when AI Assistant is ready
	const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	statusBarItem.text = "$(zap) AI";
	statusBarItem.tooltip = "AI Assistant (Ctrl+L to activate)";
	statusBarItem.command = "aiAssistant.showView";
	statusBarItem.show();
	context.subscriptions.push(statusBarItem);

	// Register command to show the AI Assistant view
	context.subscriptions.push(
		vscode.commands.registerCommand('aiAssistant.showView', async () => {
			try {
				// First try to focus the view directly
				await vscode.commands.executeCommand('aiAssistantView.focus');
			} catch (error) {
				console.error('Error focusing AI Assistant view:', error);

				// If that fails, try to show the view container first
				try {
					await vscode.commands.executeCommand('workbench.view.extension.ai-assistant-view');

					// Then try to focus the view again
					setTimeout(async () => {
						try {
							await vscode.commands.executeCommand('aiAssistantView.focus');
						} catch (focusError) {
							console.error('Error focusing view after showing container:', focusError);
						}
					}, 100);
				} catch (fallbackError) {
					console.error('Fallback also failed:', fallbackError);
					vscode.window.showErrorMessage('Failed to open AI Assistant view.');
				}
			}
		})
	);

	// Ensure the view provider is activated immediately
	vscode.commands.executeCommand('setContext', 'aiAssistantViewEnabled', true);

	// Force activation of the view after a short delay
	setTimeout(() => {
		try {
			vscode.commands.executeCommand('workbench.view.extension.ai-assistant-view');
		} catch (error) {
			console.error('Failed to show AI Assistant view on startup:', error);
		}
	}, 1000);
}

export function deactivate() { }
