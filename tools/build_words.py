"""Convert the crossword Excel file to words.json.
Usage: python -I tools/build_words.py "<path to xlsx>" words.json
Row 1 is headers (skipped). B = word, C = clue, D/E/F = extra hints for the Overseer."""
import sys, json, openpyxl
ws = openpyxl.load_workbook(sys.argv[1]).worksheets[0]
rows = list(ws.iter_rows(values_only=True))
hdr = rows[0]
out = []
for r in rows[1:]:
    if not r[1]:
        continue
    hints = [{"label": str(hdr[i]).strip(), "text": str(r[i]).strip()} for i in (3, 4, 5) if r[i] not in (None, "")]
    out.append({"word": str(r[1]).strip(), "clue": str(r[2]).strip(), "hints": hints})
json.dump(out, open(sys.argv[2], "w", encoding="utf-8"), indent=1, ensure_ascii=False)
print(len(out), "words")