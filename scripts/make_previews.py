#!/usr/bin/env python3
"""Build style preview pages (style-preview/<name>/index.html) from index.html.
Each preview is the real site plus one theme stylesheet; the main page is untouched."""
import os, re
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
THEMES = [("arena", "Arena"), ("clean", "Clean modern"), ("retro", "Retro hardwood")]
src = open(os.path.join(ROOT, "index.html")).read()
for slug, label in THEMES:
    html = src.replace("<head>", '<head>\n  <base href="../../">', 1)
    html = re.sub(r'(<link rel="stylesheet" href="apple\.css[^"]*">)', r'\1\n  <link rel="stylesheet" href="style-preview/theme-%s.css">' % slug, html, count=1)
    html = html.replace('href="#top"', 'href="javascript:void(0)"')
    links = " · ".join((f"<b>{l}</b>" if s == slug else f'<a href="style-preview/{s}/">{l}</a>') for s, l in THEMES)
    bar = ('<div style="font:600 12px/1.3 -apple-system,system-ui,sans-serif;text-align:center;padding:8px 12px;'
           'background:#111;color:#bbb">Style preview: ' + links + ' · <a href="./">Current site</a></div>'
           '<style>body>div:first-of-type a{color:#ffb27a}</style>')
    html = html.replace("<body>", "<body>\n" + bar, 1)
    html = html.replace("<title>Hoop Squads", f"<title>Preview ({label}) · Hoop Squads", 1)
    os.makedirs(os.path.join(ROOT, "style-preview", slug), exist_ok=True)
    open(os.path.join(ROOT, "style-preview", slug, "index.html"), "w").write(html)
print("built", ", ".join(s for s, _ in THEMES))
