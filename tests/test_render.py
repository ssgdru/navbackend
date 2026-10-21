# -*- coding: utf-8 -*-
"""Local verification for the Cloudflare Workers port.

Runs the actual jinja.js and md5.js sources inside dukpy (embedded JS engine) and
compares the rendered index.html byte-for-byte against a reference render produced
by real Jinja2 (the same engine the FastAPI version uses). Also checks the MD5
implementation against known vectors, including the one the owner generated on the
production server. This edition has no PCL2 download feature.
"""
import json

import dukpy
from jinja2 import Environment, DictLoader

CF = r"C:\Users\he\Desktop\server\html-shengchan\cloudflare workers"
SRC = CF + r"\src"

report = []

jinja_js = open(SRC + r"\jinja.js", encoding="utf-8").read()
md5_js = open(SRC + r"\md5.js", encoding="utf-8").read()
tpl = open(SRC + r"\templates\index.html", encoding="utf-8").read()
config = json.load(open(CF + r"\config.json", encoding="utf-8"))

# --- reference render with real Jinja2 (FastAPI parity) ---
env = Environment(
    loader=DictLoader({"i": tpl}),
    autoescape=True,  # FastAPI Jinja2Templates defaults to unconditional autoescape
)
cats = config["categories"]
secret = "redhe1314_nav_secret_2024_x#"

cats_signed = json.loads(json.dumps(cats))
from urllib.parse import urlparse

for c in cats_signed:
    for item in c.get("links", []):
        if item.get("icon") == "fav" and str(item.get("url", "")).startswith("http"):
            h = urlparse(item["url"]).hostname
            if h:
                item["icon_url"] = f"/icon/{h}"

expected_html = env.get_template("i").render(title=config["title"], categories=cats_signed)

# --- JS harness: TextEncoder/URL polyfills + jinja.js + md5.js + render with same data ---
polyfill = r"""
function TextEncoder() {}
TextEncoder.prototype.encode = function (s) {
  var out = [];
  for (var i = 0; i < s.length; i++) {
    var c = s.codePointAt(i);
    if (c > 0xffff) { i++; }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) { out.push(0xc0 | (c >> 6), 0x80 | (c & 63)); }
    else if (c < 0x10000) { out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)); }
    else { out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)); }
  }
  return new Uint8Array(out);
};
// minimal URL shim for the quickjs harness: hostname extraction only
function URL(u) {
  var m = String(u).match(/^[a-z][a-z0-9+.-]*:\/\/([^\/?#]+)/i);
  var auth = m ? m[1] : "";
  var hostPart = auth.replace(/^[^@]*@/, "");
  this.hostname = hostPart.replace(/:\d+$/, "").toLowerCase();
}
"""

harness = """
var CONFIG = %s;
var TPL = %s;
var SECRET = %s;

// replicate worker.js startup icon_url injection
var ICON_HOSTS = [];
CONFIG.categories.forEach(function (cat) {
  (cat.links || []).forEach(function (item) {
    if (item.icon === 'fav' && typeof item.url === 'string' && item.url.indexOf('http') === 0) {
      try {
        var h = new URL(item.url).hostname;
        if (h) { item.icon_url = '/icon/' + h; ICON_HOSTS.push(h); }
      } catch (e) {}
    }
  });
});

var rendered = render(TPL, { title: CONFIG.title, categories: CONFIG.categories });
JSON.stringify({
  html: rendered,
  md5Empty: md5(''),
  md5Abc: md5('abc'),
  md5SecretTs: md5(SECRET + '1789902933997'),
  iconHosts: ICON_HOSTS
});
""" % (
    json.dumps(config, ensure_ascii=False),
    json.dumps(tpl, ensure_ascii=False),
    json.dumps(secret),
)

js_code = polyfill + "\n" + jinja_js.replace("export function", "function") + "\n" + md5_js.replace(
    "export function", "function"
) + "\n" + harness

try:
    out = json.loads(dukpy.evaljs(js_code))
    report.append(("dukpy executed harness", True))
except Exception as e:
    report.append(("dukpy harness failed: %s" % e, False))
    out = None

if out:
    report.append(("md5('') correct", out["md5Empty"] == "d41d8cd98f00b204e9800998ecf8427e"))
    report.append(("md5('abc') correct", out["md5Abc"] == "900150983cd24fb0d6963f7d28e17f72"))
    report.append(
        ("md5(secret+ts) matches production vector d215c92284ee8e982c3bcca7eaf7c94d",
         out["md5SecretTs"] == "d215c92284ee8e982c3bcca7eaf7c94d")
    )
    report.append(("icon hosts unique = %d (expect 55)" % len(set(out["iconHosts"])), len(set(out["iconHosts"])) == 55))

    js_html = out["html"]
    report.append(("render byte-identical to real Jinja2", js_html == expected_html))
    if js_html != expected_html:
        for i, (a, b) in enumerate(zip(js_html, expected_html)):
            if a != b:
                report.append(("first diff at char %d: js=%r py=%r" % (i, js_html[i : i + 60], expected_html[i : i + 60]), False))
                break
        report.append(("lengths: js=%d py=%d" % (len(js_html), len(expected_html)), False))
    report.append(("no pcl2 in render", "/download/pcl2" not in js_html))
    report.append(("render contains 1314 category", "【1314的导航】" in js_html))
    report.append(("render contains disclaimer link", "/disclaimer" in js_html))

ok = all(p for _, p in report)
for name, passed in report:
    print(("PASS " if passed else "FAIL ") + str(name))
print("ALL PASS" if ok else "HAS FAILURES")
