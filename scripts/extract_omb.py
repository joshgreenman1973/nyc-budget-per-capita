#!/usr/bin/env python3
"""
Pull the budget-year figures from the OMB Adopted Budget for FY2027.

Audited actuals only exist through FY2025: FY2026 closed on 30 June 2026 and
its ACFR is not published until the autumn, and FY2027 is a plan. So the two
most recent years come from OMB on the *budget* basis, which is not the same
as the Comptroller's General Fund actuals -- OMB nets out intra-city
transactions and counts capital-budget transfers. They are kept in a separate
block of the data file and labelled as budgeted, never blended into the
audited series.

Summary table layout, per row:
    label, FY2026 as adopted, FY2026 as modified, change, FY2027 adopted, change
"""

import json
import os
import re
import sys

import fitz

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, "..", "data", "raw")
OUT = os.path.join(HERE, "..", "data", "out")

PAGES = (4, 7)          # 1-indexed summary pages
WANT = {
    "net_total_expense": r"Net Total Expense Budget",
    "personal_service": r"^Personal Service$",
    "other_than_personal_service": r"^Other Than Personal Service$",
    "debt_service": r"^Debt Service$",
    "city_funds": r"Total City Funds$",
    "city_funds_and_capital_transfers": r"Total City Funds and Capital Budget Transfers",
    "federal_categorical": r"Total Federal Categorical Grants",
    "state_categorical": r"Total State Categorical Grants",
    "other_categorical": r"^Other Categorical Grants$",
    "property_tax": r"^General Property Taxes$",
    "other_taxes": r"^Other Taxes$",
}

NUM = re.compile(r"\(?\$?-?[\d,]{4,}\)?")


def parse_amount(tok):
    neg = tok.startswith("(") and tok.endswith(")")
    v = tok.strip("()").lstrip("$").replace(",", "")
    if not v.isdigit():
        return None
    n = int(v)
    return -n if neg else n


def run():
    path = os.path.join(RAW, "omb_adopt_fy2027.pdf")
    doc = fitz.open(path)

    # Flatten the summary pages to lines, joining each label with the numbers
    # that follow it before the next label.
    lines = []
    for p in range(PAGES[0] - 1, PAGES[1]):
        for raw in doc[p].get_text().split("\n"):
            s = re.sub(r"[.…]{2,}", " ", raw).strip()
            s = re.sub(r"\s+", " ", s)
            if s:
                lines.append(s)

    found = {}
    for key, pat in WANT.items():
        for i, line in enumerate(lines):
            label = line.rstrip(" .")
            if not re.search(pat, label):
                continue
            nums = []
            # numbers may share the label's line or follow it
            for tok in NUM.findall(line):
                v = parse_amount(tok)
                if v is not None:
                    nums.append(v)
            j = i + 1
            while j < len(lines) and len(nums) < 5:
                nxt = lines[j]
                if re.search(r"[A-Za-z]{4}", nxt) and not NUM.fullmatch(nxt.strip()):
                    toks = NUM.findall(nxt)
                    if not toks:
                        break
                for tok in NUM.findall(nxt):
                    v = parse_amount(tok)
                    if v is not None:
                        nums.append(v)
                j += 1
            if len(nums) >= 4:
                found[key] = {
                    "fy2026_adopted": nums[0],
                    "fy2026_modified": nums[1],
                    "fy2027_adopted": nums[3],
                }
                break

    missing = [k for k in WANT if k not in found]
    if missing:
        sys.exit(f"FATAL: could not read OMB summary lines: {missing}")

    # Internal check: the expense components must rebuild the net total.
    for col in ("fy2026_adopted", "fy2026_modified", "fy2027_adopted"):
        parts = (found["personal_service"][col]
                 + found["other_than_personal_service"][col]
                 + found["debt_service"][col])
        net = found["net_total_expense"][col]
        intra = parts - net
        if not (0 < intra < 4e9):
            sys.exit(f"FATAL: {col} expense components {parts:,} vs net "
                     f"{net:,} implies intra-city {intra:,}")

    # Revenue side must rebuild the net total too.
    for col in ("fy2026_adopted", "fy2027_adopted"):
        rev = (found["city_funds_and_capital_transfers"][col]
               + found["federal_categorical"][col]
               + found["state_categorical"][col])
        exp = found["net_total_expense"][col]
        if abs(rev - exp) > 5e8:
            sys.exit(f"FATAL: {col} revenue {rev:,} vs expense {exp:,} "
                     f"(gap {rev - exp:,}) -- budget should balance")

    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, "omb_budget.json"), "w") as f:
        json.dump(found, f, indent=1, sort_keys=True)

    print("OMB Adopted Budget FY2027 (billions):")
    for k in ("net_total_expense", "city_funds_and_capital_transfers",
              "state_categorical", "federal_categorical"):
        v = found[k]
        print(f"  {k:36s} FY26adopt {v['fy2026_adopted']/1e9:7.2f}  "
              f"FY26mod {v['fy2026_modified']/1e9:7.2f}  "
              f"FY27adopt {v['fy2027_adopted']/1e9:7.2f}")


if __name__ == "__main__":
    run()
