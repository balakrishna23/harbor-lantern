import json
import os
import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment
from openpyxl.utils import get_column_letter

RESULTS_PATH = "exports/linkedin_compare_crosscheck_results.json"
OUTPUT_XLSX = "exports/HCRHUB_LinkedIn_CrossCheck_Report.xlsx"

HEADER_FONT = Font(name="Calibri", size=11, bold=True, color="FFFFFF")
HEADER_FILL = PatternFill(start_color="1E3A8A", end_color="1E3A8A", fill_type="solid")


def write_sheet(wb, title, rows, columns, col_keys):
    ws = wb.create_sheet(title=title)
    for col_idx, col_name in enumerate(columns, start=1):
        c = ws.cell(row=1, column=col_idx, value=col_name)
        c.font = HEADER_FONT
        c.fill = HEADER_FILL
        c.alignment = Alignment(vertical="center", horizontal="left")
    ws.freeze_panes = "A2"
    for row_idx, row in enumerate(rows, start=2):
        for col_idx, key in enumerate(col_keys, start=1):
            ws.cell(row=row_idx, column=col_idx, value=row.get(key, ""))
    for col_idx in range(1, len(columns) + 1):
        ws.column_dimensions[get_column_letter(col_idx)].width = 26
    return ws


def export():
    with open(RESULTS_PATH, "r", encoding="utf-8") as f:
        results = json.load(f)

    wb = openpyxl.Workbook()
    ws_summary = wb.active
    ws_summary.title = "Summary"
    ws_summary["A1"] = "LinkedIn Compare-File Cross-Check"
    ws_summary["A1"].font = Font(name="Calibri", size=16, bold=True, color="1E3A8A")
    ws_summary["A2"] = "exports/linkdin compare data.csv vs the full AHPRA candidate roster"
    ws_summary["A2"].font = Font(name="Calibri", size=11, italic=True, color="475569")

    rows_summary = [
        ("Compare file rows", len(results["already_have_this_url"]) + len(results["matched_missing_url"]) + len(results["matched_different_url"]) + len(results["no_ahpra_match"])),
        ("Already have this exact URL", len(results["already_have_this_url"])),
        ("Matched AHPRA candidate, URL MISSING on our side", len(results["matched_missing_url"])),
        ("Matched AHPRA candidate, URL DIFFERS from ours", len(results["matched_different_url"])),
        ("No AHPRA candidate name-matches this row", len(results["no_ahpra_match"])),
    ]
    for r_idx, (label, val) in enumerate(rows_summary, start=4):
        ws_summary.cell(row=r_idx, column=1, value=label)
        ws_summary.cell(row=r_idx, column=2, value=val)
    ws_summary.column_dimensions["A"].width = 48
    ws_summary.column_dimensions["B"].width = 14

    write_sheet(
        wb, "Missing (we should recheck)", results["matched_missing_url"],
        ["Candidate ID", "AHPRA Number", "Our Full Name", "State", "Suburb", "Workflow Stage",
         "Compare Full Name", "Compare LinkedIn URL", "Compare Company", "Compare Title"],
        ["candidateId", "ahpraNumber", "candidateFullName", "candidateState", "candidateSuburb", "workflowStage",
         "compareFullName", "compareUrl", "compareCompany", "compareTitle"]
    )

    write_sheet(
        wb, "URL Discrepancies", results["matched_different_url"],
        ["Candidate ID", "Our Full Name", "State", "Our URL", "Compare URL"],
        ["candidateId", "candidateFullName", "candidateState", "existingUrl", "compareUrl"]
    )

    write_sheet(
        wb, "No AHPRA Match", results["no_ahpra_match"],
        ["Compare Full Name", "LinkedIn URL", "Company", "Title", "City"],
        ["fullName", "url", "company", "title", "city"]
    )

    os.makedirs("exports", exist_ok=True)
    wb.save(OUTPUT_XLSX)
    print(f"[Export Success] {OUTPUT_XLSX}")


if __name__ == "__main__":
    export()
