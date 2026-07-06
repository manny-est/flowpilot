// ---------------------------------------------------------------------
// Redaction / sanitize module (Phase 9 refactor seam 1).
//
// Everything here is concatenated into the SAME enclosing closure as the
// rest of flowpilot-core.js (see lib/build-core-script.js) — these
// functions/vars are referenced directly by name from main.js and the
// other extracted modules, exactly as if this were still one file.
// Depends on `currentSettings` (declared in main.js) and the global `RED`
// (Node-RED's own editor API) — both reached via that shared closure, not
// passed in.
// ---------------------------------------------------------------------

    // ---------------------------------------------------------------------
    // Secret detection — shared by the node-selection sanitizer (below)
    // and the live debug-message redactor (next section). Two
    // complementary checks:
    //   - VALUE_SECRET_PATTERNS: the VALUE looks like a credential (bearer
    //     token, JWT, AWS key, high-entropy blob), regardless of field name.
    //   - SECRET_KEY: the field NAME looks secret-bearing (password, token,
    //     apiKey, ...) AND the value is a string long enough to plausibly be
    //     a real secret — short strings like `key: "ab"` or numbers like
    //     `keyCount: 3` are left alone.
    // Redaction is informative, not silent: placeholders carry the kind and
    // original length (`[redacted: bearer token, 211 chars]`) so the AI can
    // still reason about "an auth header was present" without seeing it.
    // ---------------------------------------------------------------------
    var SECRET_KEY = /pass|secret|token|apikey|api_key|key$|credential|auth|bearer/i;
    var SECRET_NAME_MIN_LEN = 8;

    var VALUE_SECRET_PATTERNS = [
        // Case-insensitive and tolerant of "Bearer: <token>" /
        // "bearer=<token>" variants, not just the strict HTTP-header form.
        { kind: "bearer token", re: /\bbearer\s*[:=]?\s+[A-Za-z0-9._\-]{8,}/i },
        // "Token <credential>" — same HTTP Authorization form used by Django REST
        // Framework and many other APIs. Case-sensitive: lowercase "token" is also
        // matched via SECRET_KEY's name-based check; this catches the value-shape.
        { kind: "token credential", re: /\bToken\s+[A-Za-z0-9._\-]{8,}/ },
        { kind: "JWT", re: /\beyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+/ },
        { kind: "AWS key", re: /\bAKIA[0-9A-Z]{16}\b/ },
        // Long high-entropy hex/base64-ish blob with no whitespace — catches
        // raw tokens/secrets that don't match a more specific pattern above.
        { kind: "token/secret", re: /^[A-Za-z0-9+/=_\-]{32,}$/ }
    ];

    function matchSecretValue(str) {
        for (var i = 0; i < VALUE_SECRET_PATTERNS.length; i++) {
            if (VALUE_SECRET_PATTERNS[i].re.test(str)) { return VALUE_SECRET_PATTERNS[i].kind; }
        }
        return null;
    }

    // Node-RED's "edit message properties" UI (Inject node's Properties list,
    // Change node's rules, etc.) stores each entry as
    // { p: "<property name>", v/to: "<value>", vt/tot: "<type>" } — the
    // secret-indicating NAME lives in `p`, but the secret VALUE lives in a
    // sibling `v`/`to` field. SECRET_KEY.test() against the object key alone
    // ("v"/"to") never matches, so a property literally named "auth" or
    // "apikey" sailed through untouched. Check `p` explicitly for these
    // known value-holding sibling keys.
    var DYNAMIC_PROPERTY_VALUE_KEYS = ["v", "to"];

    // Recursively redacts secret-shaped values out of a debug message / node
    // config value. `key` is the property name the value was found under
    // (undefined for array elements and the top-level value) — used only for
    // the name-based check. Structural data (numbers, booleans, short
    // strings, object/array shape) passes through untouched, preserving
    // diagnostic value.
    //
    // currentSettings.redactionEnabled defaults true (settings.json default,
    // and an empty {} before settings ever load) — explicitly opting OUT via
    // the type-to-confirm Settings toggle is required to disable this. The
    // Node-RED credentials field is a SEPARATE, always-on mechanism (dropped
    // entirely in sanitizeNode's INTERNAL_FIELDS) and is unaffected either way.
    function redactDebugValue(value, key) {
        if (currentSettings.redactionEnabled === false) { return value; }
        if (typeof value === "string") {
            var kind = matchSecretValue(value);
            if (kind) { return "[redacted: " + kind + ", " + value.length + " chars]"; }
            if (key !== undefined && SECRET_KEY.test(String(key)) && value.length > SECRET_NAME_MIN_LEN) {
                return "[redacted: secret field, " + value.length + " chars]";
            }
            return value;
        }
        if (Array.isArray(value)) {
            return value.map(function (v) { return redactDebugValue(v, key); });
        }
        if (value && typeof value === "object") {
            var out = {};
            var dynamicNameIsSecret = typeof value.p === "string" && SECRET_KEY.test(value.p);
            Object.keys(value).forEach(function (k) {
                if (dynamicNameIsSecret && DYNAMIC_PROPERTY_VALUE_KEYS.indexOf(k) !== -1 &&
                        typeof value[k] === "string" && value[k].length > SECRET_NAME_MIN_LEN) {
                    out[k] = "[redacted: secret field, " + value[k].length + " chars]";
                    return;
                }
                out[k] = redactDebugValue(value[k], k);
            });
            return out;
        }
        return value;
    }

    function truncateForDebug(text, max) {
        text = String(text);
        return text.length > max ? text.slice(0, max - 1) + "…" : text;
    }

    // Best-effort stringify for a debug message's value — may be any type
    // (string, number, object, undefined for "complete msg" mode where the
    // value lives one level down, etc.).
    function stringifyDebugValue(value) {
        if (typeof value === "string") { return value; }
        try { return JSON.stringify(value); } catch (e) { return String(value); }
    }

    // ---- Node-selection sanitizer ------------------------------------------
    // We read the user's current node selection and build a SANITIZED copy to
    // send to the AI. Two reasons we never send raw nodes:
    //   1. Node objects are proxies carrying editor-internal fields (geometry,
    //      validation state, i18n functions) that waste tokens and mean nothing
    //      to the model.
    //   2. Config nodes can hold secrets (broker passwords, API keys). We drop
    //      anything whose field name looks secret-bearing.
    // The user only ever sees how many nodes are attached, and nothing is sent
    // unless they have an active selection — staying within "user-initiated"
    // and "complete visibility".

    var INTERNAL_FIELDS = {
        _def: 1, _: 1, changed: 1, moved: 1, dirty: 1, selected: 1, valid: 1,
        validationErrors: 1, _index: 1, resize: 1, x: 1, y: 1, w: 1, h: 1, l: 1,
        __outputs: 1, inputs: 1, outputs: 1, g: 1, _config: 1, _orig: 1,
        credentials: 1
    };

    function sanitizeNode(n) {
        var out = {};
        Object.keys(n).forEach(function (k) {
            if (INTERNAL_FIELDS[k]) { return; }
            var v = n[k];
            if (typeof v === "function") { return; }
            // A secret-shaped field NAME (password/token/apikey/auth/...) only
            // means "redact" when the value is itself a string long enough to
            // plausibly BE a secret. Short strings under such names are usually
            // enum/selector fields (e.g. an HTTP request node's authType:
            // "basic"/"bearer"/"digest"/"") — hiding those gives the model no
            // way to reason about (or fix) auth configuration while protecting
            // nothing. Real credential VALUES are already excluded entirely via
            // INTERNAL_FIELDS.credentials.
            if (currentSettings.redactionEnabled !== false &&
                    SECRET_KEY.test(k) && typeof v === "string" && v.length > SECRET_NAME_MIN_LEN) {
                out[k] = "[redacted: secret field, " + v.length + " chars]";
                return;
            }
            // JSON round-trip strips the proxy wrapper and drops anything
            // non-serializable, leaving plain config values (incl. props).
            try { v = JSON.parse(JSON.stringify(v)); }
            catch (e) { out[k] = "[unserializable]"; return; }
            // Defense-in-depth: catch secrets hiding in objects/arrays under a
            // secret-shaped name (recurses and redacts only the actual secret
            // sub-fields), or in an innocuously-named field by value shape
            // (e.g. a "data" field holding a JWT).
            out[k] = redactDebugValue(v, k);
        });
        // "g" itself (the bare group id) is skipped above like x/y/w/h —
        // meaningless to the model on its own. But WHICH group a node
        // belongs to, and that group's name, is real semantic information
        // (Phase 8.5 C2) — resolve it via RED.nodes.group(), one level
        // deep only (a node's immediate group, not its ancestor chain if
        // nested groups are in play). Distinct from buildConnections()'s
        // "subFlow" numbering below, which is connectivity-based ("are
        // these wired together"), not an actual visual group.
        if (n.g && RED.nodes.group) {
            var grp = RED.nodes.group(n.g);
            if (grp) { out.group = { id: grp.id, name: grp.name || "" }; }
        }
        return out;
    }
