#!/usr/bin/env bash
# Renders paper/paper.md → paper/gaza-geo-sync.pdf (A4). Needs Node (npx marked) and WeasyPrint.
set -euo pipefail
cd "$(dirname "$0")"
npx -y marked@15.0.12 --gfm -i paper.md -o /tmp/ggs-paper-body.html
{
  echo '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>gaza-geo-sync paper</title>'
  echo '<link rel="stylesheet" href="paper.css"></head><body>'
  cat /tmp/ggs-paper-body.html
  echo '</body></html>'
} > paper.html
python3 -c "import weasyprint; weasyprint.HTML('paper.html', base_url='.').write_pdf('gaza-geo-sync.pdf')"
rm -f paper.html
echo "paper/gaza-geo-sync.pdf"
