import sqlite3
import os
import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

DB_PATH = "data/hcrhub.sqlite"
OUTPUT_XLSX = "exports/HCRHUB_Candidate_Intelligence_Master.xlsx"
OUTPUT_CSV = "exports/HCRHUB_Candidate_Intelligence_Master.csv"

def export_master():
    os.makedirs("exports", exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()

    # 1. Fetch all candidates
    cursor.execute("""
        SELECT 
            id AS "Candidate ID",
            ahpra_number AS "AHPRA Number",
            full_name AS "Full Name",
            profession AS "Profession",
            state AS "State",
            suburb AS "Suburb",
            postcode AS "Postcode",
            qualifications AS "Qualifications",
            workflow_stage AS "Workflow Stage",
            identity_status AS "Identity Status",
            work_email AS "Work Email",
            email_status AS "Email Status",
            mobile_phone AS "Mobile Phone",
            linkedin_url AS "LinkedIn URL",
            employer AS "Employer",
            current_title AS "Job Title",
            recruiter_notes AS "Recruiter Notes",
            updated_at AS "Last Updated"
        FROM candidates
        ORDER BY id ASC
    """)
    rows = cursor.fetchall()
    columns = [desc[0] for desc in cursor.description]

    # Create Workbook
    wb = openpyxl.Workbook()
    
    # -------------------------------------------------------------
    # Tab 1: Summary Dashboard
    # -------------------------------------------------------------
    ws_summary = wb.active
    ws_summary.title = "Pipeline Executive Summary"
    ws_summary.views.sheetView[0].showGridLines = True

    # Title styling
    title_font = Font(name="Calibri", size=16, bold=True, color="1E3A8A")
    sub_font = Font(name="Calibri", size=11, italic=True, color="475569")
    section_font = Font(name="Calibri", size=12, bold=True, color="1E293B")
    header_font = Font(name="Calibri", size=11, bold=True, color="FFFFFF")
    header_fill = PatternFill(start_color="1E3A8A", end_color="1E3A8A", fill_type="solid")
    accent_fill = PatternFill(start_color="F1F5F9", end_color="F1F5F9", fill_type="solid")
    
    ws_summary["A1"] = "HCRHUB CANDIDATE INTELLIGENCE SYSTEM — EXECUTIVE DASHBOARD"
    ws_summary["A1"].font = title_font
    ws_summary["A2"] = "Live Database Snapshot & Swarm Pipeline Metrics"
    ws_summary["A2"].font = sub_font

    # Summary KPIs
    cursor.execute("SELECT COUNT(*) FROM candidates")
    total_candidates = cursor.fetchone()[0]

    cursor.execute("SELECT COUNT(*) FROM candidates WHERE workflow_stage != 'source_imported'")
    processed_count = cursor.fetchone()[0]

    cursor.execute("SELECT COUNT(*) FROM candidates WHERE identity_status = 'confirmed'")
    confirmed_count = cursor.fetchone()[0]

    cursor.execute("SELECT COUNT(*) FROM candidates WHERE workflow_stage = 'identity_unresolved'")
    unresolved_count = cursor.fetchone()[0]

    kpi_headers = ["Total Candidates in SQLite", "Processed by Swarm", "Confirmed AU Identities", "Searched, Not Found"]
    kpi_values = [total_candidates, processed_count, confirmed_count, unresolved_count]

    ws_summary["A4"] = "Core Performance Indicators"
    ws_summary["A4"].font = section_font

    for col_idx, (h, val) in enumerate(zip(kpi_headers, kpi_values), start=1):
        cell_h = ws_summary.cell(row=5, column=col_idx, value=h)
        cell_h.font = header_font
        cell_h.fill = header_fill
        cell_h.alignment = Alignment(horizontal="center", vertical="center")
        
        cell_v = ws_summary.cell(row=6, column=col_idx, value=val)
        cell_v.font = Font(name="Calibri", size=14, bold=True, color="0F172A")
        cell_v.alignment = Alignment(horizontal="center", vertical="center")
        cell_v.fill = accent_fill

    # Breakdown by Workflow Stage
    ws_summary["A8"] = "Breakdown by Workflow Stage"
    ws_summary["A8"].font = section_font
    
    ws_summary["A9"] = "Workflow Stage"
    ws_summary["A9"].font = header_font
    ws_summary["A9"].fill = PatternFill(start_color="334155", end_color="334155", fill_type="solid")
    
    ws_summary["B9"] = "Candidate Count"
    ws_summary["B9"].font = header_font
    ws_summary["B9"].fill = PatternFill(start_color="334155", end_color="334155", fill_type="solid")
    ws_summary["B9"].alignment = Alignment(horizontal="right")

    cursor.execute("SELECT workflow_stage, COUNT(*) FROM candidates GROUP BY workflow_stage ORDER BY 2 DESC")
    stages = cursor.fetchall()
    for r_idx, (stg, cnt) in enumerate(stages, start=10):
        c1 = ws_summary.cell(row=r_idx, column=1, value=stg)
        c2 = ws_summary.cell(row=r_idx, column=2, value=cnt)
        c2.alignment = Alignment(horizontal="right")

    # Breakdown by Profession
    ws_summary["D8"] = "Breakdown by Profession"
    ws_summary["D8"].font = section_font

    ws_summary["D9"] = "Profession"
    ws_summary["D9"].font = header_font
    ws_summary["D9"].fill = PatternFill(start_color="334155", end_color="334155", fill_type="solid")

    ws_summary["E9"] = "Candidate Count"
    ws_summary["E9"].font = header_font
    ws_summary["E9"].fill = PatternFill(start_color="334155", end_color="334155", fill_type="solid")
    ws_summary["E9"].alignment = Alignment(horizontal="right")

    cursor.execute("SELECT profession, COUNT(*) FROM candidates GROUP BY profession ORDER BY 2 DESC")
    profs = cursor.fetchall()
    for r_idx, (prof, cnt) in enumerate(profs, start=10):
        c1 = ws_summary.cell(row=r_idx, column=4, value=prof)
        c2 = ws_summary.cell(row=r_idx, column=5, value=cnt)
        c2.alignment = Alignment(horizontal="right")

    for col in range(1, 7):
        col_letter = get_column_letter(col)
        ws_summary.column_dimensions[col_letter].width = 30

    # -------------------------------------------------------------
    # Tab 2: All 8,951 Candidates
    # -------------------------------------------------------------
    ws_data = wb.create_sheet(title="All Candidates Roster")
    ws_data.views.sheetView[0].showGridLines = True

    # Write Header
    for col_idx, col_name in enumerate(columns, start=1):
        c = ws_data.cell(row=1, column=col_idx, value=col_name)
        c.font = Font(name="Calibri", size=11, bold=True, color="FFFFFF")
        c.fill = PatternFill(start_color="1E3A8A", end_color="1E3A8A", fill_type="solid")
        c.alignment = Alignment(vertical="center", horizontal="left")

    # Freeze header row
    ws_data.freeze_panes = "A2"

    # Write Rows
    for row_idx, row in enumerate(rows, start=2):
        for col_idx, val in enumerate(row, start=1):
            cell = ws_data.cell(row=row_idx, column=col_idx, value=val)
            if col_idx in (1, 7):  # ID or Postcode
                cell.alignment = Alignment(horizontal="right")

    # Auto-fit column widths (with sensible min/max)
    for col_idx, col_name in enumerate(columns, start=1):
        col_letter = get_column_letter(col_idx)
        if col_name in ["Qualifications", "Recruiter Notes"]:
            ws_data.column_dimensions[col_letter].width = 45
        elif col_name in ["Full Name", "Work Email", "Employer"]:
            ws_data.column_dimensions[col_letter].width = 28
        elif col_name in ["Candidate ID", "State", "Postcode"]:
            ws_data.column_dimensions[col_letter].width = 14
        else:
            ws_data.column_dimensions[col_letter].width = 20

    wb.save(OUTPUT_XLSX)
    print(f"[Export Success] Saved native Excel workbook to {OUTPUT_XLSX}")

    # Also output standard Master CSV
    import csv
    with open(OUTPUT_CSV, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(columns)
        for r in rows:
            writer.writerow(list(r))
    print(f"[Export Success] Saved master CSV to {OUTPUT_CSV}")

    conn.close()

if __name__ == "__main__":
    export_master()
