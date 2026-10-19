import sqlite3
import os
import json
import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment
from openpyxl.utils import get_column_letter

DB_PATH = "data/hcrhub.sqlite"
OUTPUT_XLSX = "exports/HCRHUB_Candidates_With_LinkedIn_URLs.xlsx"
OUTPUT_CSV = "exports/HCRHUB_Candidates_With_LinkedIn_URLs.csv"


def readable_json_list(value):
    if not value:
        return ""
    try:
        parsed = json.loads(value)
        if isinstance(parsed, list):
            return "; ".join(str(item) for item in parsed)
        return str(parsed)
    except (json.JSONDecodeError, TypeError):
        return str(value)


def export():
    os.makedirs("exports", exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()

    cursor.execute("""
        SELECT
            id AS "Candidate ID",
            ahpra_number AS "AHPRA Number",
            full_name AS "Full Name",
            profession AS "Profession",
            state AS "State",
            suburb AS "Suburb",
            postcode AS "Postcode",
            linkedin_url AS "LinkedIn URL",
            employer AS "Employer",
            current_title AS "Job Title",
            identity_status AS "Identity Status",
            match_confidence AS "Match Confidence",
            identity_match_score AS "Match Score",
            match_reasons AS "Match Reasons",
            conflicting_evidence AS "Conflicts",
            identity_provider AS "Source",
            updated_at AS "Last Updated"
        FROM candidates
        WHERE linkedin_url IS NOT NULL AND linkedin_url <> ''
        ORDER BY
            CASE identity_status WHEN 'confirmed' THEN 0 ELSE 1 END,
            id ASC
    """)
    rows = cursor.fetchall()
    columns = [desc[0] for desc in cursor.description]
    reasons_idx = columns.index("Match Reasons")
    conflicts_idx = columns.index("Conflicts")

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Candidates With LinkedIn URL"
    ws.views.sheetView[0].showGridLines = True

    header_font = Font(name="Calibri", size=11, bold=True, color="FFFFFF")
    header_fill = PatternFill(start_color="1E3A8A", end_color="1E3A8A", fill_type="solid")
    confirmed_fill = PatternFill(start_color="E8F5E9", end_color="E8F5E9", fill_type="solid")

    for col_idx, col_name in enumerate(columns, start=1):
        c = ws.cell(row=1, column=col_idx, value=col_name)
        c.font = header_font
        c.fill = header_fill
        c.alignment = Alignment(vertical="center", horizontal="left")
    ws.freeze_panes = "A2"

    for row_idx, row in enumerate(rows, start=2):
        values = list(row)
        values[reasons_idx] = readable_json_list(values[reasons_idx])
        values[conflicts_idx] = readable_json_list(values[conflicts_idx])
        is_confirmed = row["Identity Status"] == "confirmed"
        for col_idx, val in enumerate(values, start=1):
            cell = ws.cell(row=row_idx, column=col_idx, value=val)
            if col_idx == 1:
                cell.alignment = Alignment(horizontal="right")
            if is_confirmed:
                cell.fill = confirmed_fill

    widths = {
        "Candidate ID": 12, "AHPRA Number": 16, "Full Name": 26, "Profession": 12,
        "State": 8, "Suburb": 18, "Postcode": 10, "LinkedIn URL": 45, "Employer": 24,
        "Job Title": 24, "Identity Status": 14, "Match Confidence": 14, "Match Score": 12,
        "Match Reasons": 40, "Conflicts": 40, "Source": 20, "Last Updated": 18
    }
    for col_idx, col_name in enumerate(columns, start=1):
        ws.column_dimensions[get_column_letter(col_idx)].width = widths.get(col_name, 18)

    wb.save(OUTPUT_XLSX)
    print(f"[Export Success] {len(rows)} candidates with a LinkedIn URL -> {OUTPUT_XLSX}")

    import csv
    with open(OUTPUT_CSV, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(columns)
        for row in rows:
            values = list(row)
            values[reasons_idx] = readable_json_list(values[reasons_idx])
            values[conflicts_idx] = readable_json_list(values[conflicts_idx])
            writer.writerow(values)
    print(f"[Export Success] Also saved CSV -> {OUTPUT_CSV}")

    conn.close()


if __name__ == "__main__":
    export()
