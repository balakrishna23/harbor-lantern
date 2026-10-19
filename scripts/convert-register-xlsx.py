"""Stream a large AHPRA register .xlsx into JSON Lines for scripts/import-register-jsonl.mjs.

The server's upload path parses a whole workbook in memory and caps uploads at
25 MB; the all-jurisdictions nurse extract is 65 MB / 540,877 rows, so it is
converted here row by row instead (openpyxl read-only mode).

--drop removes columns by header name. Used for the 03-09-2026 national extract,
where Languages, Suburb, State and Postcode hold the person's first name in every
copy of the file (including the original zip) — importing them would put first
names into location fields and garbage into location search queries.

Usage:
  python scripts/convert-register-xlsx.py <input.xlsx> <output.jsonl> --drop "Suburb" --drop "State" ...
"""
import argparse
import datetime
import json
import sys

import openpyxl


def cell_text(value):
    if value is None:
        return ""
    if isinstance(value, datetime.datetime):
        return value.date().isoformat()
    if isinstance(value, datetime.date):
        return value.isoformat()
    return str(value)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("input")
    parser.add_argument("output")
    parser.add_argument("--drop", action="append", default=[], help="header to exclude (repeatable, case-insensitive)")
    args = parser.parse_args()

    drop = {name.strip().lower() for name in args.drop}
    sheet = openpyxl.load_workbook(args.input, read_only=True, data_only=True).worksheets[0]
    rows = sheet.iter_rows(values_only=True)
    headers = [cell_text(h) for h in next(rows)]
    keep = [(i, h) for i, h in enumerate(headers) if h.strip() and h.strip().lower() not in drop]
    dropped = [h for h in headers if h.strip().lower() in drop]
    missing = drop - {h.strip().lower() for h in headers}
    if missing:
        sys.exit(f"--drop names not found in the header row: {sorted(missing)}")

    written = 0
    with open(args.output, "w", encoding="utf-8", newline="\n") as out:
        for row in rows:
            record = {h: cell_text(row[i]) if i < len(row) else "" for i, h in keep}
            if not any(record.values()):
                continue
            out.write(json.dumps(record, ensure_ascii=False) + "\n")
            written += 1
    print(json.dumps({"rows": written, "kept_columns": [h for _, h in keep], "dropped_columns": dropped}))


if __name__ == "__main__":
    main()
