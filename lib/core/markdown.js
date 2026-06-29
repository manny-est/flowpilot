// ---------------------------------------------------------------------
// Markdown rendering module (Phase 9 refactor seam 4).
//
// Concatenated into the same shared closure as the rest of
// flowpilot-core.js (see lib/build-core-script.js). Fully self-contained
// pure functions plus one private counter (nextCodeBlockId) - nothing
// here depends on state declared elsewhere, and only renderMarkdown
// itself is called from outside this module.
// ---------------------------------------------------------------------

    // ---- Markdown rendering -----------------------------------------------
    // Chat bubbles render a small, safe subset of markdown. All text is
    // HTML-escaped before any tags are introduced, and only the fixed set of
    // tags this code itself emits ever reaches the DOM — raw HTML from the
    // model or the user is never interpreted, so no separate HTML sanitizer
    // (e.g. DOMPurify) is needed.
    function escapeHtml(str) {
        return String(str)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }

    // Inline markdown within a single (already-escaped) line: `code`,
    // **bold**, *italic*, and [text](http(s) url) links. Code spans are
    // split out first so their contents are immune to further markup.
    function renderInlineMarkdown(escaped) {
        var parts = escaped.split(/(`[^`]+`)/);
        return parts.map(function (part, i) {
            if (i % 2 === 1) {
                return "<code>" + part.slice(1, -1) + "</code>";
            }
            return part
                .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
                .replace(/\*([^*]+)\*/g, "<em>$1</em>")
                .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
        }).join("");
    }

    // Unique per-block id so the delegated copy-button handler (bound once,
    // see content.find("#fp-messages").on("click", ".fp-code-copy", ...))
    // can find the right <pre> — chat messages are injected as raw HTML
    // strings via .html(), so a per-element .on() bind at construction time
    // isn't possible here the way it is for the Generate review panel's
    // JSON-tab copy button.
    var nextCodeBlockId = 1;

    // GFM table helpers, used by renderMarkdown below.
    function isTableSeparatorRow(line) {
        var trimmed = line.trim();
        if (!trimmed) { return false; }
        return /^\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?$/.test(trimmed);
    }

    function splitTableRow(line) {
        var trimmed = line.trim();
        if (trimmed.charAt(0) === "|") { trimmed = trimmed.slice(1); }
        if (trimmed.charAt(trimmed.length - 1) === "|") { trimmed = trimmed.slice(0, -1); }
        return trimmed.split("|").map(function (c) { return c.trim(); });
    }

    // Block-level markdown: fenced code blocks, headings, tables,
    // bullet/numbered lists, and paragraphs (consecutive lines joined with
    // <br>).
    function renderMarkdown(raw) {
        var lines = String(raw || "").split("\n");
        var html = "";
        var listType = null;
        var paraLines = [];

        function flushPara() {
            if (paraLines.length) {
                html += "<p>" + paraLines.map(function (l) {
                    return renderInlineMarkdown(escapeHtml(l));
                }).join("<br>") + "</p>";
                paraLines = [];
            }
        }
        function closeList() {
            if (listType) { html += "</" + listType + ">"; listType = null; }
        }

        var i = 0;
        while (i < lines.length) {
            var line = lines[i];

            // Leading whitespace allowed: models commonly indent a fenced
            // block nested under a numbered/bulleted list item (e.g. "1. Try
            // this:\n   ```bash\n   curl ...\n   ```"). An anchored-at-column-0
            // regex misses that entirely, so the fence markers and everything
            // inside fall through to plain paragraph text instead of a code
            // block — exactly the "code blocks failed to load" bug.
            var fence = line.match(/^\s*```(\w*)\s*$/);
            if (fence) {
                flushPara(); closeList();
                var codeLines = [];
                i++;
                while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
                    codeLines.push(lines[i]);
                    i++;
                }
                var codeBlockId = "fp-code-" + (nextCodeBlockId++);
                html += "<div class=\"fp-code-toolbar\">" +
                    "<button class=\"fp-code-copy red-ui-button red-ui-button-small\" type=\"button\" data-code-id=\"" + codeBlockId + "\">Copy</button>" +
                    "</div>" +
                    "<pre id=\"" + codeBlockId + "\"><code>" + escapeHtml(codeLines.join("\n")) + "</code></pre>";
                i++;
                continue;
            }

            var heading = line.match(/^(#{1,6})\s+(.*)$/);
            if (heading) {
                flushPara(); closeList();
                var level = Math.min(6, heading[1].length + 2);
                html += "<h" + level + ">" + renderInlineMarkdown(escapeHtml(heading[2])) + "</h" + level + ">";
                i++;
                continue;
            }

            // GFM-style pipe table: a header row immediately followed by a
            // separator row (---/:--/--:), then zero or more body rows. Models
            // reach for tables constantly in comparison-style answers; without
            // this, every row just fell through to a paragraph line, showing
            // the raw "| a | b |" syntax verbatim.
            if (line.indexOf("|") !== -1 && i + 1 < lines.length && isTableSeparatorRow(lines[i + 1])) {
                flushPara(); closeList();
                var headerCells = splitTableRow(line);
                i += 2;
                var bodyRows = [];
                while (i < lines.length && lines[i].trim() && lines[i].indexOf("|") !== -1) {
                    bodyRows.push(splitTableRow(lines[i]));
                    i++;
                }
                html += "<table><thead><tr>" +
                    headerCells.map(function (c) {
                        return "<th>" + renderInlineMarkdown(escapeHtml(c)) + "</th>";
                    }).join("") +
                    "</tr></thead><tbody>" +
                    bodyRows.map(function (row) {
                        return "<tr>" + row.map(function (c) {
                            return "<td>" + renderInlineMarkdown(escapeHtml(c)) + "</td>";
                        }).join("") + "</tr>";
                    }).join("") +
                    "</tbody></table>";
                continue;
            }

            var bullet = line.match(/^\s*[-*]\s+(.*)$/);
            if (bullet) {
                flushPara();
                if (listType !== "ul") { closeList(); html += "<ul>"; listType = "ul"; }
                html += "<li>" + renderInlineMarkdown(escapeHtml(bullet[1])) + "</li>";
                i++;
                continue;
            }

            var numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
            if (numbered) {
                flushPara();
                if (listType !== "ol") { closeList(); html += "<ol>"; listType = "ol"; }
                html += "<li>" + renderInlineMarkdown(escapeHtml(numbered[1])) + "</li>";
                i++;
                continue;
            }

            flushPara(); closeList();

            if (line.trim()) { paraLines.push(line); }
            i++;
        }
        flushPara(); closeList();
        return html;
    }
