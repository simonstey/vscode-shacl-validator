// src/highlighting/highlightingService.ts
import * as vscode from 'vscode';

export class HighlightingService {
    private highlightDecorationType: vscode.TextEditorDecorationType;
    private activeDecorations: Map<string, vscode.Range[]> = new Map(); // Store by editor URI

    constructor() {
        this.highlightDecorationType = vscode.window.createTextEditorDecorationType({
            backgroundColor: new vscode.ThemeColor('editor.selectionHighlightBackground'), // Default, can be customized
            // You can add other styles like border, etc.
            // Example from estruyf/vscode-demo-time uses more complex styling via webview for animation.
            // For editor-only highlight, direct decoration styling is used.
            isWholeLine: false,
        });

        // Listen to editor changes to clear decorations if an editor is closed
        vscode.window.onDidChangeVisibleTextEditors(editors => {
            const visibleEditorUris = new Set(editors.map(e => e.document.uri.toString()));
            for (const editorUri of this.activeDecorations.keys()) {
                if (!visibleEditorUris.has(editorUri)) {
                    this.activeDecorations.delete(editorUri);
                }
            }
        });
    }

    public updateHighlightColor() {
        const config = vscode.workspace.getConfiguration('shaclValidator.highlighting');
        const color = config.get<string>('color');

        this.highlightDecorationType.dispose(); // Dispose of the old one
        this.highlightDecorationType = vscode.window.createTextEditorDecorationType({
            backgroundColor: color || new vscode.ThemeColor('editor.selectionHighlightBackground'),
            isWholeLine: false,
        });

        // Reapply decorations in visible editors
        vscode.window.visibleTextEditors.forEach(editor => {
            const uriString = editor.document.uri.toString();
            if (this.activeDecorations.has(uriString)) {
                editor.setDecorations(this.highlightDecorationType, this.activeDecorations.get(uriString) || []);
            }
        });
    }


    public highlightRange(editor: vscode.TextEditor, range: vscode.Range) {
        const uriString = editor.document.uri.toString();
        const ranges = this.activeDecorations.get(uriString) || [];
        ranges.push(range);
        this.activeDecorations.set(uriString, ranges);
        editor.setDecorations(this.highlightDecorationType, ranges);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }

    public highlightSelection(editor?: vscode.TextEditor) {
        const targetEditor = editor || vscode.window.activeTextEditor;
        if (!targetEditor || targetEditor.selection.isEmpty) {
            vscode.window.showInformationMessage("No selection to highlight.");
            return;
        }
        this.highlightRange(targetEditor, targetEditor.selection);
    }

    public clearHighlights(editor?: vscode.TextEditor) {
        if (editor) {
            const uriString = editor.document.uri.toString();
            editor.setDecorations(this.highlightDecorationType, []);
            this.activeDecorations.delete(uriString);
        } else {
            // Clear from all visible editors
            vscode.window.visibleTextEditors.forEach(e => {
                e.setDecorations(this.highlightDecorationType, []);
            });
            this.activeDecorations.clear();
        }
        vscode.window.showInformationMessage("Highlights cleared.");
    }

    public dispose() {
        this.highlightDecorationType.dispose();
        this.activeDecorations.clear();
    }
}