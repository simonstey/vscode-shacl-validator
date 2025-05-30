// src/webview/validationResultsViewProvider.ts
import * as vscode from "vscode";
import { HighlightingService } from "../highlighting/highlightingService";
import { RdfDocumentManager } from "../rdf/rdfDocumentManager";
import { Term } from "n3"; // Assuming Term is exported from n3 or @rdfjs/types

// Define the structure of the validation report data for the webview
export interface WebviewValidationReport {
    conforms: boolean;
    results: WebviewValidationResult[];
    dataDocumentUri: string;
    shapesDocumentUri: string;
    rawReportTurtle?: string; // Added for raw report
}

export interface WebviewValidationResult {
    message: string[]; // Assuming message can be an array of strings
    path?: string;
    focusNode?: { value: string; termType: string };
    severity?: { value: string; termType: string };
    sourceConstraintComponent?: { value: string; termType: string };
    sourceShape?: { value: string; termType: string };
    value?: {
        value: string;
        termType: string;
        language?: string;
        datatype?: { value: string; termType: string };
    };
}

export class ValidationResultsViewProvider implements vscode.Disposable {
    public static readonly viewType = "shaclValidationResults";
    private _panel: vscode.WebviewPanel | undefined;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];

    private _highlightingService: HighlightingService;
    private _rdfDocumentManager: RdfDocumentManager; // To help find terms
    private _rawReportTurtle?: string; // Store the raw report

    constructor(
        extensionUri: vscode.Uri,
        highlightingService: HighlightingService,
        rdfDocumentManager: RdfDocumentManager
    ) {
        this._extensionUri = extensionUri;
        this._highlightingService = highlightingService;
        this._rdfDocumentManager = rdfDocumentManager;
    }
    public showResults(report: WebviewValidationReport) {
        // Always show results in column three for side-by-side view
        const column = vscode.ViewColumn.Three;

        this._rawReportTurtle = report.rawReportTurtle; // Store the raw report

        if (this._panel) {
            this._panel.reveal(column);
        } else {
            this._panel = vscode.window.createWebviewPanel(
                ValidationResultsViewProvider.viewType,
                "SHACL Validation Results",
                column,
                {
                    enableScripts: true,
                    localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, "media")],
                    retainContextWhenHidden: true,
                }
            );

            this._panel.onDidDispose(() => this.disposePanel(), null, this._disposables);
            this._panel.webview.onDidReceiveMessage(
                async (message) => {
                    switch (message.command) {
                        case "jumpToLocation":
                            await this.handleJumpToLocation(message.targetUri, message.termString, message.termType);
                            return;
                        case "alert":
                            vscode.window.showInformationMessage(message.text);
                            return;
                        case "showRawReport": // New message handler
                            if (this._rawReportTurtle) {
                                try {
                                    const doc = await vscode.workspace.openTextDocument({
                                        content: this._rawReportTurtle,
                                        language: "turtle",
                                    });
                                    await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
                                } catch (e: any) {
                                    vscode.window.showErrorMessage(`Error showing raw report: ${e.message}`);
                                    console.error("Error opening raw report document:", e);
                                }
                            } else {
                                vscode.window.showInformationMessage("No raw report available to show.");
                            }
                            return;
                    }
                },
                null,
                this._disposables
            );
        }

        this._panel.webview.html = this._getHtmlForWebview(this._panel.webview, report);
        this._panel.webview.postMessage({
            command: "showReport",
            report: report,
        });
    }

    private async handleJumpToLocation(targetUriString: string, termString: string, termType: string) {
        if (!termString) {
            vscode.window.showWarningMessage("No term provided to jump to.");
            return;
        }
        try {
            const targetUri = vscode.Uri.parse(targetUriString);
            let editor: vscode.TextEditor;

            // Check if the document is already visible in an editor
            const visibleEditor = vscode.window.visibleTextEditors.find(
                (e) => e.document.uri.toString() === targetUri.toString()
            );

            if (visibleEditor) {
                // Document is already visible. Ensure it's the active editor in its group.
                editor = await vscode.window.showTextDocument(visibleEditor.document, {
                    viewColumn: visibleEditor.viewColumn, // Preserve its current column
                    preview: false,
                    preserveFocus: false, // Allow focus to move to the editor
                });
            } else {
                // Document is not visible. Open it (or reveal if open but not visible) in ViewColumn.One.
                const documentToOpen = await vscode.workspace.openTextDocument(targetUri);
                editor = await vscode.window.showTextDocument(documentToOpen, {
                    preview: false,
                    viewColumn: vscode.ViewColumn.One, // Default to ViewColumn.One
                    preserveFocus: false,
                });
            }

            const document = editor.document; // Get document from the resolved editor
            const text = document.getText();

            const rdfContext = this._rdfDocumentManager.getDocumentContext(targetUri);
            const prefixes = rdfContext?.prefixes || {};

            const searchPatterns: string[] = [];

            // 1. Original term string
            searchPatterns.push(termString);

            // 2. Term as full IRI (if it's a NamedNode and not already wrapped)
            if (termType === "NamedNode" && !termString.startsWith("<") && !termString.endsWith(">")) {
                searchPatterns.push(`<${termString}>`);
            }
            // 3. Term without < > (if it was wrapped)
            if (termType === "NamedNode" && termString.startsWith("<") && termString.endsWith(">")) {
                searchPatterns.push(termString.substring(1, termString.length - 1));
            }

            // 4. Prefixed names
            if (termType === "NamedNode") {
                for (const [prefix, uri] of Object.entries(prefixes)) {
                    if (termString.startsWith(uri as string)) {
                        searchPatterns.push(`${prefix}:${termString.substring((uri as string).length)}`);
                    }
                }
            }

            // 5. Local name (if IRI)
            if (termType === "NamedNode") {
                let localName = "";
                if (termString.includes("#")) {
                    localName = termString.substring(termString.lastIndexOf("#") + 1);
                } else if (termString.includes("/")) {
                    localName = termString.substring(termString.lastIndexOf("/") + 1);
                }
                // Ensure localName is not an empty string and not already added (e.g. if termString was already just the localName)
                if (localName && localName !== termString && !localName.startsWith("<") && !localName.endsWith(">")) {
                    searchPatterns.push(localName);
                }
            }

            // Remove duplicates and empty strings, and ensure patterns are valid
            const uniqueSearchPatterns = [...new Set(searchPatterns)].filter((p) => p && p.trim() !== "");

            let bestMatch: { range: vscode.Range; pattern: string } | undefined;

            for (const pattern of uniqueSearchPatterns) {
                try {
                    let escapedPattern = pattern.replace(/[-\[\]{}()*+?.,\\^$|#\s]/g, "\\$&");
                    if (pattern.startsWith("<") && pattern.endsWith(">")) {
                        const inner = pattern.substring(1, pattern.length - 1);
                        escapedPattern = `<${inner.replace(/[-\[\]{}()*+?.,\\^$|#\s]/g, "\\$&")}>`;
                    } else {
                        escapedPattern = pattern.replace(/[-\[\]{}()*+?.,\\^$|#\s]/g, "\\$&");
                    }

                    const regex = new RegExp(`(?<=^|\\s|[("'<])${escapedPattern}(?=$|\\s|[)"'>.,;])`, "gm");
                    let match;
                    while ((match = regex.exec(text)) !== null) {
                        const startPos = document.positionAt(match.index);
                        const endPos = document.positionAt(match.index + match[0].length);
                        const range = new vscode.Range(startPos, endPos);

                        if (!bestMatch || pattern === termString || pattern === `<${termString}>`) {
                            bestMatch = { range, pattern };
                            if (pattern === termString || pattern === `<${termString}>`) {
                                break; // Exact match found, prioritize
                            }
                        }
                    }
                    if (bestMatch && (bestMatch.pattern === termString || bestMatch.pattern === `<${termString}>`)) {
                        break;
                    }
                } catch (regexError) {
                    console.error(`Error with regex for pattern '${pattern}':`, regexError);
                }
            }

            if (bestMatch) {
                editor.selection = new vscode.Selection(bestMatch.range.start, bestMatch.range.end);
                editor.revealRange(bestMatch.range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
                this._highlightingService.clearHighlights(editor);
                this._highlightingService.highlightRange(editor, bestMatch.range);

                setTimeout(() => {
                    if (vscode.window.visibleTextEditors.includes(editor)) {
                        this._highlightingService.clearHighlights(editor);
                    }
                }, 5000);
            } else {
                vscode.window.showWarningMessage(
                    `Could not find '${termString}' in ${targetUri.fsPath}. Tried patterns: ${uniqueSearchPatterns.join(
                        ", "
                    )}`
                );
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
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, "media", "webview.js"));
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, "media", "webview.css"));
        const nonce = getNonce(); // Security practice

        // Determine if the raw report button should be potentially visible
        // The actual display:none will be handled by webview.js based on content
        const rawReportButtonHtml = `
            <button id="showRawReportBtn" style="display:none; margin-top: 10px; padding: 8px 12px; cursor: pointer; border: 1px solid var(--vscode-button-border, #ccc); background-color: var(--vscode-button-background, #007acc); color: var(--vscode-button-foreground, #fff); border-radius: 4px;">
                View Raw Report (Turtle)
            </button>`;

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
            ${rawReportButtonHtml}
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
    let text = "";
    const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
