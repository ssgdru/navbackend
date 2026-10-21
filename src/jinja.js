// Minimal Jinja2-compatible template renderer.
// IMPLEMENTATION NOTE: purely interpretive (tokenize -> node tree -> recursive render).
// No eval / new Function — Cloudflare Workers disallow dynamic code generation.
// Scope (intentionally narrow, matches this project's templates):
//   {{ dotted.path }}                     -> HTML-escaped output (Jinja2 autoescape parity)
//   {% for x in dotted.path %}...{% endfor %}
//   {% if a == 'lit' and b %}...{% else %}...{% endif %}
// Jinja2 parity: keep_trailing_newline=False (one final newline dropped),
// undefined renders as empty string, truthiness excludes null/undefined/""/false/0.
// Anything unsupported raises at parse time so template drift is caught loudly.

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

// cond -> [{op:"==",left,right} | {op:"!=",left,right} | {op:"truthy",left}], joined by AND
function parseCond(expr) {
  return expr
    .split(/\s+and\s+/)
    .map((part) => {
      const t = part.trim();
      let m;
      if ((m = t.match(/^([\w.]+)\s*==\s*(['"])(.*?)\2$/))) {
        return { op: "==", left: m[1], right: m[3] };
      }
      if ((m = t.match(/^([\w.]+)\s*!=\s*(['"])(.*?)\2$/))) {
        return { op: "!=", left: m[1], right: m[3] };
      }
      return { op: "truthy", left: t };
    });
}

function evalCond(cond, ctx) {
  return parseCond(cond).every((c) => {
    const v = getPath(ctx, c.left);
    if (c.op === "==") return v === c.right;
    if (c.op === "!=") return v !== c.right;
    return isTruthy(v);
  });
}

function tokenize(tpl) {
  const tokens = [];
  STMT_RE.lastIndex = 0;
  let last = 0;
  let m;
  while ((m = STMT_RE.exec(tpl)) !== null) {
    if (m.index > last) tokens.push({ type: "text", value: tpl.slice(last, m.index) });
    last = STMT_RE.lastIndex;
    if (m[2] !== undefined) tokens.push({ type: "var", path: m[2].trim() });
    else tokens.push({ type: "stmt", stmt: m[1].trim() });
  }
  if (last < tpl.length) tokens.push({ type: "text", value: tpl.slice(last) });
  return tokens;
}

// token stream -> node tree
// nodes: {type:"text",value} | {type:"var",path} |
//        {type:"for",varName,seqPath,body} | {type:"if",cond,body,elseBody}
function parse(tplSource) {
  // Jinja2 parity: keep_trailing_newline defaults to False (drops one final newline)
  const tpl = tplSource.replace(/\n$/, "");
  const tokens = tokenize(tpl);

  const root = [];
  const stack = [{ kind: "root", children: root }];
  for (const tk of tokens) {
    const top = stack[stack.length - 1];
    if (tk.type === "text") {
      top.children.push(tk);
    } else if (tk.type === "var") {
      top.children.push(tk);
    } else {
      const s = tk.stmt;
      let fm;
      if ((fm = s.match(/^for\s+(\w+)\s+in\s+([\w.]+)$/))) {
        const node = { type: "for", varName: fm[1], seqPath: fm[2], body: [] };
        top.children.push(node);
        stack.push({ kind: "for", node, children: node.body });
      } else if (s === "endfor") {
        if (top.kind !== "for") throw new Error("jinja.js: {% endfor %} without {% for %}");
        stack.pop();
      } else if ((fm = s.match(/^if\s+(.+)$/))) {
        const node = { type: "if", cond: fm[1], body: [], elseBody: [] };
        top.children.push(node);
        stack.push({ kind: "if", node, children: node.body });
      } else if (s === "else") {
        if (top.kind !== "if") throw new Error("jinja.js: {% else %} outside {% if %}");
        top.children = top.node.elseBody;
      } else if (s === "endif") {
        if (top.kind !== "if") throw new Error("jinja.js: {% endif %} without {% if %}");
        stack.pop();
      } else {
        throw new Error("jinja.js: unsupported statement: " + s);
      }
    }
  }
  if (stack.length !== 1) throw new Error("jinja.js: unclosed block in template");
  return root;
}

function renderNodes(nodes, ctx) {
  let out = "";
  for (const n of nodes) {
    if (n.type === "text") {
      out += n.value;
    } else if (n.type === "var") {
      out += escapeHtml(getPath(ctx, n.path));
    } else if (n.type === "for") {
      const seq = getPath(ctx, n.seqPath);
      if (Array.isArray(seq)) {
        for (const item of seq) {
          out += renderNodes(n.body, Object.assign({}, ctx, { [n.varName]: item }));
        }
      }
    } else if (n.type === "if") {
      out += evalCond(n.cond, ctx) ? renderNodes(n.body, ctx) : renderNodes(n.elseBody, ctx);
    }
  }
  return out;
}

const parseCache = new Map();

export function render(tpl, ctx) {
  let tree = parseCache.get(tpl);
  if (!tree) {
    tree = parse(tpl);
    parseCache.set(tpl, tree);
  }
  return renderNodes(tree, ctx);
}
