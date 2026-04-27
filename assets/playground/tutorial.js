import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, hoverTooltip } from "https://esm.sh/@codemirror/view@6";
import { EditorState } from "https://esm.sh/@codemirror/state@6";
import { StreamLanguage } from "https://esm.sh/@codemirror/language@6";
import { defaultKeymap, history, historyKeymap } from "https://esm.sh/@codemirror/commands@6";
import { oneDark } from "https://esm.sh/@codemirror/theme-one-dark@6";
import { linter } from "https://esm.sh/@codemirror/lint@6";
import { autocompletion } from "https://esm.sh/@codemirror/autocomplete@6";

// Minimal SNGL mode mirroring playground.js. Keeping a copy here avoids a
// hard cross-module coupling between the two entry points.
const snglMode = {
    startState() { return { inBlockComment: false }; },
    token(stream, state) {
        if (state.inBlockComment) {
            if (stream.skipTo("*/")) { stream.next(); stream.next(); state.inBlockComment = false; }
            else { stream.skipToEnd(); }
            return "comment";
        }
        if (stream.match("/*")) { state.inBlockComment = true; return "comment"; }
        if (stream.match("//")) { stream.skipToEnd(); return "comment"; }
        if (stream.match('"')) { while (!stream.eol()) { if (stream.next() === '"') break; } return "string"; }
        if (stream.match(/#[0-9a-fA-F]{3,8}\b/)) return "color";
        if (stream.match(/[0-9]+(\.[0-9]+)?/)) return "number";
        if (stream.match(/[a-zA-Z_@][a-zA-Z0-9_.-]*/)) {
            const w = stream.current();
            if (/^(component|param|var|computed|if|else|for|import|struct|enum|output|const|func|return|platform|timer)$/.test(w)) return "keyword";
            if (/^(vbox|hbox|stack|text|button|input|checkbox|image|scroll|spacer|timer|slot)$/.test(w)) return "builtin";
            if (/^(string|int|float|bool|list|map|color|duration|measurement)$/.test(w)) return "type";
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
let currentSlug = "";

const statusEl = document.getElementById("status");
const errorEl = document.getElementById("error");
const previewEl = document.getElementById("preview");
const proseEl = document.getElementById("lesson-prose");
const titleEl = document.getElementById("lesson-title");

function lineColToOffset(doc, line, col) {
    if (line < 0) line = 0;
    if (line >= doc.lines) line = doc.lines - 1;
    const lineObj = doc.line(line + 1);
    return Math.min(lineObj.from + col, lineObj.to);
}

const snglLinter = linter((view) => {
    if (!wasmReady) return [];
    const src = view.state.doc.toString();
    const rawDiags = window.snglDiagnostics(src);
    const out = [];
    const severityMap = { 1: "error", 2: "warning", 3: "info", 4: "hint" };
    for (let i = 0; i < rawDiags.length; i++) {
        const d = rawDiags[i];
        const from = lineColToOffset(view.state.doc, d.line, d.col);
        const to = lineColToOffset(view.state.doc, d.endLine, d.endCol);
        out.push({ from, to: Math.max(to, from + 1), severity: severityMap[d.severity] || "error", message: d.message });
    }
    return out;
}, { delay: 400 });

function snglCompletion(context) {
    if (!wasmReady) return null;
    const word = context.matchBefore(/[\w@.-]*/);
    if (!word || (word.from === word.to && !context.explicit)) return null;
    const pos = context.state.doc.lineAt(context.pos);
    const src = context.state.doc.toString();
    const items = window.snglComplete(src, pos.number, context.pos - pos.from + 1);
    const kindMap = { 1: "text", 2: "method", 3: "function", 5: "property", 6: "variable", 7: "class", 8: "interface", 9: "namespace", 14: "keyword" };
    const options = items.map((it) => ({
        label: it.label,
        type: kindMap[it.kind] || "text",
        detail: it.detail || undefined,
        apply: it.insertText || undefined,
    }));
    return { from: word.from, options };
}

const snglHover = hoverTooltip((view, pos) => {
    if (!wasmReady) return null;
    const line = view.state.doc.lineAt(pos);
    const result = window.snglHover(view.state.doc.toString(), line.number, pos - line.from + 1);
    if (!result.content) return null;
    return {
        pos,
        above: true,
        create() {
            const dom = document.createElement("div");
            dom.className = "sngl-hover";
            dom.textContent = result.content;
            return { dom };
        },
    };
});

function createEditor(parent, initial) {
    return new EditorView({
        state: EditorState.create({
            doc: initial,
            extensions: [
                lineNumbers(),
                highlightActiveLine(),
                highlightActiveLineGutter(),
                history(),
                keymap.of([...defaultKeymap, ...historyKeymap]),
                StreamLanguage.define(snglMode),
                oneDark,
                snglLinter,
                autocompletion({ override: [snglCompletion] }),
                snglHover,
                EditorView.updateListener.of((u) => { if (u.docChanged) scheduleCompile(); }),
            ],
        }),
        parent,
    });
}

function lessonBodyHTML(slug) {
    const tmpl = document.getElementById("lesson-prose-" + slug);
    return tmpl ? tmpl.innerHTML : "";
}

function lessonCode(slug) {
    const s = document.getElementById("lesson-code-" + slug);
    return s ? s.textContent.trim() : "";
}

function hrefForSlug(slug) { return "#lesson=" + slug; }

function slugFromHref(href) {
    const m = /^#lesson=(.+)$/.exec(href || "");
    return m ? m[1] : "";
}

function lessonTitle(slug) {
    const href = hrefForSlug(slug);
    const a = document.querySelector(`#lesson-nav a[href="${href}"]`);
    return a ? a.textContent : slug;
}

function firstLessonSlug() {
    const first = document.querySelector('#lesson-nav a[href^="#lesson="]');
    return first ? slugFromHref(first.getAttribute("href")) : "";
}

function loadLesson(slug) {
    if (!slug) slug = firstLessonSlug();
    const code = lessonCode(slug);
    if (!code) return;
    currentSlug = slug;
    proseEl.innerHTML = lessonBodyHTML(slug);
    if (titleEl) titleEl.textContent = lessonTitle(slug);
    const activeHref = hrefForSlug(slug);
    document.querySelectorAll('#lesson-nav a[href^="#lesson="]').forEach((a) => {
        a.classList.toggle("active", a.getAttribute("href") === activeHref);
    });
    errorEl.classList.remove("visible");
    previewEl.removeAttribute("srcdoc");
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: code } });
}

function parseHashSlug() {
    const h = location.hash;
    if (h.startsWith("#lesson=")) return h.slice(8);
    return "";
}

function scheduleCompile() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(doCompile, 300);
}

function doCompile() {
    if (!wasmReady) return;
    const src = editor.state.doc.toString();
    const result = window.snglCompile(src);
    if (result.error) {
        errorEl.textContent = result.error;
        errorEl.classList.add("visible");
        // Intentionally keep the previous srcdoc so the preview stays visible
        // while the user corrects their syntax.
    } else {
        errorEl.classList.remove("visible");
        previewEl.srcdoc = result.html;
    }
}

// Wire up sidebar clicks.
document.addEventListener("click", (e) => {
    const a = e.target.closest('#lesson-nav a[href^="#lesson="]');
    if (!a) return;
    e.preventDefault();
    location.hash = a.getAttribute("href");
});

window.addEventListener("hashchange", () => loadLesson(parseHashSlug()));

// Init editor + WASM.
editor = createEditor(document.getElementById("editor-pane"), "");

async function initWasm() {
    const go = new Go();
    const result = await WebAssembly.instantiateStreaming(
        fetch("assets/playground/sngl.wasm"),
        go.importObject,
    );
    go.run(result.instance);
    wasmReady = true;
    if (statusEl) statusEl.textContent = "Ready";
    loadLesson(parseHashSlug());
}

initWasm().catch((err) => {
    if (statusEl) statusEl.textContent = "WASM load failed";
    errorEl.textContent = err.message;
    errorEl.classList.add("visible");
});
