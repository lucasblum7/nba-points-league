#!/usr/bin/env python3
"""Build style-preview/next/index.html: the real site plus the proposed readability/layout changes."""
import os, re
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
html = open(os.path.join(ROOT, "index.html")).read()
html = html.replace("<head>", '<head>\n  <base href="../../">', 1)
html = re.sub(r'(<link rel="stylesheet" href="arena\.css[^"]*">)', r'\1\n  <link rel="stylesheet" href="style-preview/next.css?v=%d">' % int(os.path.getmtime(os.path.join(ROOT, "style-preview", "next.css"))), html, count=1)
html = html.replace('<script src="app.js', '<script>window.PL_PREVIEW = true;</script>\n<script src="app.js', 1)
html = html.replace('href="#top"', 'href="javascript:void(0)"')
html = html.replace("<body>", '<body>\n<div style="font:600 12px/1.3 -apple-system,system-ui,sans-serif;text-align:center;padding:8px 12px;background:#111;color:#bbb">Preview of proposed changes · <a style="color:#ffb27a" href="./">Current site</a></div>', 1)
os.makedirs(os.path.join(ROOT, "style-preview", "next"), exist_ok=True)
open(os.path.join(ROOT, "style-preview", "next", "index.html"), "w").write(html)
print("built style-preview/next")
