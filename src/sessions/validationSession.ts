// src/sessions/validationSession.ts
import * as vscode from 'vscode';
import { WebviewValidationReport } from '../webview/validationResultsViewProvider'; // Adjust path if needed

export interface ValidationSession {
    id: string; // Unique ID (e.g., timestamp or UUID)
    name: string; // User-friendly name
    dataGraphUri: vscode.Uri;
    shapesGraphUri: vscode.Uri;
    lastValidationReport?: WebviewValidationReport;
    createdAt: number; // Store as timestamp for easier sorting/display
    dataGraphFileName?: string; // For display
    shapesGraphFileName?: string; // For display
}