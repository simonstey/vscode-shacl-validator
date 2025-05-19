// src/shacl/shaclValidatorService.ts
import * as vscode from "vscode";
import { Parser as N3Parser, Store as N3Store, DataFactory, Term } from "n3";
import SHACLValidator from "rdf-validate-shacl";
import { DatasetCore, BlankNode, Literal, NamedNode } from "@rdfjs/types";
import type { DatasetCoreFactory } from "@rdfjs/types/dataset";
import * as fs from "fs";
import * as path from "path";
import * as N3 from "n3";
import { ValidationResultsViewProvider, WebviewValidationReport, WebviewValidationResult } from "../webview/validationResultsViewProvider";
import { RdfDocumentManager } from "../rdf/rdfDocumentManager";
const { literal, defaultGraph } = DataFactory; // namedNode is not used directly here, DataFactory has it
import { SessionManagerService } from '../sessions/sessionManagerService'; // Import

// async function loadRdfFileAsDataset(filePath: string) {
//     const fileContent = await fs.promises.readFile(filePath, "utf-8");

//     // Attempt to determine file type for baseIRI, or use a generic one.
//     // For file:// URLs, the path itself is often sufficient for baseIRI resolution by parsers.
//     const baseIRI = `file://${filePath.replace(/\\/g, "/")}`;
//     const dataParser = new N3Parser({ baseIRI });

//     // const dataParser = new N3.Parser({ baseIRI: "" });
//     const dataQuads = dataParser.parse(fileContent);
//     const dataStore = new N3.Store();
//     dataStore.addQuads(dataQuads);
//     return dataStore;
//     // return new Promise((resolve, reject) => {
//     //     parser.parse(fileContent, (error, quad, prefixes) => {
//     //         if (error) {
//     //             reject(new Error(`Error parsing ${filePath}: ${error.message}`));
//     //         } else if (quad) {
//     //             store.addQuad(quad);
//     //         } else {
//     //             resolve(store);
//     //         }
//     //     });
//     // });
// }

// async function loadRdfTextAsDataset(
//     text: string,
//     baseDocumentPath?: string
// ): Promise<DatasetCore> {
//     const store = new N3Store();
//     const baseIRI = baseDocumentPath
//         ? `file://${baseDocumentPath.replace(/\\/g, "/")}`
//         : undefined;
//     const parser = new N3Parser({ baseIRI });

//     return new Promise((resolve, reject) => {
//         parser.parse(text, (error, quad, prefixes) => {
//             if (error) {
//                 reject(new Error(`Error parsing RDF text: ${error.message}`));
//             } else if (quad) {
//                 store.addQuad(quad);
//             } else {
//                 resolve(store);
//             }
//         });
//     });
// }


// Helper to convert N3.Term to a simpler structure for the webview
function convertTermForWebview(term: Term | null | undefined): { value: string; termType: string; language?: string; datatype?: { value: string; termType: string } } | undefined {
    if (!term) { return undefined; };
    const base = { value: term.value, termType: term.termType };
    if (term.termType === 'Literal') {
        return {
            ...base,
            language: term.language || undefined,
            datatype: term.datatype ? { value: term.datatype.value, termType: term.datatype.termType } : undefined
        };
    }
    return base;
}


export class ShaclValidationService {
    private outputChannel: vscode.OutputChannel;
    private validationResultsViewProvider: ValidationResultsViewProvider;
    private rdfDocumentManager: RdfDocumentManager;
    private sessionManagerService: SessionManagerService; // NEW

    constructor(
        viewProvider: ValidationResultsViewProvider,
        rdfDocumentManager: RdfDocumentManager,
        sessionManagerService: SessionManagerService // NEW
    ) {
        this.outputChannel = vscode.window.createOutputChannel("SHACL Validation");
        this.validationResultsViewProvider = viewProvider;
        this.rdfDocumentManager = rdfDocumentManager;
        this.sessionManagerService = sessionManagerService; // Store it
    }

    public async validateActiveDocument() {
        // This command might become less primary, or could create a temporary session
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage("No active document to validate.");
            return;
        }
        // For now, let it run without a session context, or you could prompt to create one.
        await this.validateDocument(editor.document.uri);
    }


    public async validateDocument(
        dataDocumentUri: vscode.Uri,
        shapesGraphUriToUse?: vscode.Uri, // Optional, used by session runner
        sessionId?: string // Optional, to update the session report
    ) {
        // ... (existing setup and output channel logging)
        this.outputChannel.clear();
        this.outputChannel.show(true);
        this.outputChannel.appendLine(
            `Starting SHACL validation for: ${dataDocumentUri.fsPath}`
        );

        let shapesFileUri: vscode.Uri | undefined = shapesGraphUriToUse;// Keep track of shapes file URI

        try {            // Open data document in column one, checking if it's already open
            let dataEditor: vscode.TextEditor | undefined;

            for (const editor of vscode.window.visibleTextEditors) {
                if (editor.document.uri.toString() === dataDocumentUri.toString()) {
                    dataEditor = editor;
                    break;
                }
            }

            if (!dataEditor) {
                // Not open, show it in column one
                const dataDocument = await vscode.workspace.openTextDocument(dataDocumentUri);
                await vscode.window.showTextDocument(dataDocument, vscode.ViewColumn.One);
            } else {
                // Already open, show it in its current column
                await vscode.window.showTextDocument(dataEditor.document, dataEditor.viewColumn);
            }
            const dataContext = this.rdfDocumentManager.getDocumentContext(dataDocumentUri);
            if (!dataContext || !dataContext.isValid) {
                // ... error handling ...
                const errorReport: WebviewValidationReport = {
                    conforms: false,
                    results: dataContext?.diagnostics.filter(d => d.isParserError).map(d => ({
                        message: [d.message],
                        severity: { value: 'Error (Parser)', termType: 'Literal' },
                        focusNode: { value: `Line ${d.range.start.line + 1}`, termType: 'Literal' }, // Simplistic focus node for parser errors
                    })) || [{ message: ["Could not parse data document."] }],
                    dataDocumentUri: dataDocumentUri.toString(),
                    shapesDocumentUri: shapesFileUri !== undefined ? shapesFileUri.toString() : "" // Could be undefined if not chosen yet
                };
                this.validationResultsViewProvider.showResults(errorReport);
                if (sessionId && shapesFileUri) { // Check shapesFileUri is defined
                    this.sessionManagerService.updateSessionReport(sessionId, errorReport);
                }
                return;
            }
            const dataGraph = dataContext.store; if (!shapesFileUri) { // If not provided by session, prompt
                shapesFileUri = await this.promptForShapesFile(dataDocumentUri);
                if (!shapesFileUri) {
                    this.outputChannel.appendLine("SHACL validation cancelled: No shapes file selected.");
                    vscode.window.showInformationMessage("SHACL validation cancelled.");
                    return;
                }
            }
            this.outputChannel.appendLine(`Using shapes file: ${shapesFileUri.fsPath}`);

            // Open shapes document in column two, checking if it's already open
            let shapesEditor: vscode.TextEditor | undefined;

            for (const editor of vscode.window.visibleTextEditors) {
                if (editor.document.uri.toString() === shapesFileUri.toString()) {
                    shapesEditor = editor;
                    break;
                }
            }

            if (!shapesEditor) {
                // Not open, show it in column two
                const shapesDoc = await vscode.workspace.openTextDocument(shapesFileUri);
                await vscode.window.showTextDocument(shapesDoc, vscode.ViewColumn.Two);
            } else {
                // Already open, show it in its current column
                await vscode.window.showTextDocument(shapesEditor.document, shapesEditor.viewColumn);
            }

            // ... (shapes graph loading using RdfDocumentManager, context check remains similar) ...
            const shapesContext = this.rdfDocumentManager.getDocumentContext(shapesFileUri);
            if (!shapesContext || !shapesContext.isValid) {
                // ... error handling ...
                const errorReport: WebviewValidationReport = {
                    conforms: false,
                    results: shapesContext?.diagnostics.filter(d => d.isParserError).map(d => ({
                        message: [d.message],
                        severity: { value: 'Error (Parser)', termType: 'Literal' },
                        focusNode: { value: `Line ${d.range.start.line + 1}`, termType: 'Literal' },
                    })) || [{ message: ["Could not parse shapes document."] }],
                    dataDocumentUri: dataDocumentUri.toString(),
                    shapesDocumentUri: shapesFileUri.toString()
                };
                this.validationResultsViewProvider.showResults(errorReport);
                if (sessionId) {
                    this.sessionManagerService.updateSessionReport(sessionId, errorReport);
                }
                return;
            }
            const shapesGraph = shapesContext.store;


            this.outputChannel.appendLine("Initializing SHACL validator...");
            const validator = new SHACLValidator(shapesGraph, {});
            this.outputChannel.appendLine("Performing validation...");
            const report = await validator.validate(dataGraph);

            const webviewReport: WebviewValidationReport = {
                conforms: report.conforms,
                dataDocumentUri: dataDocumentUri.toString(),
                shapesDocumentUri: shapesFileUri.toString(), // Ensure shapesFileUri is defined
                results: report.results.map(res => ({
                    // ... (term conversion logic remains the same)
                    message: (
                        res.message === null
                            ? []
                            : Array.isArray(res.message)
                                ? res.message.filter(m => m !== null && typeof m === "object" && "value" in m).map(m => (m as { value: string }).value)
                                : (typeof res.message === "object" && "value" in res.message)
                                    ? [(res.message as { value: string }).value]
                                    : []
                    ),
                    path: this.convertTermForWebview(res.path as Term),
                    focusNode: this.convertTermForWebview(res.focusNode as Term),
                    severity: this.convertTermForWebview(res.severity as Term),
                    sourceConstraintComponent: this.convertTermForWebview(res.sourceConstraintComponent as Term),
                    sourceShape: this.convertTermForWebview(res.sourceShape as Term),
                    value: this.convertTermForWebview(res.value as Term)
                } as WebviewValidationResult)) // Type assertion
            };

            this.validationResultsViewProvider.showResults(webviewReport);
            if (sessionId) {
                this.sessionManagerService.updateSessionReport(sessionId, webviewReport);
            }

            // ... (logging to output channel) ...

        } catch (error: any) {
            // ... (error handling, also update session report with error if sessionId provided) ...
            const errorReport: WebviewValidationReport = {
                conforms: false,
                results: [{ message: [`Validation process error: ${error.message}`] }],
                dataDocumentUri: dataDocumentUri.toString(),
                shapesDocumentUri: shapesFileUri ? shapesFileUri.toString() : "unknown"
            };
            this.validationResultsViewProvider.showResults(errorReport);
            if (sessionId) {
                this.sessionManagerService.updateSessionReport(sessionId, errorReport);
            }
        }
    }

    // Helper to convert N3.Term to a simpler structure for the webview
    // (Make sure this is part of the class or accessible)
    private convertTermForWebview(term: Term | null | undefined): { value: string; termType: string; language?: string; datatype?: { value: string; termType: string } } | undefined {
        if (!term) { return undefined; };
        const base = { value: term.value, termType: term.termType };
        if (term.termType === 'Literal') {
            return {
                ...base,
                language: (term as any).language || undefined, // N3.Literal has language property
                datatype: (term as any).datatype ? { value: (term as any).datatype.value, termType: (term as any).datatype.termType } : undefined
            };
        }
        return base;
    }
    //     try {
    //         const dataDocument = await vscode.workspace.openTextDocument(dataDocumentUri);
    //         const dataContext = this.rdfDocumentManager.getDocumentContext(dataDocumentUri);
    //         // const dataRdf = dataDocument.getText();

    //         shapesFileUri = await this.promptForShapesFile(dataDocumentUri);
    //         if (!shapesFileUri) {
    //             this.outputChannel.appendLine("SHACL validation cancelled: No shapes file selected.");
    //             vscode.window.showInformationMessage("SHACL validation cancelled.");
    //             return;
    //         }
    //         this.outputChannel.appendLine(`Using shapes file: ${shapesFileUri.fsPath}`);

    //         // Ensure shapes file is known to RdfDocumentManager so we can potentially jump to it
    //         // This will parse it and make its context available if not already.
    //         // Normally openTextDocument itself might trigger the manager if the file is within workspace.
    //         // Explicitly ensuring it's processed:
    //         await vscode.workspace.openTextDocument(shapesFileUri); // This will trigger RdfDocumentManager if it's a supported lang.


    //         this.outputChannel.appendLine("Loading data graph...");
    //         // const dataGraph = await loadRdfTextAsDataset(dataRdf, dataDocumentUri.fsPath); // from previous version
    //         const dataContext = this.rdfDocumentManager.getDocumentContext(dataDocumentUri);
    //         if (!dataContext || !dataContext.isValid) {
    //             this.outputChannel.appendLine("Error: Could not get valid RDF context for data document. Please check for parsing errors.");
    //             vscode.window.showErrorMessage("Data document has parsing errors. Cannot validate.");
    //             // Optionally show these errors in the webview too
    //             const errorReport: WebviewValidationReport = {
    //                 conforms: false,
    //                 results: dataContext?.diagnostics.filter(d => d.isParserError).map(d => ({
    //                     message: [d.message],
    //                     severity: { value: 'Error (Parser)', termType: 'Literal' },
    //                     focusNode: { value: `Line ${d.range.start.line + 1}`, termType: 'Literal' }, // Simplistic focus node for parser errors
    //                 })) || [{ message: ["Could not parse data document."] }],
    //                 dataDocumentUri: dataDocumentUri.toString(),
    //                 shapesDocumentUri: shapesFileUri.toString() // Could be undefined if not chosen yet
    //             };
    //             this.validationResultsViewProvider.showResults(errorReport);
    //             if (sessionId && shapesFileUri) { // Check shapesFileUri is defined
    //                 this.sessionManagerService.updateSessionReport(sessionId, errorReport);
    //             }
    //             return;
    //         }
    //         const dataGraph = dataContext.store;


    //         this.outputChannel.appendLine(`Data graph loaded with ${dataGraph.size} quads.`);

    //         this.outputChannel.appendLine("Loading shapes graph...");
    //         // const shapesGraph = await loadRdfFileAsDataset(shapesFileUri.fsPath); // from previous version
    //         const shapesContext = this.rdfDocumentManager.getDocumentContext(shapesFileUri);
    //         if (!shapesContext || !shapesContext.isValid) {
    //             this.outputChannel.appendLine("Error: Could not get valid RDF context for shapes document. Please check for parsing errors.");
    //             vscode.window.showErrorMessage("Shapes document has parsing errors. Cannot validate.");
    //             const errorReport: WebviewValidationReport = {
    //                 conforms: false,
    //                 results: shapesContext?.diagnostics.filter(d => d.isParserError).map(d => ({
    //                     message: [d.message],
    //                     severity: { value: 'Error (Parser)', termType: 'Literal' },
    //                     focusNode: { value: `Line ${d.range.start.line + 1}`, termType: 'Literal' },
    //                 })) || [{ message: ["Could not parse shapes document."] }],
    //                 dataDocumentUri: dataDocumentUri.toString(),
    //                 shapesDocumentUri: shapesFileUri.toString()
    //             };
    //             this.validationResultsViewProvider.showResults(errorReport);
    //             return;
    //         }
    //         const shapesGraph = shapesContext.store;


    //         this.outputChannel.appendLine(`Shapes graph loaded with ${shapesGraph.size} quads.`);

    //         this.outputChannel.appendLine("Initializing SHACL validator...");
    //         const validator = new SHACLValidator(shapesGraph, {});
    //         this.outputChannel.appendLine("Performing validation...");
    //         const report = await validator.validate(dataGraph);

    //         // Prepare report for webview
    //         const webviewReport: WebviewValidationReport = {
    //             conforms: report.conforms,
    //             dataDocumentUri: dataDocumentUri.toString(),
    //             shapesDocumentUri: shapesFileUri.toString(),
    //             results: report.results.map(res => ({
    //                 message: (Array.isArray(res.message) ? res.message.map(m => m.value) : [res.message.value]),
    //                 path: convertTermForWebview(res.path as Term),
    //                 focusNode: convertTermForWebview(res.focusNode as Term),
    //                 severity: convertTermForWebview(res.severity as Term),
    //                 sourceConstraintComponent: convertTermForWebview(res.sourceConstraintComponent as Term),
    //                 sourceShape: convertTermForWebview(res.sourceShape as Term),
    //                 value: convertTermForWebview(res.value as Term)
    //             } as WebviewValidationResult)) // Type assertion
    //         };
    //         this.validationResultsViewProvider.showResults(webviewReport);

    //         // Also log to output channel for consistency/debugging
    //         this.outputChannel.appendLine("\n--- Validation Report (Summary) ---");
    //         this.outputChannel.appendLine(`Conforms: ${report.conforms}`);
    //         if (!report.conforms) {
    //             this.outputChannel.appendLine(`Number of results (violations): ${report.results.length}`);
    //             vscode.window.showWarningMessage(`SHACL validation failed with ${report.results.length} violation(s). See SHACL Results panel.`);
    //             report.results.forEach((result, index) => {
    //                 const messageValues = (Array.isArray(result.message) ? result.message : [result.message])
    //                     .map(m => m?.value || 'No message value')
    //                     .join('; ');
    //                 this.outputChannel.appendLine(`  Violation ${index + 1}: ${messageValues}`);
    //             });
    //         } else {
    //             vscode.window.showInformationMessage("SHACL validation successful: Data conforms to shapes.");
    //         }


    //     } catch (error: any) {
    //         vscode.window.showErrorMessage(`SHACL Validation Error: ${error.message}. Check 'SHACL Validation' output.`);
    //         this.outputChannel.appendLine(`\n--- ERROR ---`);
    //         this.outputChannel.appendLine(error.message);
    //         if (error.stack) {
    //             this.outputChannel.appendLine(error.stack);
    //         }
    //         console.error("SHACL Validation Error:", error);

    //         // Show error in webview too
    //         const errorReport: WebviewValidationReport = {
    //             conforms: false,
    //             results: [{ message: [`Validation process error: ${error.message}`] }],
    //             dataDocumentUri: dataDocumentUri.toString(),
    //             shapesDocumentUri: shapesFileUri ? shapesFileUri.toString() : "unknown"
    //         };
    //         this.validationResultsViewProvider.showResults(errorReport);
    //     }
    // }

    // ... (termToString and promptForShapesFile methods remain the same) ...
    private termToString(term: Term | null | undefined): string {
        if (!term) {
            return "N/A";
        }
        switch (term.termType) {
            case "NamedNode":
                return `<${term.value}>`;
            case "Literal":
                let lit = `"${term.value}"`;
                if ("language" in term && term.language) {
                    lit += `@${term.language}`;
                }
                if ("datatype" in term && term.datatype) {
                    lit += `^^<${term.datatype.value}>`;
                }
                return lit;
            case "BlankNode":
                return `_:${term.value}`;
            case "DefaultGraph":
                return "DefaultGraph";
            default: // Quad, Variable etc.
                return term.value || "Unknown Term";
        }
    }

    private async promptForShapesFile(
        dataDocumentUri: vscode.Uri
    ): Promise<vscode.Uri | undefined> {
        try {
            const doc = await vscode.workspace.openTextDocument(dataDocumentUri);
            const text = doc.getText(
                new vscode.Range(
                    new vscode.Position(0, 0),
                    new vscode.Position(Math.min(doc.lineCount, 10), 0)
                )
            ); // Check first 10 lines
            const shapesCommentRegex = /#\s*shapes:\s*([^\s<>"]+)/i; // Avoid matching IRIs in <>
            const match = text.match(shapesCommentRegex);

            if (match && match[1]) {
                const shapesPath = match[1];
                let absoluteShapesPath: string;
                if (path.isAbsolute(shapesPath)) {
                    absoluteShapesPath = shapesPath;
                } else {
                    const dataDir = path.dirname(dataDocumentUri.fsPath);
                    absoluteShapesPath = path.resolve(dataDir, shapesPath);
                }

                if (fs.existsSync(absoluteShapesPath)) {
                    const choice = await vscode.window.showQuickPick(
                        [
                            {
                                label: `Use detected shapes: ${shapesPath}`,
                                description: absoluteShapesPath,
                                uri: vscode.Uri.file(absoluteShapesPath),
                            },
                            {
                                label: "Select shapes file manually...",
                                description: "Opens a file dialog",
                            },
                        ],
                        {
                            placeHolder:
                                "A shapes file was detected via a comment. How do you want to proceed?",
                        }
                    );
                    if (choice && choice.uri) {
                        return choice.uri;
                    }
                    if (choice && choice.label === "Select shapes file manually...") {
                        // Proceed to manual selection below
                    } else {
                        return undefined; // User cancelled or didn't pick the auto-detected one
                    }
                } else {
                    this.outputChannel.appendLine(
                        `Detected shapes path "${shapesPath}" (resolved to "${absoluteShapesPath}") does not exist. Please select manually.`
                    );
                }
            }
        } catch (e: any) {
            this.outputChannel.appendLine(
                `Could not check for shapes comment: ${e.message}`
            );
        }

        // If not found or user opts out, prompt manually
        const uris = await vscode.window.showOpenDialog({
            canSelectMany: false,
            title: "Select SHACL Shapes File",
            openLabel: "Use Shapes",
            filters: {
                "RDF Turtle": ["ttl", "shacl", "shc"], // Add shacl extensions here
                "RDF/XML": ["rdf", "owl"],
                "N-Triples": ["nt"],
                "JSON-LD": ["jsonld"],
                "All files": ["*"],
            },
            defaultUri: vscode.Uri.file(path.dirname(dataDocumentUri.fsPath)),
        });
        return uris?.[0];
    }
}

// export class ShaclValidationService {
//     private outputChannel: vscode.OutputChannel;

//     constructor() {
//         this.outputChannel = vscode.window.createOutputChannel("SHACL Validation");
//     }

//     public async validateActiveDocument() {
//         const editor = vscode.window.activeTextEditor;
//         if (!editor) {
//             vscode.window.showErrorMessage("No active document to validate.");
//             this.outputChannel.appendLine("Error: No active document to validate.");
//             return;
//         }
//         await this.validateDocument(editor.document.uri);
//     }

//     public async validateDocument(dataDocumentUri: vscode.Uri) {
//         this.outputChannel.clear();
//         this.outputChannel.show(true);
//         this.outputChannel.appendLine(
//             `Starting SHACL validation for: ${dataDocumentUri.fsPath}`
//         );

//         try {
//             const dataDocument = await vscode.workspace.openTextDocument(
//                 dataDocumentUri
//             );
//             const dataRdf = dataDocument.getText();

//             // 1. Get Shapes File
//             const shapesFileUri = await this.promptForShapesFile(dataDocumentUri);
//             if (!shapesFileUri) {
//                 this.outputChannel.appendLine(
//                     "SHACL validation cancelled: No shapes file selected."
//                 );
//                 vscode.window.showInformationMessage("SHACL validation cancelled.");
//                 return;
//             }
//             this.outputChannel.appendLine(
//                 `Using shapes file: ${shapesFileUri.fsPath}`
//             );

//             // 2. Load Data and Shapes Graphs
//             this.outputChannel.appendLine("Loading data graph...");
//             const dataGraph = await loadRdfTextAsDataset(
//                 dataRdf,
//                 dataDocumentUri.fsPath
//             );
//             this.outputChannel.appendLine(
//                 `Data graph loaded with ${dataGraph.size} quads.`
//             );

//             this.outputChannel.appendLine("Loading shapes graph...");
//             const shapesGraph = await loadRdfFileAsDataset(shapesFileUri.fsPath);
//             this.outputChannel.appendLine(
//                 `Shapes graph loaded with ${shapesGraph.size} quads.`
//             ); // 3. Perform Validation
//             this.outputChannel.appendLine("Initializing SHACL validator..."); // Create a factory object that meets the Factory interface requirements
//             // const factory = {
//             //     ...DataFactory,
//             //     dataset: () => new N3Store(),
//             // };

//             // Parse shapes graph
//             // const shapesParser = new N3.Parser({ baseIRI: "" });
//             // const shapesQuads = shapesParser.parse(shapesText);
//             // const shapesStore = new N3.Store();
//             // shapesStore.addQuads(shapesQuads);

//             // Parse data graph
//             const dataParser = new N3.Parser({ baseIRI: "" });
//             const dataQuads = dataParser.parse(dataRdf);
//             const dataStore = new N3.Store();
//             dataStore.addQuads(dataQuads);

//             // Create SHACL validator - properly import the default export
//             // const shaclValidator = await import("rdf-validate-shacl");
//             // const SHACLValidator = shaclValidator.default;
//             // const validator = new SHACLValidator(shapesStore, {});
//             // const valResults = await validator.validate(dataStore);

//             const validator = new SHACLValidator(shapesGraph, {});
//             this.outputChannel.appendLine("Performing validation...");
//             const report = await validator.validate(dataStore);

//             // 4. Display Results
//             this.outputChannel.appendLine("\n--- Validation Report ---");
//             this.outputChannel.appendLine(`Conforms: ${report.conforms}`);

//             if (!report.conforms) {
//                 vscode.window.showWarningMessage(
//                     `SHACL validation failed with ${report.results.length} violation(s). See 'SHACL Validation' output for details.`
//                 );
//                 this.outputChannel.appendLine(
//                     `Number of results (violations): ${report.results.length}`
//                 );
//                 report.results.forEach((result, index) => {
//                     this.outputChannel.appendLine(`\nViolation ${index + 1}:`);

//                     // Message can be an array of literals or a single literal
//                     const messageValues = (
//                         Array.isArray(result.message) ? result.message : [result.message]
//                     )
//                         .map((m) => m?.value || "No message value")
//                         .join("; ");
//                     this.outputChannel.appendLine(`  Message: ${messageValues}`);
//                     this.outputChannel.appendLine(
//                         `  Path: ${result.path
//                             ? this.termToString(result.path as unknown as Term)
//                             : "N/A"
//                         }`
//                     );
//                     this.outputChannel.appendLine(
//                         `  Focus Node: ${result.focusNode
//                             ? this.termToString(result.focusNode as unknown as Term)
//                             : "N/A"
//                         }`
//                     );
//                     this.outputChannel.appendLine(
//                         `  Severity: ${result.severity
//                             ? this.termToString(result.severity as unknown as Term)
//                             : "N/A"
//                         }`
//                     );
//                     if (result.sourceConstraintComponent) {
//                         this.outputChannel.appendLine(
//                             `  Constraint Component: ${this.termToString(
//                                 result.sourceConstraintComponent as unknown as Term
//                             )}`
//                         );
//                     }
//                     if (result.sourceShape) {
//                         this.outputChannel.appendLine(
//                             `  Source Shape: ${this.termToString(
//                                 result.sourceShape as unknown as Term
//                             )}`
//                         );
//                     }
//                     if (result.value) {
//                         this.outputChannel.appendLine(
//                             `  Value: ${this.termToString(result.value as unknown as Term)}`
//                         );
//                     }
//                 });
//             } else {
//                 vscode.window.showInformationMessage(
//                     "SHACL validation successful: Data conforms to shapes."
//                 );
//             }
//         } catch (error: any) {
//             vscode.window.showErrorMessage(
//                 `SHACL Validation Error: ${error.message}. Check 'SHACL Validation' output.`
//             );
//             this.outputChannel.appendLine(`\n--- ERROR ---`);
//             this.outputChannel.appendLine(error.message);
//             if (error.stack) {
//                 this.outputChannel.appendLine(error.stack);
//             }
//             console.error("SHACL Validation Error:", error);
//         }
//     }
//     private termToString(term: Term | null | undefined): string {
//         if (!term) {
//             return "N/A";
//         }
//         switch (term.termType) {
//             case "NamedNode":
//                 return `<${term.value}>`;
//             case "Literal":
//                 let lit = `"${term.value}"`;
//                 if ("language" in term && term.language) {
//                     lit += `@${term.language}`;
//                 }
//                 if ("datatype" in term && term.datatype) {
//                     lit += `^^<${term.datatype.value}>`;
//                 }
//                 return lit;
//             case "BlankNode":
//                 return `_:${term.value}`;
//             case "DefaultGraph":
//                 return "DefaultGraph";
//             default: // Quad, Variable etc.
//                 return term.value || "Unknown Term";
//         }
//     }

//     private async promptForShapesFile(
//         dataDocumentUri: vscode.Uri
//     ): Promise<vscode.Uri | undefined> {
//         try {
//             const doc = await vscode.workspace.openTextDocument(dataDocumentUri);
//             const text = doc.getText(
//                 new vscode.Range(
//                     new vscode.Position(0, 0),
//                     new vscode.Position(Math.min(doc.lineCount, 10), 0)
//                 )
//             ); // Check first 10 lines
//             const shapesCommentRegex = /#\s*shapes:\s*([^\s<>"]+)/i; // Avoid matching IRIs in <>
//             const match = text.match(shapesCommentRegex);

//             if (match && match[1]) {
//                 const shapesPath = match[1];
//                 let absoluteShapesPath: string;
//                 if (path.isAbsolute(shapesPath)) {
//                     absoluteShapesPath = shapesPath;
//                 } else {
//                     const dataDir = path.dirname(dataDocumentUri.fsPath);
//                     absoluteShapesPath = path.resolve(dataDir, shapesPath);
//                 }

//                 if (fs.existsSync(absoluteShapesPath)) {
//                     const choice = await vscode.window.showQuickPick(
//                         [
//                             {
//                                 label: `Use detected shapes: ${shapesPath}`,
//                                 description: absoluteShapesPath,
//                                 uri: vscode.Uri.file(absoluteShapesPath),
//                             },
//                             {
//                                 label: "Select shapes file manually...",
//                                 description: "Opens a file dialog",
//                             },
//                         ],
//                         {
//                             placeHolder:
//                                 "A shapes file was detected via a comment. How do you want to proceed?",
//                         }
//                     );
//                     if (choice && choice.uri) {
//                         return choice.uri;
//                     }
//                     if (choice && choice.label === "Select shapes file manually...") {
//                         // Proceed to manual selection below
//                     } else {
//                         return undefined; // User cancelled or didn't pick the auto-detected one
//                     }
//                 } else {
//                     this.outputChannel.appendLine(
//                         `Detected shapes path "${shapesPath}" (resolved to "${absoluteShapesPath}") does not exist. Please select manually.`
//                     );
//                 }
//             }
//         } catch (e: any) {
//             this.outputChannel.appendLine(
//                 `Could not check for shapes comment: ${e.message}`
//             );
//         }

//         // If not found or user opts out, prompt manually
//         const uris = await vscode.window.showOpenDialog({
//             canSelectMany: false,
//             title: "Select SHACL Shapes File",
//             openLabel: "Use Shapes",
//             filters: {
//                 "RDF Turtle": ["ttl"],
//                 "RDF/XML": ["rdf", "owl"],
//                 "N-Triples": ["nt"],
//                 "JSON-LD": ["jsonld"],
//                 "All files": ["*"],
//             },
//             // Set default URI to be near the data file
//             defaultUri: vscode.Uri.file(path.dirname(dataDocumentUri.fsPath)),
//         });
//         return uris?.[0];
//     }
// }
