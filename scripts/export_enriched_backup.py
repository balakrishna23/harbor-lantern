import sqlite3
import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment
from openpyxl.utils import get_column_letter

BACKUP_DB = "data/backups/hcrhub-pre-clean-slate-20260921.sqlite"
OUTPUT_XLSX = "exports/HCRHUB_Enriched_Candidates_Verified.xlsx"
OUTPUT_CSV = "exports/HCRHUB_Enriched_Candidates_Verified.csv"

def export_enriched():
    conn = sqlite3.connect(BACKUP_DB)
    conn.row_factory = sqlite3.Row
    c = conn.cursor()

    c.execute("""
        SELECT 
            id AS "Candidate ID",
            ahpra_number AS "AHPRA Number",
            full_name AS "Full Name",
            profession AS "Profession",
            state AS "State",
            suburb AS "Suburb",
            postcode AS "Postcode",
            qualifications AS "Qualifications",
            work_email AS "Work Email",
            email_status AS "Email Status",
            mobile_phone AS "Mobile Phone",
            linkedin_url AS "LinkedIn URL",
            employer AS "Employer",
            current_title AS "Job Title",
            identity_status AS "Identity Status",
            match_confidence AS "Match Confidence",
            recruiter_notes AS "Recruiter Notes"
        FROM candidates
        WHERE work_email IS NOT NULL 
           OR mobile_phone IS NOT NULL 
           OR (linkedin_url IS NOT NULL AND linkedin_url != '')
        ORDER BY 
            CASE WHEN work_email IS NOT NULL AND work_email != '' THEN 0 ELSE 1 END,
            CASE WHEN mobile_phone IS NOT NULL AND mobile_phone != '' THEN 0 ELSE 1 END,
            id ASC
    """)
    rows = [dict(r) for r in c.fetchall()]
    columns = list(rows[0].keys()) if rows else []

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Enriched Australian Candidates"
    ws.views.sheetView[0].showGridLines = True

    # Header style
    header_font = Font(name="Calibri", size=11, bold=True, color="FFFFFF")
    header_fill = PatternFill(start_color="0F766E", end_color="0F766E", fill_type="solid")

    for col_idx, col_name in enumerate(columns, start=1):
        cell = ws.cell(row=1, column=col_idx, value=col_name)
        cell.font = header_font
        cell.fill = header_fill
        cell.alignment = Alignment(vertical="center")

    ws.freeze_panes = "A2"

    for r_idx, row in enumerate(rows, start=2):
        for col_idx, col_name in enumerate(columns, start=1):
            val = row[col_name]
            cell = ws.cell(row=r_idx, column=col_idx, value=val)
            if col_name in ["Work Email", "Mobile Phone"] and val:
                cell.font = Font(name="Calibri", bold=True, color="047857")

    for col_idx, col_name in enumerate(columns, start=1):
        col_letter = get_column_letter(col_idx)
        if col_name in ["Qualifications", "Recruiter Notes", "LinkedIn URL"]:
            ws.column_dimensions[col_letter].width = 40
        elif col_name in ["Full Name", "Work Email", "Employer"]:
            ws.column_dimensions[col_letter].width = 30
        else:
            ws.column_dimensions[col_letter].width = 18

    wb.save(OUTPUT_XLSX)
    print(f"Saved {len(rows)} enriched candidates to {OUTPUT_XLSX}")

    import csv
    with open(OUTPUT_CSV, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(columns)
        for r in rows:
            writer.writerow([r[c] for c in columns])
    print(f"Saved to {OUTPUT_CSV}")

    conn.close()

if __name__ == "__main__":
    export_enriched()
