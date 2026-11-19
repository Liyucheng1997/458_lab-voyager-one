"""从 JPL Horizons 拉取旅行者一号(-31)日心黄道坐标，写入 web/data/voyager1.json。
用法: python tools/fetch_ephemeris.py
"""
import json, urllib.request, urllib.parse, pathlib, re

API = "https://ssd.jpl.nasa.gov/api/horizons.api"
OUT = pathlib.Path(__file__).resolve().parent.parent / "web" / "data" / "voyager1.json"

SEGMENTS = [  # (开始, 结束, 步长) —— 行星飞掠期间加密采样
    ("1977-09-06", "1979-02-20", "2d"),
    ("1979-02-20", "1979-03-20", "1h"),   # 木星飞掠 1979-03-05
    ("1979-03-20", "1980-11-01", "2d"),
    ("1980-11-01", "1980-11-25", "1h"),   # 土星飞掠 1980-11-12
    ("1980-11-25", "1982-01-01", "2d"),
    ("1982-01-01", "2099-12-31", "15d"),
]

def query(start, stop, step, target="-31"):
    p = {
        "format": "json", "COMMAND": f"'{target}'", "OBJ_DATA": "'NO'", "MAKE_EPHEM": "'YES'",
        "EPHEM_TYPE": "'VECTORS'", "CENTER": "'500@10'", "START_TIME": f"'{start}'",
        "STOP_TIME": f"'{stop}'", "STEP_SIZE": f"'{step}'", "VEC_TABLE": "'2'",
        "REF_PLANE": "'ECLIPTIC'", "OUT_UNITS": "'AU-D'", "CSV_FORMAT": "'YES'",
    }
    url = API + "?" + urllib.parse.urlencode(p)
    with urllib.request.urlopen(url, timeout=120) as r:
        txt = json.load(r)["result"]
    body = txt.split("$$SOE")[1].split("$$EOE")[0]
    rows = []
    for line in body.strip().splitlines():
        f = [s.strip() for s in line.split(",")]
        jd = float(f[0]); x, y, z, vx, vy, vz = map(float, f[2:8])
        rows.append([round(jd, 5), round(x, 7), round(y, 7), round(z, 7),
                     round(vx, 9), round(vy, 9), round(vz, 9)])
    return rows

allrows = []
for seg in SEGMENTS:
    rows = query(*seg)
    if allrows and rows and rows[0][0] <= allrows[-1][0]:
        rows = [r for r in rows if r[0] > allrows[-1][0]]
    allrows += rows
    print(seg, len(rows))

# 飞掠期间木星/土星的精确位置（行星平时用开普勒根数，飞掠时需要精确对齐）
planets = {}
for name, tid in (("jupiter", "599"), ("saturn", "699")):
    rows = []
    for seg in SEGMENTS[:5]:
        r = query(*seg, target=tid)
        if rows: r = [x for x in r if x[0] > rows[-1][0]]
        rows += r
    planets[name] = rows
    print(name, len(rows))

OUT.write_text(json.dumps({
    "source": "NASA/JPL Horizons, target -31 (Voyager 1), center Sun, ecliptic J2000, AU & AU/day",
    "columns": ["jd_tdb", "x", "y", "z", "vx", "vy", "vz"],
    "rows": allrows, "planets": planets}, separators=(",", ":")), encoding="utf-8")
print("total", len(allrows), "->", OUT, OUT.stat().st_size // 1024, "KB")
