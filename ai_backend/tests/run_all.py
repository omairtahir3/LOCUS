"""Run every suite in this directory and summarise.

    python ai_backend/tests/run_all.py            # all of them
    python ai_backend/tests/run_all.py privacy    # only names containing "privacy"

Each suite is a standalone script that prints "N passed, M failed" and exits
non-zero on failure, so this is a thin wrapper rather than a framework. They
are deliberately plain: no pytest, no fixtures, no conftest -- a suite can be
run on its own and read top to bottom as an argument about the behaviour it
checks.

Several suites measure against the wearer's REAL stored frames, which expire on
a 36-hour retention. Those suites say so when their evidence has aged out and
check what they still can. A suite reporting SKIPPED is not a pass; see
README.md.
"""
import os
import re
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
PY = sys.executable
PAT = re.compile(r"(\d+) passed, (\d+) failed")


def main() -> int:
    needle = sys.argv[1] if len(sys.argv) > 1 else ""
    names = sorted(f for f in os.listdir(HERE)
                   if f.endswith("_test.py") and needle in f)
    if not names:
        print(f"no suites match {needle!r}")
        return 1

    width = max(len(n) for n in names)
    failed, total_p, total_f = [], 0, 0
    t0 = time.perf_counter()
    for name in names:
        t = time.perf_counter()
        proc = subprocess.run([PY, os.path.join(HERE, name)],
                              capture_output=True, text=True)
        out = (proc.stdout or "") + (proc.stderr or "")
        m = None
        for m in PAT.finditer(out):
            pass                      # the LAST summary is the suite's own
        p, f = (int(m.group(1)), int(m.group(2))) if m else (0, 0)
        total_p += p
        total_f += f
        skipped = "SKIPPED" in out
        flag = "ok  " if proc.returncode == 0 else "FAIL"
        print(f"  {flag} {name:<{width}}  {p:>3} passed {f:>2} failed"
              f"  {(time.perf_counter() - t):>5.1f}s"
              f"{'   (evidence expired, partially skipped)' if skipped else ''}")
        if proc.returncode != 0:
            failed.append((name, out))

    print()
    print(f"{len(names) - len(failed)}/{len(names)} suites ok, "
          f"{total_p} assertions passed, {total_f} failed, "
          f"{(time.perf_counter() - t0):.0f}s")

    for name, out in failed:
        print()
        print(f"--- {name}")
        for line in out.splitlines():
            if "FAIL" in line or "Error" in line or "Traceback" in line:
                print(f"    {line.strip()[:160]}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
