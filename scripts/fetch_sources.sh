#!/bin/bash
# Download every source document the build reads. Nothing here is committed:
# the PDFs alone are about 56 MB.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p data/raw
cd data/raw

UA="nyc-budget-per-capita research (josh.greenman@gmail.com)"

echo "== NYC Comptroller annual comprehensive financial reports =="
# FY2005, FY2015 and FY2025 tile FY1996-FY2025 with their ten-year schedules.
# FY2016 and FY2020 are used only to cross-check for restatements.
curl -fsSL -o acfr2005.pdf https://comptroller.nyc.gov/wp-content/uploads/documents/cafr2005.pdf
curl -fsSL -o acfr2015.pdf https://comptroller.nyc.gov/wp-content/uploads/documents/CAFR2015.pdf
curl -fsSL -o acfr2016.pdf https://comptroller.nyc.gov/wp-content/uploads/documents/CAFR2016.pdf
curl -fsSL -o acfr2020.pdf https://comptroller.nyc.gov/wp-content/uploads/documents/CAFR2020.pdf
curl -fsSL -o acfr2025.pdf https://comptroller.nyc.gov/wp-content/uploads/documents/ACFR-2025-7-28-2026.pdf

echo "== NYC Office of Management and Budget, adopted budget FY2027 =="
# nyc.gov rejects default curl user agents.
curl -fsSL -A "Mozilla/5.0" -o omb_adopt_fy2027.pdf \
  https://www.nyc.gov/assets/omb/downloads/pdf/adopt26/erc6-26.pdf

echo "== Census Bureau county population estimates =="
curl -fsSL -o co-est00int-tot.csv \
  https://www2.census.gov/programs-surveys/popest/datasets/2000-2010/intercensal/county/co-est00int-tot.csv
curl -fsSL -o co-est2020int-pop-36.xlsx \
  https://www2.census.gov/programs-surveys/popest/tables/2010-2020/intercensal/county/co-est2020int-pop-36.xlsx
curl -fsSL -o co-est2025-alldata.csv \
  https://www2.census.gov/programs-surveys/popest/datasets/2020-2025/counties/totals/co-est2025-alldata.csv

echo "== Bureau of Economic Analysis county GDP =="
curl -fsSL -o CAGDP1.zip https://apps.bea.gov/regional/zip/CAGDP1.zip
unzip -o -q CAGDP1.zip -d cagdp1

echo "== Bureau of Labor Statistics consumer price index =="
# BLS blocks requests without a descriptive user agent.
curl -fsSL -A "$UA" -o cu.data.1.AllItems.txt \
  https://download.bls.gov/pub/time.series/cu/cu.data.1.AllItems

echo "== Independent Budget Office revenue and spending summary (cross-check) =="
curl -fsSL -o ibo_summary.csv \
  "https://data.cityofnewyork.us/api/views/7zhs-43jt/rows.csv?accessType=DOWNLOAD"

echo
echo "done. now run:"
echo "  python3 scripts/extract_acfr.py"
echo "  python3 scripts/extract_omb.py"
echo "  python3 scripts/extract_gdp.py"
echo "  python3 scripts/build_series.py"
