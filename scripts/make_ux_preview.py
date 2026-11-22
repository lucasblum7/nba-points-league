#!/usr/bin/env python3
"""Build style-preview/ux/index.html: the real site plus the easier-to-use ideas (window.PL_UX)."""
import os, re
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
html = open(os.path.join(ROOT, "index.html")).read()
html = html.replace("<head>", '<head>\n  <base href="../../">', 1)
html = re.sub(r'(<link rel="stylesheet" href="arena\.css[^"]*">)', r'\1\n  <link rel="stylesheet" href="style-preview/ux.css?v=%d">' % int(os.path.getmtime(os.path.join(ROOT, "style-preview", "ux.css"))), html, count=1)
html = html.replace('<script src="app.js', '<script>window.PL_UX = true;</script>\n<script src="app.js', 1)
html = html.replace('href="#top"', 'href="javascript:void(0)"')
n = lambda k: '<span class="ux-n">%d</span>' % k
items = ["Since you last checked", "Who to root for", "Tap ⓘ for what it means", "Names &amp; teams open cards", "▲▼ standings moves", "Your stuff first", "How it works (More tab)"]
banner = ('<div class="ux-banner">Preview: easier-to-use ideas · look for the orange numbers · <a href="./">Current site</a><ol>'
          + "".join('<li>%s %s</li>' % (n(i + 1), t) for i, t in enumerate(items)) + '</ol></div>')
html = html.replace("<body>", "<body>\n" + banner, 1)
os.makedirs(os.path.join(ROOT, "style-preview", "ux"), exist_ok=True)
open(os.path.join(ROOT, "style-preview", "ux", "index.html"), "w").write(html)
print("built style-preview/ux")
