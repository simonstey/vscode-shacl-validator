// src/extension.ts
import * as vscode from "vscode";
import { ShaclValidationService } from "./shacl/shaclValidatorService";
import { HighlightingService } from "./highlighting/highlightingService";
import { RdfDocumentManager } from "./rdf/rdfDocumentManager";
import { ValidationResultsViewProvider, WebviewValidationReport } from "./webview/validationResultsViewProvider";
import { SessionManagerService } from "./sessions/sessionManagerService"; // NEW
import { SessionsTreeDataProvider, ValidationSessionItem } from "./tree/sessionsTreeDataProvider"; // NEW
import { ShaclCodeLensProvider } from "./shacl/shaclCodeLensProvider"; // NEW for CodeLens
import * as path from "path"; // For file dialog defaults

let shaclService: ShaclValidationService;
let highlightingService: HighlightingService;
let rdfDocumentManager: RdfDocumentManager;
let validationResultsViewProvider: ValidationResultsViewProvider;
let sessionManagerService: SessionManagerService; // NEW
let sessionsTreeDataProvider: SessionsTreeDataProvider; // NEW
let shaclCodeLensProvider: ShaclCodeLensProvider; // NEW for CodeLens

// Helper function to check if a document is already open and show it, or open it in a specific column
async function showDocumentInColumn(uri: vscode.Uri, column: vscode.ViewColumn): Promise<vscode.TextEditor> {
    // First check if the document is already open in an editor
    for (const editor of vscode.window.visibleTextEditors) {
        if (editor.document.uri.toString() === uri.toString()) {
            // Document is already open, just reveal it in its current view column
            return await vscode.window.showTextDocument(editor.document, editor.viewColumn);
        }
    }

    // Document not open, show it in the specified column
    const document = await vscode.workspace.openTextDocument(uri);
    return await vscode.window.showTextDocument(document, column);
}

export function activate(context: vscode.ExtensionContext) {
    console.log('Congratulations, your extension "vscode-shacl-validator" is now active!');

    highlightingService = new HighlightingService();
    rdfDocumentManager = new RdfDocumentManager(); // Make sure this is initialized before ShaclService if it depends on it.

    // Initialize Session Manager first as TreeDataProvider and ShaclService might depend on it
    sessionManagerService = new SessionManagerService(context);
    context.subscriptions.push(sessionManagerService);

    sessionsTreeDataProvider = new SessionsTreeDataProvider(sessionManagerService);
    const sessionsView = vscode.window.createTreeView("shaclPlayground", {
        // 'shaclPlayground' is the ID from package.json
        treeDataProvider: sessionsTreeDataProvider,
    });
    context.subscriptions.push(sessionsView);

    validationResultsViewProvider = new ValidationResultsViewProvider(
        context.extensionUri,
        highlightingService,
        rdfDocumentManager
    );
    context.subscriptions.push(validationResultsViewProvider);

    // Pass SessionManagerService to ShaclService to update reports
    shaclService = new ShaclValidationService(validationResultsViewProvider, rdfDocumentManager, sessionManagerService);

    // Initialize CodeLens provider for SHACL shapes
    shaclCodeLensProvider = new ShaclCodeLensProvider(rdfDocumentManager, highlightingService);
    context.subscriptions.push(
        vscode.languages.registerCodeLensProvider({ language: "turtle", scheme: "*" }, shaclCodeLensProvider)
    );

    highlightingService.updateHighlightColor();

    // --- COMMANDS ---

    // Existing validation commands (might be less used if sessions are primary)
    context.subscriptions.push(
        vscode.commands.registerCommand("vscode-shacl-validator.validateActiveDocument", () =>
            shaclService.validateActiveDocument()
        )
    );
    context.subscriptions.push(
        vscode.commands.registerCommand("vscode-shacl-validator.validateDocument", (uri?: vscode.Uri) => {
            /* ... existing logic ... */
        })
    );

    // Highlighting Commands
    context.subscriptions.push(
        vscode.commands.registerCommand("vscode-shacl-validator.highlightSelection", () =>
            highlightingService.highlightSelection()
        )
    );
    context.subscriptions.push(
        vscode.commands.registerCommand("vscode-shacl-validator.clearHighlights", () =>
            highlightingService.clearHighlights()
        )
    );

    // Session Commands
    context.subscriptions.push(
        vscode.commands.registerCommand("vscode-shacl-validator.createSession", async () => {
            const dataGraphUri = await vscode.window.showOpenDialog({
                canSelectMany: false,
                title: "Select Data Graph File for New Session",
                openLabel: "Select Data Graph",
                filters: {
                    "RDF Files": ["ttl", "rdf", "shacl", "shc", "n3", "jsonld", "nt"],
                    "All files": ["*"],
                },
                defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
            });
            if (!dataGraphUri || dataGraphUri.length === 0) {
                return;
            }

            const shapesGraphUri = await vscode.window.showOpenDialog({
                canSelectMany: false,
                title: "Select Shapes Graph File for New Session",
                openLabel: "Select Shapes Graph",
                filters: {
                    "RDF Files": ["ttl", "rdf", "shacl", "shc", "n3", "jsonld", "nt"],
                    "All files": ["*"],
                },
                defaultUri: dataGraphUri[0]
                    ? vscode.Uri.file(path.dirname(dataGraphUri[0].fsPath))
                    : vscode.workspace.workspaceFolders?.[0]?.uri,
            });
            if (!shapesGraphUri || shapesGraphUri.length === 0) {
                return;
            }

            const sessionName = await vscode.window.showInputBox({
                prompt: "Enter a name for this validation session (optional)",
                placeHolder: `Session: ${path.basename(dataGraphUri[0].fsPath)} vs ${path.basename(
                    shapesGraphUri[0].fsPath
                )}`,
            });
            // If user cancels name input, sessionName will be undefined, which is fine for createSession

            await sessionManagerService.createSession(dataGraphUri[0], shapesGraphUri[0], sessionName);
            sessionsTreeDataProvider.refresh(); // Explicit refresh just in case
            vscode.commands.executeCommand("shaclPlayground.focus"); // Focus the view
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            "vscode-shacl-validator.runSessionValidation",
            async (sessionIdOrItem: string | ValidationSessionItem) => {
                let sessionId: string;
                if (typeof sessionIdOrItem === "string") {
                    sessionId = sessionIdOrItem;
                } else if (
                    sessionIdOrItem instanceof ValidationSessionItem &&
                    sessionIdOrItem.itemType === "sessionRoot"
                ) {
                    sessionId = sessionIdOrItem.session.id;
                } else {
                    vscode.window.showErrorMessage("Invalid argument for running session validation.");
                    return;
                }

                const session = sessionManagerService.getSession(sessionId);
                if (session) {
                    await vscode.workspace.openTextDocument(session.dataGraphUri); // Open files
                    await vscode.workspace.openTextDocument(session.shapesGraphUri);
                    await shaclService.validateDocument(session.dataGraphUri, session.shapesGraphUri, sessionId); // Pass sessionId
                } else {
                    vscode.window.showErrorMessage(`Session with ID ${sessionId} not found.`);
                }
            }
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            "vscode-shacl-validator.viewSessionReport",
            (sessionIdOrItem: string | ValidationSessionItem) => {
                let sessionId: string;
                if (typeof sessionIdOrItem === "string") {
                    sessionId = sessionIdOrItem;
                } else if (sessionIdOrItem instanceof ValidationSessionItem) {
                    // Could be any item type if command is on sessionRoot
                    sessionId = sessionIdOrItem.session.id;
                } else {
                    vscode.window.showErrorMessage("Invalid argument for viewing session report.");
                    return;
                }
                const session = sessionManagerService.getSession(sessionId);
                if (session?.lastValidationReport) {
                    validationResultsViewProvider.showResults(session.lastValidationReport);
                } else if (session) {
                    vscode.window.showInformationMessage(
                        `No report for session '${session.name}'. Run validation first.`
                    );
                    // Optionally, trigger validation
                    // vscode.commands.executeCommand('vscode-shacl-validator.runSessionValidation', session.id);
                } else {
                    vscode.window.showErrorMessage(`Session with ID ${sessionId} not found.`);
                }
            }
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("vscode-shacl-validator.deleteSession", async (item: ValidationSessionItem) => {
            if (item && item.session && item.itemType === "sessionRoot") {
                const confirm = await vscode.window.showWarningMessage(
                    `Are you sure you want to delete session "${item.session.name}"?`,
                    { modal: true },
                    "Delete"
                );
                if (confirm === "Delete") {
                    await sessionManagerService.deleteSession(item.session.id);
                }
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("vscode-shacl-validator.renameSession", async (item: ValidationSessionItem) => {
            if (item && item.session && item.itemType === "sessionRoot") {
                const newName = await vscode.window.showInputBox({
                    prompt: "Enter new name for the session",
                    value: item.session.name,
                });
                if (newName && newName !== item.session.name) {
                    await sessionManagerService.updateSessionName(item.session.id, newName);
                }
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("vscode-shacl-validator.openSessionFile", async (fileUri: vscode.Uri) => {
            if (fileUri) {
                try {
                    const document = await vscode.workspace.openTextDocument(fileUri);
                    await vscode.window.showTextDocument(document, { preview: false });
                } catch (e: any) {
                    vscode.window.showErrorMessage(`Failed to open file: ${fileUri.fsPath}. ${e.message}`);
                }
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("vscode-shacl-validator.refreshSessions", () => {
            sessionsTreeDataProvider.refresh();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            "vscode-shacl-validator.replaceDataGraph",
            async (item: ValidationSessionItem) => {
                if (item && item.session && item.itemType === "dataGraph") {
                    const newDataGraphUri = await vscode.window.showOpenDialog({
                        canSelectMany: false,
                        title: "Select New Data Graph File",
                        openLabel: "Select Data Graph",
                        filters: {
                            "RDF Files": ["ttl", "rdf", "shacl", "shc", "n3", "jsonld", "nt"],
                            "All files": ["*"],
                        },
                        defaultUri: vscode.Uri.file(path.dirname(item.session.dataGraphUri.fsPath)),
                    });

                    if (newDataGraphUri && newDataGraphUri.length > 0) {
                        await sessionManagerService.updateSessionDataGraph(item.session.id, newDataGraphUri[0]);
                        sessionsTreeDataProvider.refresh(); // Refresh the specific item or the whole tree
                    }
                }
            }
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            "vscode-shacl-validator.replaceShapesGraph",
            async (item: ValidationSessionItem) => {
                if (item && item.session && item.itemType === "shapesGraph") {
                    const newShapesGraphUri = await vscode.window.showOpenDialog({
                        canSelectMany: false,
                        title: "Select New Shapes Graph File",
                        openLabel: "Select Shapes Graph",
                        filters: {
                            "RDF Files": ["ttl", "rdf", "shacl", "shc", "n3", "jsonld", "nt"],
                            "All files": ["*"],
                        },
                        defaultUri: vscode.Uri.file(path.dirname(item.session.shapesGraphUri.fsPath)),
                    });

                    if (newShapesGraphUri && newShapesGraphUri.length > 0) {
                        await sessionManagerService.updateSessionShapesGraph(item.session.id, newShapesGraphUri[0]);
                        sessionsTreeDataProvider.refresh(); // Refresh the specific item or the whole tree
                    }
                }
            }
        )
    );

    // CodeLens commands for focus nodes
    context.subscriptions.push(
        vscode.commands.registerCommand(
            "vscode-shacl-validator.highlightFocusNodes",
            async (focusNodes: string[], dataDocumentUri: vscode.Uri) => {
                try {
                    // First, check if the data document is already open in a visible editor
                    let dataEditor: vscode.TextEditor | undefined;

                    for (const editor of vscode.window.visibleTextEditors) {
                        if (editor.document.uri.toString() === dataDocumentUri.toString()) {
                            dataEditor = editor;
                            break;
                        }
                    }

                    // If not found or not visible, open it in column one
                    if (!dataEditor) {
                        const dataDoc = await vscode.workspace.openTextDocument(dataDocumentUri);
                        dataEditor = await vscode.window.showTextDocument(dataDoc, vscode.ViewColumn.One);
                    } else {
                        // Document is already open, show it in its current column
                        dataEditor = await vscode.window.showTextDocument(dataEditor.document, dataEditor.viewColumn);
                    }

                    // Clear any existing highlights
                    highlightingService.clearHighlights(dataEditor);

                    // Find and highlight focus nodes in the document
                    const text = dataEditor.document.getText();
                    let foundAny = false;

                    // Get document context to check for prefixes
                    const dataContext = rdfDocumentManager.getDocumentContext(dataDocumentUri);
                    const prefixes = dataContext?.prefixes || {};
                    const prefixEntries = Object.entries(prefixes);

                    for (const focusNode of focusNodes) {
                        // Try different formats of the node to find a match
                        const searchPatterns = [
                            `<${focusNode}>`, // Full IRI
                            focusNode, // Direct value (might be good for literals or simple identifiers)
                        ];

                        // Add local name variations
                        if (focusNode.includes("#")) {
                            searchPatterns.push(focusNode.substring(focusNode.lastIndexOf("#") + 1));
                        } else if (focusNode.includes("/")) {
                            searchPatterns.push(focusNode.substring(focusNode.lastIndexOf("/") + 1));
                        }

                        // Add prefixed versions based on document prefixes
                        for (const [prefix, uri] of prefixEntries) {
                            if (focusNode.startsWith(uri)) {
                                searchPatterns.push(`${prefix}:${focusNode.substring(uri.length)}`);
                            }
                        }

                        for (const pattern of searchPatterns) {
                            // Skip empty patterns
                            if (!pattern || pattern.trim() === "") {
                                continue;
                            }

                            try {
                                // Create a pattern that matches the focus node at word boundaries
                                const safePattern = pattern.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&");
                                const regex = new RegExp(`(?:^|\\s|<|")(${safePattern})(?=\\s|>|\\.|;|,|"|$)`, "g");

                                let match;
                                while ((match = regex.exec(text)) !== null) {
                                    const matchedText = match[1];
                                    const startPos = dataEditor.document.positionAt(
                                        match.index + (match[0].length - matchedText.length)
                                    );
                                    const endPos = dataEditor.document.positionAt(match.index + match[0].length);
                                    const range = new vscode.Range(startPos, endPos);

                                    highlightingService.highlightRange(dataEditor, range);
                                    foundAny = true;
                                }
                            } catch (regexError) {
                                console.error(`Error with regex for pattern '${pattern}':`, regexError);
                                // Continue with other patterns
                            }
                        }
                    }

                    if (!foundAny) {
                        vscode.window.showInformationMessage(
                            "No focus node patterns found in the document. They might be using different formats than expected."
                        );
                    } else {
                        vscode.window.showInformationMessage(`Highlighted ${focusNodes.length} focus nodes.`);
                    }
                } catch (error) {
                    vscode.window.showErrorMessage(`Error highlighting focus nodes: ${error}`);
                }
            }
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            "vscode-shacl-validator.selectDataDocumentForFocusNodes",
            async (shapeIRI: string, shapesDocUri: vscode.Uri) => {
                // Prompt the user to select a data document
                const dataFileUri = await vscode.window.showOpenDialog({
                    canSelectMany: false,
                    title: "Select RDF Data Graph to Find Focus Nodes",
                    openLabel: "Select Data Graph",
                    filters: {
                        "RDF Files": ["ttl", "rdf", "shacl", "shc", "n3", "jsonld", "nt"],
                        "All files": ["*"],
                    },
                });

                if (!dataFileUri || dataFileUri.length === 0) {
                    return;
                }

                try {
                    // Get the shapes and data contexts
                    const shapesContext = rdfDocumentManager.getDocumentContext(shapesDocUri);
                    if (!shapesContext || !shapesContext.isValid) {
                        vscode.window.showErrorMessage("Shapes document has errors and cannot be parsed.");
                        return;
                    }

                    // Open shapes document in column two
                    let shapesEditor: vscode.TextEditor | undefined;

                    // Check if shapes document is already open
                    for (const editor of vscode.window.visibleTextEditors) {
                        if (editor.document.uri.toString() === shapesDocUri.toString()) {
                            shapesEditor = editor;
                            break;
                        }
                    }

                    if (!shapesEditor) {
                        // Not found or not visible, open it in column two
                        const shapesDoc = await vscode.workspace.openTextDocument(shapesDocUri);
                        await vscode.window.showTextDocument(shapesDoc, vscode.ViewColumn.Two);
                    } else {
                        // Already open, just make sure it's visible
                        await vscode.window.showTextDocument(shapesEditor.document, shapesEditor.viewColumn);
                    }

                    // Open data document in column one
                    const dataDoc = await vscode.workspace.openTextDocument(dataFileUri[0]);
                    await vscode.window.showTextDocument(dataDoc, vscode.ViewColumn.One);

                    // Parse the data document
                    const dataContext = rdfDocumentManager.getDocumentContext(dataFileUri[0]);
                    if (!dataContext || !dataContext.isValid) {
                        vscode.window.showErrorMessage("Data document has errors and cannot be parsed.");
                        return;
                    }

                    // Extract shape targets and find focus nodes
                    const shapesStore = shapesContext.store;
                    const DataFactory = require("n3").DataFactory;
                    const { namedNode } = DataFactory;

                    // Now use the ShaclCodeLensProvider to find focus nodes
                    const tempCodeLensProvider = new ShaclCodeLensProvider(rdfDocumentManager, highlightingService);

                    // Get private methods via any casting
                    const provider = tempCodeLensProvider as any;
                    const targets = provider.extractShapeTargets(shapesStore, shapeIRI);
                    const focusNodes = provider.findFocusNodes(dataContext.store, targets);

                    if (focusNodes.length === 0) {
                        vscode.window.showInformationMessage(`No focus nodes found for shape ${shapeIRI}`);
                        return;
                    }

                    // Highlight the focus nodes
                    vscode.commands.executeCommand(
                        "vscode-shacl-validator.highlightFocusNodes",
                        focusNodes,
                        dataFileUri[0]
                    );
                } catch (error) {
                    vscode.window.showErrorMessage(`Error processing focus nodes: ${error}`);
                }
            }
        )
    );

    // Config change listener
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration("shaclValidator.highlighting.color")) {
                highlightingService.updateHighlightColor();
            }
            if (event.affectsConfiguration("shaclValidator.enableCodeLens")) {
                // Refresh codelenses if the setting changes
                shaclCodeLensProvider._onDidChangeCodeLenses.fire();
            }
        })
    );

    // Register our helper function as an internal command so it can be called from anywhere
    context.subscriptions.push(
        vscode.commands.registerCommand("vscode-shacl-validator.internal.showDocumentInColumn", showDocumentInColumn)
    );

    // Add other disposables
    context.subscriptions.push(highlightingService);
    context.subscriptions.push(rdfDocumentManager);
}

export function deactivate() {}
