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

import re as _re

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
    # Revenue detail, for the by-source budget years. Anything that fails to
    # parse simply stays inside the other-taxes remainder, which is computed
    # by subtraction from the rollup rather than by addition.
    "tax_general_sales": r"^General Sales$",
    "tax_personal_income": r"^Personal Income$",
    "tax_general_corp": r"^General Corp$",
    "tax_unincorporated": r"^Unincorporated Business$",
    "tax_utility": r"^Utility$",
    "tax_mortgage": r"^Mortgage Recording$",
    "tax_cigarette": r"^Cigarette$",
    "misc_revenues": r"^Miscellaneous Revenues$",
    "unrestricted_aid": r"^Unrestricted Federal and State Aid$",
    "disallowances": r"^Disallowances against Categorical Grants$",
    "intra_city_revenue": r"^Less: Intra-City Revenue$",
    "capital_transfers": r"^Transfers from Capital Budget$",
    "city_tax_programs": r"^City Tax Programs$",
}
# Lines that can be blank in some columns without failing the run.
OPTIONAL = {"tax_general_sales", "tax_personal_income", "tax_general_corp",
            "tax_unincorporated", "tax_utility", "tax_mortgage",
            "tax_cigarette", "city_tax_programs"}

NUM = re.compile(r"\(?\$?-?[\d,]{4,}\)?|---")


def parse_amount(tok):
    if tok == "---":          # a blank column prints as dashes, meaning zero
        return 0
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

    missing = [k for k in WANT if k not in found and k not in OPTIONAL]
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

    agencies = extract_agencies(doc, found)

    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, "omb_budget.json"), "w") as f:
        json.dump(found, f, indent=1, sort_keys=True)
    with open(os.path.join(OUT, "omb_agencies.json"), "w") as f:
        json.dump(agencies, f, indent=1, sort_keys=True)

    print("OMB Adopted Budget FY2027 (billions):")
    for k in ("net_total_expense", "city_funds_and_capital_transfers",
              "state_categorical", "federal_categorical"):
        v = found[k]
        print(f"  {k:36s} FY26adopt {v['fy2026_adopted']/1e9:7.2f}  "
              f"FY26mod {v['fy2026_modified']/1e9:7.2f}  "
              f"FY27adopt {v['fy2027_adopted']/1e9:7.2f}")


HEADER_RE = _re.compile(
    r"\n\s{10,}([A-Z][A-Z0-9 #,.&()'/-]{3,70}?)\s*\n\s*(\d{3})\s+"
    r"AGENCY EXPENSE BUDGET SUMMARY")
# An amount is either $-prefixed (any size: a change can be $213) or carries
# thousands separators. Bare integers like full-time position counts match
# neither and stay out of the way.
AMT_RE = _re.compile(r"\$-?[\d,]+|-?\d{1,3}(?:,\d{3})+")


def extract_agencies(doc, summary):
    """Net expense budget per agency, FY2026 as modified and FY2027 adopted.

    Each agency's section ends with a NET TOTAL DEPARTMENT line whose columns
    are: FY2026 adopted, FY2026 as modified, change, FY2027 adopted, change.
    The two change columns let every line be checked arithmetically, and the
    sum across agencies must rebuild the summary's net total expense budget.
    """
    sections = []          # (code, name, first_page)
    for i in range(len(doc)):
        t = doc[i].get_text()
        if "AGENCY EXPENSE BUDGET SUMMARY" not in t or "(CONT.)" in t[:400]:
            continue
        m = HEADER_RE.search(t)
        if m and (not sections or sections[-1][0] != m.group(2)):
            sections.append((m.group(2), " ".join(m.group(1).split()), i))

    if len(sections) < 60:
        sys.exit(f"FATAL: only {len(sections)} agency sections found")

    agencies = {}
    for idx, (code, name, p0) in enumerate(sections):
        p1 = sections[idx + 1][2] if idx + 1 < len(sections) else min(len(doc), p0 + 40)
        line = None
        for p in range(p0, p1):
            for cand in doc[p].get_text().split("\n"):
                # The notes below some tables mention the phrase in prose, so a
                # candidate line must actually carry the five amount columns.
                if "NET TOTAL DEPARTMENT" in cand and len(AMT_RE.findall(cand)) >= 5:
                    line = cand          # keep the last one in the section
        if line is None:
            # Tiny agencies print only TOTAL; fall back to it.
            for p in range(p0, p1):
                for cand in doc[p].get_text().split("\n"):
                    if _re.match(r"\s*TOTAL\s+\$?[\d,]", cand):
                        line = cand
        if line is None:
            sys.exit(f"FATAL: no net total line for {code} {name}")

        nums = [int(t.strip("$").replace(",", "")) for t in AMT_RE.findall(line)]
        if len(nums) >= 5:
            fy26a, fy26m, chg1, fy27, chg2 = nums[:5]
            if (abs(abs(fy26m - fy26a) - chg1) > 1
                    or abs(abs(fy27 - fy26m) - chg2) > 1):
                sys.exit(f"FATAL: change columns do not verify for {code} "
                         f"{name}: {nums[:5]}")
        elif len(nums) == 3 and nums[0] == nums[1] == nums[2]:
            # Both change columns blank: the appropriation never moved.
            fy26m, fy27 = nums[1], nums[2]
        elif (len(nums) == 4 and nums[3] == nums[1]
                and abs(abs(nums[1] - nums[0]) - nums[2]) <= 1):
            # Second change column blank: FY2027 equals FY2026 as modified.
            fy26m, fy27 = nums[1], nums[3]
        elif (len(nums) == 4 and nums[0] == nums[1]
                and abs(abs(nums[2] - nums[1]) - nums[3]) <= 1):
            # A zero change column is left blank, dropping one token.
            fy26m, fy27 = nums[1], nums[2]
        elif len(nums) == 2 and nums[0] == nums[1]:
            # An agency created in FY2027 has no FY2026 columns; the change
            # from a zero base equals the appropriation itself.
            fy26m, fy27 = 0, nums[0]
        else:
            sys.exit(f"FATAL: bad total line for {code} {name}: {line!r}")
        agencies[code] = {"name": name, "fy2026_modified": fy26m,
                          "fy2027_adopted": fy27}

    for col, key in (("fy2026_modified", "fy2026_modified"),
                     ("fy2027_adopted", "fy2027_adopted")):
        total = sum(a[col] for a in agencies.values())
        target = summary["net_total_expense"][key]
        if abs(total - target) > 2e6:
            sys.exit(f"FATAL: agency {col} sum {total:,} vs summary net total "
                     f"{target:,} (diff {total - target:,})")

    print(f"agencies: {len(agencies)}, both columns reconcile to the summary")
    return agencies


if __name__ == "__main__":
    run()
