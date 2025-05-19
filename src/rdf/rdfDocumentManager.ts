// src/rdf/rdfDocumentManager.ts
import * as vscode from 'vscode';
import { RdfDocumentContext, RdfDiagnostic } from './rdfDocumentContext';

export class RdfDocumentManager implements vscode.Disposable {
    private documents: Map<string, RdfDocumentContext> = new Map();
    private diagnosticCollection: vscode.DiagnosticCollection;
    private readonly supportedLanguages = ['turtle', 'jsonld', 'rdf', 'n3', 'nt', 'shacl']; // Add more as needed

    constructor() {
        this.diagnosticCollection = vscode.languages.createDiagnosticCollection('rdf');

        // Handle already open documents
        vscode.workspace.textDocuments.forEach(doc => this.handleDocumentOpen(doc));

        // Listen to document events
        vscode.workspace.onDidOpenTextDocument(this.handleDocumentOpen, this,);
        vscode.workspace.onDidChangeTextDocument(this.handleDocumentChange, this,);
        vscode.workspace.onDidCloseTextDocument(this.handleDocumentClose, this,);
    }

    private isSupportedLanguage(languageId: string): boolean {
        return this.supportedLanguages.includes(languageId);
    }

    private handleDocumentOpen(document: vscode.TextDocument): void {
        if (!this.isSupportedLanguage(document.languageId) || this.documents.has(document.uri.toString())) {
            return;
        }
        const context = new RdfDocumentContext(document);
        this.documents.set(document.uri.toString(), context);
        this.updateDiagnostics(document.uri, context.diagnostics);
    }

    private handleDocumentChange(event: vscode.TextDocumentChangeEvent): void {
        const document = event.document;
        if (!this.isSupportedLanguage(document.languageId)) {
            return;
        }
        let context = this.documents.get(document.uri.toString());
        if (!context) {
            // Should have been opened, but handle defensively
            context = new RdfDocumentContext(document);
            this.documents.set(document.uri.toString(), context);
        } else {
            context.update(document);
        }
        this.updateDiagnostics(document.uri, context.diagnostics);
    }

    private handleDocumentClose(document: vscode.TextDocument): void {
        if (this.documents.has(document.uri.toString())) {
            this.documents.delete(document.uri.toString());
            this.diagnosticCollection.delete(document.uri);
        }
    }

    public getDocumentContext(uri: vscode.Uri): RdfDocumentContext | undefined {
        return this.documents.get(uri.toString());
    }

    private updateDiagnostics(uri: vscode.Uri, diagnostics: readonly RdfDiagnostic[]): void {
        this.diagnosticCollection.set(uri, diagnostics);
    }

    public dispose(): void {
        this.diagnosticCollection.dispose();
        this.documents.clear();
    }
}