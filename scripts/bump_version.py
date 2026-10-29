#!/usr/bin/env python3
"""Stamp a new site version so browsers load fresh files instead of a cached copy.
Run before pushing any change to index.html, app.js, style.css or apple.css."""
import json, os, re
from datetime import datetime, timezone
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
v = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
p = os.path.join(ROOT, "index.html"); s = open(p).read()
s = re.sub(r'(href="(?:style|apple)\.css)(\?v=[^"]*)?"', r'\1?v=%s"' % v, s)
s = re.sub(r'(src="app\.js)(\?v=[^"]*)?"', r'\1?v=%s"' % v, s)
s = re.sub(r'window\.SITE_VERSION = "[^"]*"', 'window.SITE_VERSION = "%s"' % v, s)
open(p, "w").write(s)
with open(os.path.join(ROOT, "version.json"), "w") as f:
    f.write(json.dumps({"v": v}) + "\n")
print("site version", v)
