// src/tree/sessionsTreeDataProvider.ts
import * as vscode from 'vscode';
import { SessionManagerService } from '../sessions/sessionManagerService';
import { ValidationSession } from '../sessions/validationSession';
import * as path from 'path';

export class SessionsTreeDataProvider implements vscode.TreeDataProvider<ValidationSessionItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<ValidationSessionItem | undefined | null | void> = new vscode.EventEmitter<ValidationSessionItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<ValidationSessionItem | undefined | null | void> = this._onDidChangeTreeData.event;

    constructor(private sessionManager: SessionManagerService) {
        this.sessionManager.onDidChangeSessions(() => {
            this.refresh();
        });
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: ValidationSessionItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: ValidationSessionItem): Thenable<ValidationSessionItem[]> {
        if (element) {
            // We could have children for a session, e.g., "Data File", "Shapes File", "Last Report"
            // For now, sessions are leaf nodes or have simple action children.
            // Let's add sub-items for files:
            const children: ValidationSessionItem[] = [];
            children.push(new ValidationSessionItem(
                `Data: ${element.session.dataGraphFileName || path.basename(element.session.dataGraphUri.fsPath)}`,
                vscode.TreeItemCollapsibleState.None,
                element.session,
                "dataGraph"
            ));
            children.push(new ValidationSessionItem(
                `Shapes: ${element.session.shapesGraphFileName || path.basename(element.session.shapesGraphUri.fsPath)}`,
                vscode.TreeItemCollapsibleState.None,
                element.session,
                "shapesGraph"
            ));
            if (element.session.lastValidationReport) {
                children.push(new ValidationSessionItem(
                    `View Last Report (${element.session.lastValidationReport.conforms ? 'Conforms' : 'Violations: ' + element.session.lastValidationReport.results.length})`,
                    vscode.TreeItemCollapsibleState.None,
                    element.session,
                    "viewReport"
                ));
            }
            return Promise.resolve(children);

        } else {
            // Root level: display all sessions
            const sessions = this.sessionManager.getAllSessions();
            return Promise.resolve(sessions.map(session => new ValidationSessionItem(session.name, vscode.TreeItemCollapsibleState.Collapsed, session, "sessionRoot")));
        }
    }
}

export class ValidationSessionItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly session: ValidationSession, // Store the full session data
        public readonly itemType: 'sessionRoot' | 'dataGraph' | 'shapesGraph' | 'viewReport' // To differentiate items
    ) {
        super(label, collapsibleState);
        this.tooltip = this.getTooltip();
        this.description = this.getDescription();
        this.contextValue = this.getContextValue(); // Used for when clauses in package.json for commands
        this.command = this.getCommand();

        if (itemType === 'sessionRoot') {
            this.iconPath = new vscode.ThemeIcon(session.lastValidationReport ? (session.lastValidationReport.conforms ? 'check' : 'warning') : 'history');
        } else if (itemType === 'dataGraph' || itemType === 'shapesGraph') {
            this.iconPath = vscode.ThemeIcon.File;
        } else if (itemType === 'viewReport') {
            this.iconPath = new vscode.ThemeIcon('notebook-execute');
        }
    }

    private getTooltip(): string {
        switch (this.itemType) {
            case 'sessionRoot':
                return `${this.session.name}\nData: ${this.session.dataGraphUri.fsPath}\nShapes: ${this.session.shapesGraphUri.fsPath}\nCreated: ${new Date(this.session.createdAt).toLocaleString()}`;
            case 'dataGraph':
                return `Open Data Graph: ${this.session.dataGraphUri.fsPath}`;
            case 'shapesGraph':
                return `Open Shapes Graph: ${this.session.shapesGraphUri.fsPath}`;
            case 'viewReport':
                return `View the last validation report for this session`;
            default:
                return this.label;
        }
    }

    private getDescription(): string | boolean {
        switch (this.itemType) {
            case 'sessionRoot':
                return `(${this.session.dataGraphFileName} / ${this.session.shapesGraphFileName})`;
            default:
                return false;
        }
    }

    private getContextValue(): string {
        if (this.itemType === 'sessionRoot') {
            return 'shaclValidationSession';
        }
        return `shaclValidationSession.${this.itemType}`;
    }

    private getCommand(): vscode.Command | undefined {
        switch (this.itemType) {
            case 'sessionRoot': // Clicking the session itself could run validation or show report
                return {
                    command: 'vscode-shacl-validator.runSessionValidation',
                    title: 'Run SHACL Validation for this Session',
                    arguments: [this.session.id]
                };
            case 'dataGraph':
                return {
                    command: 'vscode-shacl-validator.openSessionFile',
                    title: 'Open Data Graph File',
                    arguments: [this.session.dataGraphUri]
                };
            case 'shapesGraph':
                return {
                    command: 'vscode-shacl-validator.openSessionFile',
                    title: 'Open Shapes Graph File',
                    arguments: [this.session.shapesGraphUri]
                };
            case 'viewReport':
                return {
                    command: 'vscode-shacl-validator.viewSessionReport',
                    title: 'View Last SHACL Validation Report',
                    arguments: [this.session.id]
                };
            default:
                return undefined;
        }
    }
}