import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, hoverTooltip } from "https://esm.sh/@codemirror/view@6";
import { EditorState } from "https://esm.sh/@codemirror/state@6";
import { StreamLanguage } from "https://esm.sh/@codemirror/language@6";
import { defaultKeymap, history, historyKeymap } from "https://esm.sh/@codemirror/commands@6";
import { oneDark } from "https://esm.sh/@codemirror/theme-one-dark@6";
import { linter } from "https://esm.sh/@codemirror/lint@6";
import { autocompletion } from "https://esm.sh/@codemirror/autocomplete@6";

// SNGL language mode for CodeMirror
const snglMode = {
    startState() {
        return { inBlockComment: false };
    },
    token(stream, state) {
        if (state.inBlockComment) {
            if (stream.skipTo("*/")) {
                stream.next(); stream.next();
                state.inBlockComment = false;
            } else {
                stream.skipToEnd();
            }
            return "comment";
        }
        if (stream.match("/*")) {
            state.inBlockComment = true;
            return "comment";
        }
        if (stream.match("//")) {
            stream.skipToEnd();
            return "comment";
        }
        if (stream.match('"')) {
            while (!stream.eol()) {
                if (stream.next() === '"') break;
            }
            return "string";
        }
        if (stream.match("'")) {
            while (!stream.eol()) {
                if (stream.next() === "'") break;
            }
            return "string";
        }
        if (stream.match(/#[0-9a-fA-F]{3,8}\b/)) return "color";
        if (stream.match(/#(true|false|null)\b/)) return "atom";
        if (stream.match(/[0-9]+(\.[0-9]+)?/)) return "number";
        if (stream.match(/[a-zA-Z_@][a-zA-Z0-9_.-]*/)) {
            const w = stream.current();
            if (/^(component|param|var|computed|if|else|for|import|struct|enum|output|data|app|styles)$/.test(w)) return "keyword";
            if (/^(vbox|hbox|stack|text|button|input|checkbox|image|scroll|spacer)$/.test(w)) return "builtin";
            if (/^(string|int|float|bool|list|map)$/.test(w)) return "type";
            if (w.startsWith("@")) return "meta";
            return "variable";
        }
        if (stream.match(/[{}()\[\]]/)) return "bracket";
        if (stream.match(/[=<>!&|+\-*/]+/)) return "operator";
        stream.next();
        return null;
    },
};

let editor;
let wasmReady = false;
let debounceTimer;
let activeTab = "preview";

const statusEl = document.getElementById("status");
const errorEl = document.getElementById("error");
const previewEl = document.getElementById("preview");
const astEl = document.getElementById("ast-output");
const codeEl = document.getElementById("code-output");
const targetSelect = document.getElementById("target-select");

// Decode source from URL hash or use default
function getInitialSource() {
    const hash = location.hash;
    if (hash.startsWith("#source=")) {
        try {
            return atob(hash.slice(8));
        } catch { /* fall through */ }
    }
    const el = document.getElementById("default-source");
    return el ? el.textContent.trim() : "";
}

// --- Linter extension ---
const snglLinter = linter((view) => {
    if (!wasmReady) return [];
    const src = view.state.doc.toString();
    const rawDiags = window.snglDiagnostics(src);
    const diagnostics = [];
    const len = rawDiags.length;
    for (let i = 0; i < len; i++) {
        const d = rawDiags[i];
        const from = lineColToOffset(view.state.doc, d.line, d.col);
        const to = lineColToOffset(view.state.doc, d.endLine, d.endCol);
        const severityMap = { 1: "error", 2: "warning", 3: "info", 4: "hint" };
        diagnostics.push({
            from,
            to: Math.max(to, from + 1),
            severity: severityMap[d.severity] || "error",
            message: d.message,
        });
    }
    return diagnostics;
}, { delay: 500 });

function lineColToOffset(doc, line, col) {
    // line and col are 0-based from lspcore
    if (line < 0) line = 0;
    if (line >= doc.lines) line = doc.lines - 1;
    const lineObj = doc.line(line + 1); // doc.line is 1-based
    return Math.min(lineObj.from + col, lineObj.to);
}

// --- Autocompletion ---
function snglCompletionSource(context) {
    if (!wasmReady) return null;
    const word = context.matchBefore(/[\w@.-]*/);
    if (!word || (word.from === word.to && !context.explicit)) return null;

    const pos = context.state.doc.lineAt(context.pos);
    const line = pos.number;   // 1-based
    const col = context.pos - pos.from + 1; // 1-based

    const src = context.state.doc.toString();
    const rawItems = window.snglComplete(src, line, col);
    const items = rawItems;

    // Map CIK constants to CodeMirror types
    const kindMap = {
        1: "text", 2: "method", 3: "function", 5: "property",
        6: "variable", 7: "class", 8: "interface", 9: "namespace",
        10: "property", 12: "value", 13: "enum", 14: "keyword",
        15: "text", 16: "constant", 20: "enum", 21: "constant",
        22: "class", 23: "variable",
    };

    const options = [];
    const len = items.length;
    for (let i = 0; i < len; i++) {
        const item = items[i];
        options.push({
            label: item.label,
            type: kindMap[item.kind] || "text",
            detail: item.detail || undefined,
            apply: item.insertText || undefined,
        });
    }

    return { from: word.from, options };
}

// --- Hover tooltip ---
const snglHoverTooltip = hoverTooltip((view, pos) => {
    if (!wasmReady) return null;
    const line = view.state.doc.lineAt(pos);
    const lineNum = line.number; // 1-based
    const col = pos - line.from + 1; // 1-based

    const src = view.state.doc.toString();
    const result = window.snglHover(src, lineNum, col);
    if (!result.content) return null;

    return {
        pos,
        above: true,
        create() {
            const dom = document.createElement("div");
            dom.className = "sngl-hover";
            dom.innerHTML = renderMarkdown(result.content);
            return { dom };
        },
    };
});

function renderMarkdown(md) {
    // Minimal markdown: fenced code blocks, bold, inline code
    let html = md;
    // Fenced code blocks
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
        const escaped = code.replace(/</g, "&lt;").replace(/>/g, "&gt;");
        return `<pre><code class="language-${lang || "text"}">${escaped}</code></pre>`;
    });
    // Bold
    html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    // Inline code
    html = html.replace(/`([^`]+)`/g, (_, code) => {
        const escaped = code.replace(/</g, "&lt;").replace(/>/g, "&gt;");
        return `<code>${escaped}</code>`;
    });
    // Line breaks (for list items)
    html = html.replace(/\n- /g, "<br>- ");
    html = html.replace(/\n/g, "<br>");
    return html;
}

// Init CodeMirror
const source = getInitialSource();
editor = new EditorView({
    state: EditorState.create({
        doc: source,
        extensions: [
            lineNumbers(),
            highlightActiveLine(),
            highlightActiveLineGutter(),
            history(),
            keymap.of([...defaultKeymap, ...historyKeymap]),
            StreamLanguage.define(snglMode),
            oneDark,
            snglLinter,
            autocompletion({ override: [snglCompletionSource] }),
            snglHoverTooltip,
            EditorView.updateListener.of((update) => {
                if (update.docChanged) scheduleCompile();
            }),
        ],
    }),
    parent: document.getElementById("editor-pane"),
});

// Tab switching
document.querySelector(".tab-bar").addEventListener("click", (e) => {
    const tab = e.target.dataset?.tab;
    if (!tab) return;
    activeTab = tab;
    document.querySelectorAll(".tab-bar button").forEach(b =>
        b.classList.toggle("active", b.dataset.tab === tab));
    document.querySelectorAll(".tab-panel").forEach(p =>
        p.classList.toggle("active", p.id === `tab-${tab}`));
    if (tab === "ast") renderAST();
    if (tab === "code") renderCode();
});

// Examples dropdown
document.getElementById("examples").addEventListener("change", (e) => {
    const val = e.target.value;
    if (!val) return;
    // Try name-specific source first, fall back to default-source
    const el = document.getElementById(val + "-source") || document.getElementById("default-source");
    if (el) {
        editor.dispatch({
            changes: { from: 0, to: editor.state.doc.length, insert: el.textContent.trim() },
        });
    }
    e.target.value = "";
});

// Target selector change
targetSelect.addEventListener("change", () => {
    renderCode();
});

function scheduleCompile() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(doCompile, 300);
}

function doCompile() {
    if (!wasmReady) return;
    const src = editor.state.doc.toString();

    // Update URL hash
    try { history.replaceState(null, "", "#source=" + btoa(src)); } catch { /* ignore */ }

    const result = window.snglCompile(src);
    if (result.error) {
        errorEl.textContent = result.error;
        errorEl.classList.add("visible");
        previewEl.removeAttribute("srcdoc");
    } else {
        errorEl.classList.remove("visible");
        previewEl.srcdoc = result.html;
    }

    if (activeTab === "ast") renderAST();
    if (activeTab === "code") renderCode();
}

// --- Code tab ---

const langToprism = { "js": "javascript", "go": "go" };

function renderCode() {
    if (!wasmReady) return;
    const selected = targetSelect.value;
    if (!selected) return;
    const [platform, lang] = selected.split("/");
    const src = editor.state.doc.toString();
    const result = window.snglGenerate(src, platform, lang);

    const codeNode = codeEl.querySelector("code");
    if (result.error) {
        codeNode.className = "";
        codeNode.textContent = "Error: " + result.error;
        return;
    }

    const files = result.files;
    let output = "";
    const len = files ? files.length : 0;
    for (let i = 0; i < len; i++) {
        const f = files[i];
        if (len > 1) {
            output += (i > 0 ? "\n" : "") + "// === " + f.name + " ===\n";
        }
        output += f.content;
    }

    const prismLang = langToprism[lang] || "markup";
    codeNode.className = "language-" + prismLang;
    codeNode.textContent = output;
    if (window.Prism) {
        Prism.highlightElement(codeNode);
    }
}

function populateTargets() {
    const targets = window.snglTargets();
    const len = targets.length;
    for (let i = 0; i < len; i++) {
        const t = targets[i];
        const opt = document.createElement("option");
        opt.value = t.platform + "/" + t.lang;
        opt.textContent = t.platform + " / " + t.lang;
        targetSelect.appendChild(opt);
    }
}

// --- AST tab (collapsible) ---

function renderAST() {
    if (!wasmReady) return;
    const src = editor.state.doc.toString();
    const result = window.snglAST(src);
    astEl.innerHTML = "";
    if (result.error) {
        astEl.textContent = "Error: " + result.error;
        return;
    }
    try {
        const obj = JSON.parse(result.ast);
        astEl.appendChild(buildASTTree(obj, 0));
    } catch (e) {
        astEl.textContent = result.ast;
    }
}

function buildASTTree(value, depth) {
    if (value === null || value === undefined) {
        const span = document.createElement("span");
        span.className = "ast-null";
        span.textContent = "null";
        return span;
    }

    if (Array.isArray(value)) {
        if (value.length === 0) return null;
        const details = document.createElement("details");
        if (depth < 2) details.open = true;
        const summary = document.createElement("summary");
        summary.textContent = `[${value.length}]`;
        details.appendChild(summary);
        for (let i = 0; i < value.length; i++) {
            const child = buildASTNode(String(i), value[i], depth + 1);
            if (child) details.appendChild(child);
        }
        return details;
    }

    if (typeof value === "object") {
        const details = document.createElement("details");
        if (depth < 2) details.open = true;
        const summary = document.createElement("summary");
        const keys = Object.keys(value);
        // Use Name or Type as label if available
        const label = value.Name || value.Type || "{...}";
        summary.textContent = label;
        details.appendChild(summary);
        for (const key of keys) {
            if (value[key] === null || (Array.isArray(value[key]) && value[key].length === 0)) continue;
            const child = buildASTNode(key, value[key], depth + 1);
            if (child) details.appendChild(child);
        }
        return details;
    }

    // Primitive
    return buildLeaf(value);
}

function buildASTNode(key, value, depth) {
    if (value === null || value === undefined) return null;
    if (Array.isArray(value) && value.length === 0) return null;

    if (typeof value === "object") {
        const wrapper = document.createElement("div");
        wrapper.className = "ast-node";
        const keySpan = document.createElement("span");
        keySpan.className = "ast-key";
        keySpan.textContent = key + ": ";
        const tree = buildASTTree(value, depth);
        if (!tree) return null;
        // Inline the key into the summary if it's a details element
        if (tree.tagName === "DETAILS") {
            const summary = tree.querySelector("summary");
            summary.textContent = key + ": " + summary.textContent;
            return tree;
        }
        wrapper.appendChild(keySpan);
        wrapper.appendChild(tree);
        return wrapper;
    }

    const div = document.createElement("div");
    div.className = "ast-leaf";
    const keySpan = document.createElement("span");
    keySpan.className = "ast-key";
    keySpan.textContent = key + ": ";
    div.appendChild(keySpan);
    div.appendChild(buildLeaf(value));
    return div;
}

function buildLeaf(value) {
    const span = document.createElement("span");
    if (typeof value === "string") {
        span.className = "ast-string";
        span.textContent = JSON.stringify(value);
    } else if (typeof value === "number") {
        span.className = "ast-number";
        span.textContent = String(value);
    } else if (typeof value === "boolean") {
        span.className = "ast-bool";
        span.textContent = String(value);
    } else {
        span.className = "ast-null";
        span.textContent = "null";
    }
    return span;
}

// Load WASM
async function initWasm() {
    const go = new Go();
    const result = await WebAssembly.instantiateStreaming(
        fetch("assets/playground/sngl.wasm"),
        go.importObject,
    );
    go.run(result.instance);
    wasmReady = true;
    statusEl.textContent = "Ready";
    populateTargets();
    doCompile();
}

initWasm().catch((err) => {
    statusEl.textContent = "WASM load failed";
    errorEl.textContent = err.message;
    errorEl.classList.add("visible");
});
