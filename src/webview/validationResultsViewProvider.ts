// src/webview/validationResultsViewProvider.ts
import * as vscode from 'vscode';
import { HighlightingService } from '../highlighting/highlightingService';
import { RdfDocumentManager } from '../rdf/rdfDocumentManager';
import { Term } from 'n3'; // Assuming Term is exported from n3 or @rdfjs/types

// Define the structure of the validation report data for the webview
export interface WebviewValidationReport {
    conforms: boolean;
    results: WebviewValidationResult[];
    dataDocumentUri: string;
    shapesDocumentUri: string;
}

export interface WebviewValidationResult {
    message: string[]; // Assuming message can be an array of strings
    path?: string;
    focusNode?: { value: string; termType: string };
    severity?: { value: string; termType: string };
    sourceConstraintComponent?: { value: string; termType: string };
    sourceShape?: { value: string; termType: string };
    value?: { value: string; termType: string; language?: string; datatype?: { value: string; termType: string } };
}

export class ValidationResultsViewProvider implements vscode.Disposable {
    public static readonly viewType = 'shaclValidationResults';
    private _panel: vscode.WebviewPanel | undefined;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];

    private _highlightingService: HighlightingService;
    private _rdfDocumentManager: RdfDocumentManager; // To help find terms

    constructor(
        extensionUri: vscode.Uri,
        highlightingService: HighlightingService,
        rdfDocumentManager: RdfDocumentManager
    ) {
        this._extensionUri = extensionUri;
        this._highlightingService = highlightingService;
        this._rdfDocumentManager = rdfDocumentManager;
    } public showResults(report: WebviewValidationReport) {
        // Always show results in column three for side-by-side view
        const column = vscode.ViewColumn.Three;

        if (this._panel) {
            this._panel.reveal(column);
        } else {
            this._panel = vscode.window.createWebviewPanel(
                ValidationResultsViewProvider.viewType,
                'SHACL Validation Results',
                column,
                {
                    enableScripts: true,
                    localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'media')],
                    retainContextWhenHidden: true,
                }
            );

            this._panel.onDidDispose(() => this.disposePanel(), null, this._disposables);
            this._panel.webview.onDidReceiveMessage(
                async (message) => {
                    switch (message.command) {
                        case 'jumpToLocation':
                            await this.handleJumpToLocation(
                                message.targetUri,
                                message.termString,
                                message.termType
                            );
                            return;
                        case 'alert':
                            vscode.window.showInformationMessage(message.text);
                            return;
                    }
                },
                null,
                this._disposables
            );
        }

        this._panel.webview.html = this._getHtmlForWebview(this._panel.webview, report);
        this._panel.webview.postMessage({ command: 'showReport', report: report });
    }

    private async handleJumpToLocation(targetUriString: string, termString: string, termType: string) {
        if (!termString) {
            vscode.window.showWarningMessage("No term provided to jump to.");
            return;
        }
        try {
            const targetUri = vscode.Uri.parse(targetUriString);
            const document = await vscode.workspace.openTextDocument(targetUri);
            const editor = await vscode.window.showTextDocument(document, { preview: false, viewColumn: vscode.ViewColumn.One });

            // Simple string search for the term.
            // This is a basic implementation. More advanced would involve AST/CST parsing.
            const text = document.getText();
            let searchTerm = termString;

            // Adjust search term based on type for better matching (heuristic)
            if (termType === 'NamedNode' && !termString.startsWith('<')) {
                searchTerm = `<${termString}>`; // e.g. http://... becomes <http://...>
            } else if (termType === 'Literal' && !termString.startsWith('"')) {
                // Heuristic: if it's a literal without quotes, it might be just the value part
                // This part is tricky because the termString from SHACL report might be just the lexical form
            }


            let matchIndex = -1;
            let retries = 0;
            const maxRetries = 2; // Try original, then potentially modified searchTerm

            while (matchIndex === -1 && retries <= maxRetries) {
                if (retries === 1 && termType === 'NamedNode' && termString.startsWith('<') && termString.endsWith('>')) {
                    // If it was already <...>, try without <>
                    searchTerm = termString.substring(1, termString.length - 1);
                } else if (retries === 2 && termType === 'NamedNode' && !termString.startsWith('<')) {
                    // If original didn't have <>, try with < > if not already tried
                    searchTerm = `<${termString}>`;
                } else if (retries > 0 && termType !== 'NamedNode') {
                    break; // Only retry for NamedNodes with this logic for now
                }


                matchIndex = text.indexOf(searchTerm);
                if (matchIndex === -1 && searchTerm.includes(':') && !searchTerm.startsWith('<')) {
                    // Try finding prefixed names (e.g., ex:Class) if full IRI search failed
                    // This is also a heuristic
                    const parts = searchTerm.split(':');
                    if (parts.length === 2) {
                        // Try finding the local name part only
                        matchIndex = text.indexOf(parts[1]);
                    }
                }
                retries++;
            }


            if (matchIndex !== -1) {
                const startPos = document.positionAt(matchIndex);
                const endPos = document.positionAt(matchIndex + searchTerm.length);
                const range = new vscode.Range(startPos, endPos);

                editor.selection = new vscode.Selection(range.start, range.end);
                editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
                this._highlightingService.clearHighlights(editor); // Clear previous before applying new
                this._highlightingService.highlightRange(editor, range);

                // Set a timeout to clear the highlight after a few seconds
                setTimeout(() => {
                    // Check if the editor is still visible and the decoration is still active for this range
                    if (vscode.window.visibleTextEditors.includes(editor)) {
                        // This direct clear might be too aggressive if user triggered other highlights.
                        // A more robust way would be to track specific jump highlights.
                        // For now, let's just clear all from this editor for simplicity of the example.
                        this._highlightingService.clearHighlights(editor);
                    }
                }, 5000); // Highlight for 5 seconds

            } else {
                vscode.window.showWarningMessage(`Could not find '${termString}' in ${targetUri.fsPath}.`);
            }

        } catch (e: any) {
            vscode.window.showErrorMessage(`Error jumping to location: ${e.message}`);
            console.error(e);
        }
    }


    private disposePanel() {
        this._panel = undefined;
        // Dispose disposables specific to the panel if any were added to this._disposables
        // that aren't managed by the panel itself.
    }

    public dispose() {
        this.disposePanel();
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }

    private _getHtmlForWebview(webview: vscode.Webview, report?: WebviewValidationReport): string {
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'webview.js'));
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'webview.css'));
        const nonce = getNonce(); // Security practice

        return `<!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} data:; script-src 'nonce-${nonce}';">
        <link href="${styleUri}" rel="stylesheet">
        <title>SHACL Validation Results</title>
      </head>
      <body>
        <h1>SHACL Validation Report</h1>
        <div id="summary">
            <p>Conforms: <span id="conformsStatus"></span></p>
            <p>Data File: <span id="dataFile"></span></p>
            <p>Shapes File: <span id="shapesFile"></span></p>
        </div>
        
        <div id="resultsTableContainer">
          <table id="resultsTable">
            <thead>
              <tr>
                <th>#</th>
                <th>Message</th>
                <th>Severity</th>
                <th>Focus Node</th>
                <th>Source Shape</th>
                <th>Path</th>
                <th>Constraint</th>
                <th>Value</th>
              </tr>
            </thead>
            <tbody>
              <!-- Rows will be injected by script -->
            </tbody>
          </table>
          <p id="noViolationsMsg" style="display:none;">No violations found. The data conforms to the shapes.</p>
        </div>

        <script nonce="${nonce}" src="${scriptUri}"></script>
      </body>
      </html>`;
    }
}

function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}