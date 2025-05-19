// src/shacl/shaclCodeLensProvider.ts
import * as vscode from 'vscode';
import { RdfDocumentManager } from '../rdf/rdfDocumentManager';
import * as N3 from 'n3';
import { DataFactory } from 'n3';
import { HighlightingService } from '../highlighting/highlightingService';
import { Store } from 'n3';

const { namedNode } = DataFactory;

// Constants for SHACL related namespace IRIs
const SH = "http://www.w3.org/ns/shacl#";
const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";

// Enum for different types of SHACL targets
enum ShaclTargetType {
    NODE = "sh:targetNode",
    CLASS = "sh:targetClass",
    SUBJECTS_OF = "sh:targetSubjectsOf",
    OBJECTS_OF = "sh:targetObjectsOf",
    IMPLICIT_CLASS = "implicit_class" // Special case for shapes that are classes themselves
}

interface ShapeTarget {
    type: ShaclTargetType;
    value: string;
}

/**
 * CodeLens provider for SHACL shapes, showing the number of focus nodes targeted by each shape.
 */
export class ShaclCodeLensProvider implements vscode.CodeLensProvider {
    public _onDidChangeCodeLenses: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
    public readonly onDidChangeCodeLenses: vscode.Event<void> = this._onDidChangeCodeLenses.event;

    private rdfDocumentManager: RdfDocumentManager;
    private highlightingService: HighlightingService; constructor(rdfDocumentManager: RdfDocumentManager, highlightingService: HighlightingService) {
        this.rdfDocumentManager = rdfDocumentManager;
        this.highlightingService = highlightingService;

        // Refresh codelenses when relevant configurations change
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('shaclValidator.enableCodeLens') ||
                e.affectsConfiguration('shaclValidator.highlighting')) {
                this._onDidChangeCodeLenses.fire();
            }
        });

        // Refresh codelenses when document content changes
        vscode.workspace.onDidChangeTextDocument(e => {
            if (e.document.languageId === 'turtle') {
                this._onDidChangeCodeLenses.fire();
            }
        });

        // Refresh codelenses when editors change (e.g., when opening a different data document)
        vscode.window.onDidChangeActiveTextEditor(() => {
            this._onDidChangeCodeLenses.fire();
        });

        // Refresh codelenses when visible text editors change
        vscode.window.onDidChangeVisibleTextEditors(() => {
            this._onDidChangeCodeLenses.fire();
        });
    }

    public provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): vscode.ProviderResult<vscode.CodeLens[]> {
        // Check if CodeLens is enabled in settings
        const config = vscode.workspace.getConfiguration('shaclValidator');
        if (!config.get('enableCodeLens', true)) {
            return [];
        }

        const codeLenses: vscode.CodeLens[] = [];

        // Get the RDF document context
        const shapesContext = this.rdfDocumentManager.getDocumentContext(document.uri);
        if (!shapesContext || !shapesContext.isValid) {
            return []; // Document has errors or is not a valid RDF document
        }

        const shapesStore = shapesContext.store;

        // Find data graph document from visible editors
        let dataDocument: vscode.TextDocument | undefined;
        const editors = vscode.window.visibleTextEditors;
        const turtleEditors = editors.filter(e => e.document.languageId === 'turtle' && e.document.uri.toString() !== document.uri.toString());
        if (turtleEditors.length > 0) {
            dataDocument = turtleEditors[0].document;
        }

        if (!dataDocument) {
            // No data document found, provide CodeLens that will prompt to select one
            const shapeQuads = shapesStore.getQuads(null, namedNode(RDF + "type"), namedNode(SH + "NodeShape"), null);
            for (const shapeQuad of shapeQuads) {
                const shapeIRI = shapeQuad.subject.value;
                // Find shape declaration position in document
                const shapePosition = this.findShapePosition(document, shapeIRI);
                if (shapePosition) {
                    const codeLens = new vscode.CodeLens(shapePosition, {
                        title: "Select data graph to show focus nodes",
                        command: "vscode-shacl-validator.selectDataDocumentForFocusNodes",
                        arguments: [shapeIRI, document.uri]
                    });
                    codeLenses.push(codeLens);
                }
            }
            return codeLenses;
        }        // Both shapes and data documents available, find focus nodes for each shape
        const dataContext = this.rdfDocumentManager.getDocumentContext(dataDocument.uri);
        if (!dataContext || !dataContext.isValid) {
            return []; // Data document has errors
        }

        // Log document information for debugging
        console.log(`CodeLens for shapes document: ${document.uri.fsPath}`);
        console.log(`Using data document: ${dataDocument.uri.fsPath}`);

        const dataStore = dataContext.store;        // Find all node shapes in the document
        const nodeShapeQuads = shapesStore.getQuads(null, namedNode(RDF + "type"), namedNode(SH + "NodeShape"), null);
        // Process each shape
        for (const shapeQuad of nodeShapeQuads) {
            const shapeIRI = shapeQuad.subject.value;
            console.log(`Processing shape: ${shapeIRI}`);

            // Extract targets for this shape
            const targets = this.extractShapeTargets(shapesStore, shapeIRI);

            if (targets.length === 0) {
                console.log(`  - No targets found for shape: ${shapeIRI}`);
                continue; // Skip shapes with no targets
            }

            console.log(`  - Found ${targets.length} targets for shape ${shapeIRI}`);
            targets.forEach((target, idx) => {
                console.log(`    ${idx + 1}. ${target.type}: ${target.value}`);
            });

            // Find focus nodes for this shape's targets
            const focusNodes = this.findFocusNodes(dataStore, targets);
            console.log(`  - Found ${focusNodes.length} focus nodes for shape ${shapeIRI}`);            // Find shape declaration position in document
            const shapePosition = this.findShapePosition(document, shapeIRI);
            if (shapePosition) {
                console.log(`  - Found position for shape ${shapeIRI}: line ${shapePosition.start.line + 1}`);
                const hasProperties = this.hasPropertyPaths(shapesStore, shapeIRI);

                // Create the CodeLens with more specific information
                const codeLens = new vscode.CodeLens(shapePosition, {
                    title: hasProperties
                        ? `${focusNodes.length} focus node(s) with property constraints`
                        : `${focusNodes.length} focus node(s)`,
                    command: "vscode-shacl-validator.highlightFocusNodes",
                    arguments: [focusNodes, dataDocument.uri]
                });
                codeLenses.push(codeLens);
            } else {
                console.log(`  - ERROR: Could not find position for shape ${shapeIRI}`);
            }
        }

        return codeLenses;
    }

    /**
     * Extract targets from a SHACL shape
     */
    private extractShapeTargets(store: N3.Store, shapeIRI: string): ShapeTarget[] {
        const targets: ShapeTarget[] = [];

        // Check for targetClass
        const targetClassQuads = store.getQuads(namedNode(shapeIRI), namedNode(SH + "targetClass"), null, null);
        for (const quad of targetClassQuads) {
            targets.push({
                type: ShaclTargetType.CLASS,
                value: quad.object.value
            });
        }

        // Check for targetNode
        const targetNodeQuads = store.getQuads(namedNode(shapeIRI), namedNode(SH + "targetNode"), null, null);
        for (const quad of targetNodeQuads) {
            targets.push({
                type: ShaclTargetType.NODE,
                value: quad.object.value
            });
        }

        // Check for targetSubjectsOf
        const targetSubjectsOfQuads = store.getQuads(namedNode(shapeIRI), namedNode(SH + "targetSubjectsOf"), null, null);
        for (const quad of targetSubjectsOfQuads) {
            targets.push({
                type: ShaclTargetType.SUBJECTS_OF,
                value: quad.object.value
            });
        }

        // Check for targetObjectsOf
        const targetObjectsOfQuads = store.getQuads(namedNode(shapeIRI), namedNode(SH + "targetObjectsOf"), null, null);
        for (const quad of targetObjectsOfQuads) {
            targets.push({
                type: ShaclTargetType.OBJECTS_OF,
                value: quad.object.value
            });
        }

        // If no explicit targets, check if shape itself is a class (implicit target)
        if (targets.length === 0) {
            const classTypeQuads = store.getQuads(namedNode(shapeIRI), namedNode(RDF + "type"), namedNode("http://www.w3.org/2000/01/rdf-schema#Class"), null);
            if (classTypeQuads.length > 0) {
                targets.push({
                    type: ShaclTargetType.IMPLICIT_CLASS,
                    value: shapeIRI
                });
            }
        }

        return targets;
    }

    /**
     * Find focus nodes in the data graph based on targets
     */
    private findFocusNodes(dataStore: N3.Store, targets: ShapeTarget[]): string[] {
        const focusNodes: Set<string> = new Set();

        for (const target of targets) {
            switch (target.type) {
                case ShaclTargetType.NODE:
                    focusNodes.add(target.value);
                    break;

                case ShaclTargetType.CLASS:
                case ShaclTargetType.IMPLICIT_CLASS:
                    // Find instances of the class
                    const classInstances = this.findInstancesOfClass(dataStore, target.value);
                    classInstances.forEach(instance => focusNodes.add(instance));
                    break;

                case ShaclTargetType.SUBJECTS_OF:
                    // Find subjects with the given predicate
                    const subjects = this.findSubjectsOfPredicate(dataStore, target.value);
                    subjects.forEach(subject => focusNodes.add(subject));
                    break;

                case ShaclTargetType.OBJECTS_OF:
                    // Find objects with the given predicate
                    const objects = this.findObjectsOfPredicate(dataStore, target.value);
                    objects.forEach(object => focusNodes.add(object));
                    break;
            }
        }

        return Array.from(focusNodes);
    }

    /**
     * Find instances of a class in a data store
     */
    private findInstancesOfClass(dataStore: N3.Store, className: string): string[] {
        const instances: string[] = [];

        // Find all quads with rdf:type predicate pointing to the class
        const typeQuads = dataStore.getQuads(null, namedNode(RDF + "type"), namedNode(className), null);

        for (const quad of typeQuads) {
            instances.push(quad.subject.value);
        }

        return instances;
    }

    /**
     * Find subjects of triples with a specific predicate
     */
    private findSubjectsOfPredicate(dataStore: N3.Store, predicate: string): string[] {
        const subjects: string[] = [];

        // Find all quads with the given predicate
        const quads = dataStore.getQuads(null, namedNode(predicate), null, null);

        for (const quad of quads) {
            subjects.push(quad.subject.value);
        }

        return subjects;
    }

    /**
     * Find objects of triples with a specific predicate
     */
    private findObjectsOfPredicate(dataStore: N3.Store, predicate: string): string[] {
        const objects: string[] = [];

        // Find all quads with the given predicate
        const quads = dataStore.getQuads(null, namedNode(predicate), null, null);

        for (const quad of quads) {
            if (quad.object.termType === 'NamedNode' || quad.object.termType === 'BlankNode') {
                objects.push(quad.object.value);
            }
        }

        return objects;
    }

    /**
     * Check if a shape contains property paths
     */
    private hasPropertyPaths(store: N3.Store, shapeIRI: string): boolean {
        // Look for any property paths defined on this shape
        const propertyQuads = store.getQuads(namedNode(shapeIRI), namedNode(SH + "property"), null, null);
        return propertyQuads.length > 0;
    }

    /**
     * Find the position of a shape declaration in the document
     */
    private findShapePosition(document: vscode.TextDocument, shapeIRI: string): vscode.Range | undefined {
        const text = document.getText();

        // Try to find the shape IRI in the document
        // Note: This is a simple approach, a more robust solution would use a proper RDF parser
        const escapedShapeIRI = shapeIRI.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

        // Extract local name and prefix from IRI if possible for prefix-based matching
        let localName = "";
        if (shapeIRI.includes('#')) {
            localName = shapeIRI.substring(shapeIRI.lastIndexOf('#') + 1);
        } else if (shapeIRI.includes('/')) {
            localName = shapeIRI.substring(shapeIRI.lastIndexOf('/') + 1);
        }

        // Get document prefixes to help with matching
        const shapesContext = this.rdfDocumentManager.getDocumentContext(document.uri);
        const prefixes = shapesContext?.prefixes || {};

        // Create specific patterns for this shape, including prefixed versions
        const specificPatterns = [];

        // Full IRI pattern
        specificPatterns.push(`<${escapedShapeIRI}>\\s+(?:<${RDF}type>|a)\\s+(?:<${SH}NodeShape>|sh:NodeShape)`);

        // Find potential prefixed versions based on document prefixes
        for (const [prefix, uri] of Object.entries(prefixes)) {
            if (shapeIRI.startsWith(uri)) {
                const prefixedName = `${prefix}:${shapeIRI.substring(uri.length)}`;
                const escapedPrefixedName = prefixedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                specificPatterns.push(`${escapedPrefixedName}\\s+(?:<${RDF}type>|a|rdf:type)\\s+(?:<${SH}NodeShape>|sh:NodeShape)`);
                specificPatterns.push(`${escapedPrefixedName}\\s+a\\s+sh:NodeShape`);
            }
        }

        // Add patterns for local name match if we have one
        if (localName) {
            const escapedLocalName = localName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            specificPatterns.push(`\\b${escapedLocalName}\\b\\s+(?:<${RDF}type>|a|rdf:type)\\s+(?:<${SH}NodeShape>|sh:NodeShape)`);
            specificPatterns.push(`:[\\s\\n]*${escapedLocalName}\\s+(?:<${RDF}type>|a|rdf:type)\\s+(?:<${SH}NodeShape>|sh:NodeShape)`);
        }

        // Try each specific pattern first
        for (const patternStr of specificPatterns) {
            try {
                const pattern = new RegExp(patternStr, 'g');
                let match;

                while ((match = pattern.exec(text)) !== null) {
                    // For each match, verify this is actually our shape by extracting and comparing the subject
                    const matchedText = match[0];
                    const startPos = document.positionAt(match.index);
                    const endPos = document.positionAt(match.index + matchedText.length);

                    // Get a bit more context to verify this is the correct shape
                    const lineNumber = startPos.line;
                    const lineText = document.lineAt(lineNumber).text;
                    // Check if this line actually refers to our shapeIRI or a prefixed version of it
                    if (lineText.includes(`<${shapeIRI}>`) ||
                        (localName && new RegExp(`\\b${localName}\\b`).test(lineText))) {
                        return new vscode.Range(startPos, endPos);
                    }

                    // Check if this is a prefixed version matching our shape
                    for (const [prefix, uri] of Object.entries(prefixes)) {
                        if (shapeIRI.startsWith(uri)) {
                            const prefixedName = `${prefix}:${shapeIRI.substring(uri.length)}`;
                            if (lineText.includes(prefixedName)) {
                                return new vscode.Range(startPos, endPos);
                            }
                        }
                    }
                }
            } catch (e) {
                // Skip problematic patterns
                console.error(`Error with pattern: ${patternStr}`, e);
            }
        }

        // Fallback to generic shape detection - as a last resort
        const genericPatterns = [            // Look for directly preceding IRI/prefix declarations for shapes
            `(?:<${escapedShapeIRI}>|\\S+:${localName})\\s+(?:<${RDF}type>|a|rdf:type)\\s+(?:<${SH}NodeShape>|sh:NodeShape)`,
            // Look for IRI object declarations where the shape is the object
            `\\S+\\s+\\S+\\s+<${escapedShapeIRI}>`,
            // Look for blank node subject declarations
            `_:\\S+\\s+(?:<${RDF}type>|a|rdf:type)\\s+(?:<${SH}NodeShape>|sh:NodeShape)`
        ];
        // Try each line of the document to find shape declarations
        const lines = text.split('\n');

        // Generate possible prefixed forms of the shape IRI
        const possiblePrefixedForms: string[] = [];
        for (const [prefix, uri] of Object.entries(prefixes)) {
            if (shapeIRI.startsWith(uri)) {
                const prefixedName = `${prefix}:${shapeIRI.substring(uri.length)}`;
                possiblePrefixedForms.push(prefixedName);
            }
        }

        // Add local name to check as well if we have one
        const possibleLocalForms = localName ? [localName, `:${localName}`] : [];

        // First pass: Look for exact shape declarations (most specific matches first)
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            // Check for full IRI with type declaration
            if (line.includes(`<${shapeIRI}>`) &&
                (line.includes('a sh:NodeShape') ||
                    line.includes(`<${RDF}type> sh:NodeShape`) ||
                    line.includes(`<${RDF}type> <${SH}NodeShape>`) ||
                    line.includes(`rdf:type sh:NodeShape`) ||
                    line.includes(`rdf:type <${SH}NodeShape>`))) {

                console.log(`Found shape ${shapeIRI} on line ${i + 1} with full IRI pattern`);
                return new vscode.Range(
                    new vscode.Position(i, 0),
                    new vscode.Position(i, line.length)
                );
            }

            // Check for prefixed forms with type declaration
            for (const prefixedForm of possiblePrefixedForms) {
                if (line.includes(prefixedForm) &&
                    (line.includes('a sh:NodeShape') ||
                        line.includes(`<${RDF}type> sh:NodeShape`) ||
                        line.includes(`<${RDF}type> <${SH}NodeShape>`) ||
                        line.includes(`rdf:type sh:NodeShape`) ||
                        line.includes(`rdf:type <${SH}NodeShape>`))) {

                    console.log(`Found shape ${shapeIRI} on line ${i + 1} with prefixed form ${prefixedForm}`);
                    return new vscode.Range(
                        new vscode.Position(i, 0),
                        new vscode.Position(i, line.length)
                    );
                }
            }
        }

        // Second pass: Less strict pattern matching
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            // First check for full IRI
            if (line.includes(`<${shapeIRI}>`)) {
                // Look ahead a few lines to check if this is the subject of a sh:NodeShape
                for (let j = i; j < Math.min(i + 5, lines.length); j++) {
                    if (lines[j].includes('sh:NodeShape') || lines[j].includes(`<${SH}NodeShape>`)) {
                        console.log(`Found shape ${shapeIRI} with lookahead on lines ${i + 1}-${j + 1}`);
                        return new vscode.Range(
                            new vscode.Position(i, 0),
                            new vscode.Position(i, line.length)
                        );
                    }
                }
            }

            // Check for prefixed forms
            for (const prefixedForm of possiblePrefixedForms) {
                const prefixPattern = new RegExp(`\\b${prefixedForm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
                if (prefixPattern.test(line)) {
                    // Look ahead a few lines to check if this is the subject of a sh:NodeShape
                    for (let j = i; j < Math.min(i + 5, lines.length); j++) {
                        if (lines[j].includes('sh:NodeShape') || lines[j].includes(`<${SH}NodeShape>`)) {
                            console.log(`Found shape ${shapeIRI} with prefixed form lookahead on lines ${i + 1}-${j + 1}`);
                            return new vscode.Range(
                                new vscode.Position(i, 0),
                                new vscode.Position(i, line.length)
                            );
                        }
                    }
                }
            }

            // Check for local name forms
            for (const localForm of possibleLocalForms) {
                const localPattern = new RegExp(`\\b${localForm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
                if (localPattern.test(line)) {
                    // Look ahead a few lines to check if this is the subject of a sh:NodeShape
                    for (let j = i; j < Math.min(i + 5, lines.length); j++) {
                        if (lines[j].includes('sh:NodeShape') || lines[j].includes(`<${SH}NodeShape>`)) {
                            console.log(`Found shape ${shapeIRI} with local name lookahead on lines ${i + 1}-${j + 1}`);
                            return new vscode.Range(
                                new vscode.Position(i, 0),
                                new vscode.Position(i, line.length)
                            );
                        }
                    }
                }
            }
        }


        return undefined;
    }
}
