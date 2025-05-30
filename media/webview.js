// media/webview.js
// @ts-ignore
// eslint-disable-next-line no-undef
const vscode = acquireVsCodeApi();

window.addEventListener("message", (event) => {
    const message = event.data; // The json data that the extension sent
    switch (message.command) {
        case "showReport":
            renderReport(message.report);
            break;
    }
});

function renderReport(report) {
    const conformsStatusEl = document.getElementById("conformsStatus");
    const dataFileEl = document.getElementById("dataFile");
    const shapesFileEl = document.getElementById("shapesFile");
    const tableBody = document.querySelector("#resultsTable tbody");
    const noViolationsMsgEl = document.getElementById("noViolationsMsg");
    const resultsTableContainer = document.getElementById("resultsTableContainer");
    const showRawReportBtn = document.getElementById("showRawReportBtn"); // Get the button

    if (
        !conformsStatusEl ||
        !tableBody ||
        !noViolationsMsgEl ||
        !resultsTableContainer ||
        !dataFileEl ||
        !shapesFileEl ||
        !showRawReportBtn // Ensure button is found
    ) {
        console.error("Could not find essential elements in webview DOM.");
        return;
    }

    conformsStatusEl.textContent = report.conforms ? "Yes" : "No";
    conformsStatusEl.style.color = report.conforms
        ? "var(--vscode-debugIcon-breakpointForeground)"
        : "var(--vscode-editorError-foreground)";
    dataFileEl.textContent = report.dataDocumentUri.substring(report.dataDocumentUri.lastIndexOf("/") + 1);
    shapesFileEl.textContent = report.shapesDocumentUri.substring(report.shapesDocumentUri.lastIndexOf("/") + 1);

    // Handle raw report button visibility and event listener
    if (report.rawReportTurtle && report.rawReportTurtle.trim() !== "") {
        showRawReportBtn.style.display = "block";
        // Clone the button and replace it to remove any existing listeners
        const newBtn = showRawReportBtn.cloneNode(true);
        showRawReportBtn.parentNode.replaceChild(newBtn, showRawReportBtn);
        // Add event listener to the new button
        newBtn.addEventListener("click", () => {
            vscode.postMessage({
                command: "showRawReport",
            });
        });
    } else {
        showRawReportBtn.style.display = "none";
    }

    // Clear previous results
    tableBody.innerHTML = "";

    if (report.conforms || !report.results || report.results.length === 0) {
        noViolationsMsgEl.style.display = "block";
        resultsTableContainer.style.display = "none";
    } else {
        noViolationsMsgEl.style.display = "none";
        resultsTableContainer.style.display = "block";

        report.results.forEach((result, index) => {
            const row = tableBody.insertRow();
            row.insertCell().textContent = (index + 1).toString();

            // Message (can be an array)
            const messageCell = row.insertCell();
            messageCell.textContent = Array.isArray(result.message) ? result.message.join("; ") : result.message;

            row.insertCell().textContent = termToString(result.severity, true);

            // Focus Node
            const focusNodeCell = row.insertCell();
            if (result.focusNode && result.focusNode.value) {
                const link = createJumpLink(result.focusNode.value, report.dataDocumentUri, result.focusNode.termType);
                focusNodeCell.appendChild(link);
            } else {
                focusNodeCell.textContent = "N/A";
            }

            // Source Shape
            const sourceShapeCell = row.insertCell();
            if (result.sourceShape && result.sourceShape.value) {
                const link = createJumpLink(
                    result.sourceShape.value,
                    report.shapesDocumentUri,
                    result.sourceShape.termType
                );
                sourceShapeCell.appendChild(link);
            } else {
                sourceShapeCell.textContent = "N/A";
            }

            row.insertCell().textContent = termToString(result.path, true); // Path is often a NamedNode or complex structure
            row.insertCell().textContent = termToString(result.sourceConstraintComponent, true);
            row.insertCell().textContent = termToString(result.value, true);
        });
    }
}

function termToString(term, simplify = false) {
    if (!term || !term.value) {
        return "N/A";
    }
    if (simplify && term.termType === "NamedNode") {
        // Show local name or last part of URI if possible
        const parts = term.value.split(/[/#]/);
        return parts[parts.length - 1] || term.value;
    }
    let displayValue = term.value;
    if (term.termType === "Literal") {
        displayValue = `"${term.value}"`;
        if (term.language) {
            displayValue += `@${term.language}`;
        }
        if (term.datatype && term.datatype.value) {
            const dtParts = term.datatype.value.split(/[/#]/);
            displayValue += `^^${dtParts[dtParts.length - 1]}`;
        }
    } else if (term.termType === "BlankNode") {
        displayValue = `_:${term.value}`;
    }
    return displayValue;
}

function createJumpLink(termString, targetUri, termType) {
    const link = document.createElement("a");
    link.href = "#";
    link.className = "jump-link";
    link.textContent = termToString({ value: termString, termType: termType }, true); // Simplify display
    link.title = `Jump to: ${termString} in ${targetUri.substring(targetUri.lastIndexOf("/") + 1)}`;
    link.addEventListener("click", (e) => {
        e.preventDefault();
        vscode.postMessage({
            command: "jumpToLocation",
            termString: termString,
            termType: termType,
            targetUri: targetUri,
        });
    });
    return link;
}
