import * as vscode from 'vscode';
import { Store as N3Store, Parser as N3Parser, Quad, NamedNode, Literal, BlankNode, Term } from 'n3';
import { DataFactory } from 'n3';

export interface RdfDiagnostic extends vscode.Diagnostic {
    isParserError?: boolean;
}

export class RdfDocumentContext {
    private _uri: vscode.Uri;
    private _content: string;
    private _store: N3Store;
    private _prefixes: { [key: string]: string } = {};
    private _diagnostics: RdfDiagnostic[] = [];
    private _isValid: boolean = true; // Initially assume valid until parsed

    constructor(document: vscode.TextDocument) {
        this._uri = document.uri;
        this._content = document.getText();
        this._store = new N3Store();
        this.parseDocument();
    }

    public get uri(): vscode.Uri {
        return this._uri;
    }

    public get store(): N3Store {
        return this._store;
    }

    public get prefixes(): { [key: string]: string } {
        return this._prefixes;
    }

    public get diagnostics(): ReadonlyArray<RdfDiagnostic> {
        return this._diagnostics;
    }

    public get isValid(): boolean {
        return this._isValid;
    }

    public update(document: vscode.TextDocument) {
        this._content = document.getText();
        this._uri = document.uri; // In case the document object itself changed
        this.parseDocument();
    }

    private parseDocument(): void {
        this._store = new N3Store(); // Clear previous quads
        this._diagnostics = [];
        this._prefixes = {};
        this._isValid = true;

        const parser = new N3Parser({ baseIRI: this._uri.toString() });

        try {
            parser.parse(this._content, (error, quad, prefixes) => {
                if (error) {
                    this._isValid = false;
                    // Try to extract line/column information if available in the error
                    // N3.js errors often have a context object with line info
                    let range = new vscode.Range(0, 0, 0, 0); // Default range
                    const errorContext = (error as any).context;
                    if (errorContext && typeof errorContext.line === 'number') {
                        // N3 parser lines are 1-based, VS Code lines are 0-based
                        const line = errorContext.line - 1;
                        // Attempt to make a sensible range. Column info might not be precise.
                        // For now, highlight the whole line or a small part of it.
                        const lineText = this._content.split(/\r?\n/)[line] || '';
                        const startChar = 0; // Could try to find a better start char
                        const endChar = lineText.length > 0 ? lineText.length : 1;
                        range = new vscode.Range(line, startChar, line, endChar);
                    }

                    this._diagnostics.push({
                        message: error.message,
                        range: range,
                        severity: vscode.DiagnosticSeverity.Error,
                        source: 'RDF Parser (N3)',
                        isParserError: true,
                    });
                } else if (quad) {
                    this._store.addQuad(quad);
                } else { // End of parsing
                    if (prefixes) {
                        // N3.js v1.17+ prefixes argument in the final callback is an object.
                        // For older versions, it might be continuously updated.
                        // We'll assume the final one is comprehensive.
                        for (const prefix in prefixes) {
                            this._prefixes[prefix] = (prefixes as any)[prefix].value || (prefixes as any)[prefix];
                        }
                    }
                    // Perform additional linting/checks if no parser errors
                    if (this._isValid) {
                        this.performLinting();
                    }
                }
            });
        } catch (e: any) {
            // Catch synchronous errors from parser.parse (though less common for N3.js)
            this._isValid = false;
            this._diagnostics.push({
                message: e.message,
                range: new vscode.Range(0, 0, 0, 1), // Default for unexpected errors
                severity: vscode.DiagnosticSeverity.Error,
                source: 'RDF Parser (N3)',
                isParserError: true,
            });
        }
    }

    private performLinting(): void {
        // Example: Check for unused prefixes (requires more sophisticated tracking during parsing or post-parsing analysis)
        // For now, this is a placeholder.
        // This could be extended for OWL/RDFS specific checks later.

        // Example: Validate namespace IRI formats (very basic)
        for (const prefix in this._prefixes) {
            const iri = this._prefixes[prefix];
            if (!iri.endsWith('#') && !iri.endsWith('/')) {
                // This is a stylistic warning, not strictly an error.
                // Finding the range for prefix declaration would require more detailed parsing.
                // For now, we'll create a document-level warning or skip if range is hard.
                // To make this useful, we'd need to store the range of the @prefix directive.
                // console.log(`Warning: Prefix ${prefix}: <${iri}> might not be a standard namespace IRI.`);
            }
        }
    }

    public getQuads(subject?: Term, predicate?: Term, object?: Term, graph?: Term): Quad[] {
        return this._store.getQuads(
            subject as NamedNode | BlankNode | null,
            predicate as NamedNode | null,
            object as NamedNode | Literal | BlankNode | null,
            graph as NamedNode | null
        );
    }
}