// src/sessions/sessionManagerService.ts
import * as vscode from 'vscode';
import { ValidationSession } from './validationSession';
import { WebviewValidationReport } from '../webview/validationResultsViewProvider'; // Adjust path
import * as path from 'path';

export class SessionManagerService implements vscode.Disposable {
    private sessions: Map<string, ValidationSession> = new Map();
    private _onDidChangeSessions: vscode.EventEmitter<ValidationSession | undefined> = new vscode.EventEmitter<ValidationSession | undefined>();
    public readonly onDidChangeSessions: vscode.Event<ValidationSession | undefined> = this._onDidChangeSessions.event;

    private storageKey = 'shaclValidationSessions';
    private context: vscode.ExtensionContext;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.loadSessions(); // Load sessions on activation
    }

    private async loadSessions() {
        const storedSessions = this.context.workspaceState.get<any[]>(this.storageKey, []);
        storedSessions.forEach(s => {
            if (s.id && s.dataGraphUri && s.shapesGraphUri && s.name && s.createdAt) {
                this.sessions.set(s.id, {
                    ...s,
                    dataGraphUri: vscode.Uri.parse(s.dataGraphUri),
                    shapesGraphUri: vscode.Uri.parse(s.shapesGraphUri),
                    // lastValidationReport might need more careful deserialization if complex
                });
            }
        });
        this._onDidChangeSessions.fire(undefined); // Notify tree view to refresh
    }

    private async saveSessions() {
        // Prepare sessions for storage (convert URIs to strings)
        const sessionsToStore = Array.from(this.sessions.values()).map(s => ({
            ...s,
            dataGraphUri: s.dataGraphUri.toString(),
            shapesGraphUri: s.shapesGraphUri.toString(),
        }));
        await this.context.workspaceState.update(this.storageKey, sessionsToStore);
    }

    public async createSession(dataGraphUri: vscode.Uri, shapesGraphUri: vscode.Uri, name?: string): Promise<ValidationSession> {
        const id = Date.now().toString(); // Simple unique ID
        const sessionName = name || `Session ${this.sessions.size + 1} (${path.basename(dataGraphUri.fsPath)} vs ${path.basename(shapesGraphUri.fsPath)})`;

        const session: ValidationSession = {
            id,
            name: sessionName,
            dataGraphUri,
            shapesGraphUri,
            createdAt: Date.now(),
            dataGraphFileName: path.basename(dataGraphUri.fsPath),
            shapesGraphFileName: path.basename(shapesGraphUri.fsPath)
        };
        this.sessions.set(id, session);
        await this.saveSessions();
        this._onDidChangeSessions.fire(session);
        return session;
    }

    public getSession(id: string): ValidationSession | undefined {
        return this.sessions.get(id);
    }

    public getAllSessions(): ValidationSession[] {
        return Array.from(this.sessions.values()).sort((a, b) => b.createdAt - a.createdAt); // Newest first
    }

    public async deleteSession(id: string): Promise<void> {
        if (this.sessions.has(id)) {
            this.sessions.delete(id);
            await this.saveSessions();
            this._onDidChangeSessions.fire(undefined); // Undefined means "refresh all"
        }
    }

    public async updateSessionName(id: string, newName: string): Promise<ValidationSession | undefined> {
        const session = this.sessions.get(id);
        if (session) {
            session.name = newName;
            this.sessions.set(id, session);
            await this.saveSessions();
            this._onDidChangeSessions.fire(session);
            return session;
        }
        return undefined;
    }

    public async updateSessionReport(id: string, report: WebviewValidationReport): Promise<void> {
        const session = this.sessions.get(id);
        if (session) {
            session.lastValidationReport = report;
            this.sessions.set(id, session); // No need to save full report to workspaceState for now, too large
            // Only save if we decide to persist reports.
            this._onDidChangeSessions.fire(session); // Or just fire undefined to refresh the item
        }
    }

    public dispose() {
        this._onDidChangeSessions.dispose();
    }
}