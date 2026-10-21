// Minimal Jinja2-compatible template renderer.
// Scope (intentionally narrow, matches this project's templates):
//   {{ dotted.path }}                     -> HTML-escaped output (Jinja2 autoescape parity)
//   {% for x in dotted.path %}...{% endfor %}
//   {% if a == 'lit' and b %}...{% else %}...{% endif %}
// Anything else raises at compile time so template drift is caught loudly.

const STMT_RE = /\{%\s*(.+?)\s*%\}|\{\{\s*(.+?)\s*\}\}/g;

function getPath(ctx, dotted) {
  let cur = ctx;
  for (const part of dotted.split(".")) {
    if (cur == null) return undefined;
    cur = cur[part];
  }
  return cur;
}

function escapeHtml(v) {
  const s = v == null ? "" : String(v);
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isTruthy(v) {
  return v !== undefined && v !== null && v !== "" && v !== false && v !== 0;
}

// "item.icon == 'fav' and item.icon_url" -> JS boolean expression over __c
function condToJs(expr) {
  return expr
    .split(/\s+and\s+/)
    .map((part) => {
      const t = part.trim();
      let m;
      if ((m = t.match(/^([\w.]+)\s*==\s*(['"])(.*?)\2$/))) {
        return `getPath(__c, ${JSON.stringify(m[1])}) === ${JSON.stringify(m[3])}`;
      }
      if ((m = t.match(/^([\w.]+)\s*!=\s*(['"])(.*?)\2$/))) {
        return `getPath(__c, ${JSON.stringify(m[1])}) !== ${JSON.stringify(m[3])}`;
      }
      return `isTruthy(getPath(__c, ${JSON.stringify(t)}))`;
    })
    .join(" && ");
}

const compileCache = new Map();

function compile(tplSource) {
  const cached = compileCache.get(tplSource);
  if (cached) return cached;

  // Jinja2 parity: keep_trailing_newline defaults to False (drops one final newline)
  const tpl = tplSource.replace(/\n$/, "");

  const lines = [];
  const pushText = (t) => {
    if (t) lines.push(`__out += ${JSON.stringify(t)};`);
  };

  STMT_RE.lastIndex = 0;
  let last = 0;
  let m;
  while ((m = STMT_RE.exec(tpl)) !== null) {
    pushText(tpl.slice(last, m.index));
    last = STMT_RE.lastIndex;

    if (m[2] !== undefined) {
      lines.push(`__out += __e(getPath(__c, ${JSON.stringify(m[2].trim())}));`);
      continue;
    }

    const stmt = m[1].trim();
    let fm;
    if ((fm = stmt.match(/^for\s+(\w+)\s+in\s+([\w.]+)$/))) {
      lines.push(
        `{ const __prev = __c; const __seq = getPath(__c, ${JSON.stringify(fm[2])});` +
        ` if (Array.isArray(__seq)) for (const ${fm[1]} of __seq) {` +
        ` __c = Object.assign({}, __prev, { ${fm[1]}: ${fm[1]} });`
      );
    } else if (stmt === "endfor") {
      lines.push(`} __c = __prev; }`);
    } else if ((fm = stmt.match(/^if\s+(.+)$/))) {
      lines.push(`if (${condToJs(fm[1])}) {`);
    } else if (stmt === "else") {
      lines.push(`} else {`);
    } else if (stmt === "endif") {
      lines.push(`}`);
    } else {
      throw new Error("jinja.js: unsupported statement: " + stmt);
    }
  }
  pushText(tpl.slice(last));

  const fn = new Function("__c", "__e", "getPath", "isTruthy", "var __out = '';\n" + lines.join("\n") + "\nreturn __out;");
  compileCache.set(tpl, fn);
  return fn;
}

export function render(tpl, ctx) {
  return compile(tpl)(ctx, escapeHtml, getPath, isTruthy);
}
