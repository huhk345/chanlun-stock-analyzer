#!/usr/bin/env python3
"""Three-part test runner.

    python run_tests.py                 # all three parts
    python run_tests.py --part 2        # only part 2
    python run_tests.py --no-parity     # skip the JS-engine parity check
    python run_tests.py --live          # also hit real market data

Part 1  unit         pure functions: ChanLun, fees, metrics, indicators, sandbox
Part 2  integration  engine + registry + router wired together, in-process
Part 3  e2e          a real server process answering real HTTP requests

Each part is a separate pytest invocation so a failure in one layer never hides
the results of another, and the summary shows exactly which layer broke.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent

PARTS = [
    ("Part 1", "unit", "tests/part1_unit", "纯函数: 缠论 / 费用 / 指标 / 沙箱"),
    ("Part 2", "integration", "tests/part2_integration", "进程内集成: 引擎 / 注册表 / 路由"),
    ("Part 3", "e2e", "tests/part3_e2e", "真实进程 + 真实 HTTP"),
]

SUMMARY_RE = re.compile(
    r"(?:(?P<passed>\d+) passed)?"
    r"(?:, )?(?:(?P<failed>\d+) failed)?"
    r"(?:, )?(?:(?P<error>\d+) error)?"
    r"(?:, )?(?:(?P<skipped>\d+) skipped)?"
)


@dataclass
class PartResult:
    label: str
    marker: str
    description: str
    passed: int = 0
    failed: int = 0
    errors: int = 0
    skipped: int = 0
    seconds: float = 0.0
    returncode: int = 0

    @property
    def ok(self) -> bool:
        return self.returncode == 0 and self.failed == 0 and self.errors == 0


def _parse_counts(output: str) -> dict:
    """Read the last pytest summary line (e.g. '12 failed, 40 passed in 1.2s')."""
    for line in reversed(output.strip().splitlines()):
        if " passed" in line or " failed" in line or " error" in line or " skipped" in line:
            counts = {"passed": 0, "failed": 0, "error": 0, "skipped": 0}
            for match in SUMMARY_RE.finditer(line):
                for key, value in match.groupdict().items():
                    if value:
                        counts[key] = int(value)
            if any(counts.values()):
                return counts
    return {"passed": 0, "failed": 0, "error": 0, "skipped": 0}


def run_part(part, extra_args: list[str], verbose: bool) -> PartResult:
    label, marker, path, description = part
    result = PartResult(label=label, marker=marker, description=description)

    command = [sys.executable, "-m", "pytest", path, "-m", marker, "-q", *extra_args]
    print(f"\n\033[1m▶ {label} · {marker}\033[0m  {description}")
    print(f"  $ {' '.join(command[1:])}")

    started = time.time()
    process = subprocess.run(
        command,
        cwd=str(ROOT),
        capture_output=True,
        text=True,
    )
    result.seconds = time.time() - started
    result.returncode = process.returncode

    output = (process.stdout or "") + (process.stderr or "")
    counts = _parse_counts(output)
    result.passed = counts["passed"]
    result.failed = counts["failed"]
    result.errors = counts["error"]
    result.skipped = counts["skipped"]

    if not result.ok or verbose:
        print(output.rstrip())
    else:
        status = "\033[32mPASS\033[0m" if result.ok else "\033[31mFAIL\033[0m"
        print(
            f"  {status}  {result.passed} passed"
            + (f", {result.skipped} skipped" if result.skipped else "")
            + f"  ({result.seconds:.2f}s)"
        )
    return result


def print_summary(results: list[PartResult]) -> None:
    width = 62
    print("\n" + "═" * width)
    print("  三阶段测试汇总 / three-part test summary")
    print("═" * width)
    print(f"  {'layer':<10}{'tests':>7}{'fail':>7}{'skip':>7}{'time':>9}   status")
    print("  " + "─" * (width - 2))
    for result in results:
        status = "\033[32mok\033[0m" if result.ok else "\033[31mFAILED\033[0m"
        print(
            f"  {result.marker:<10}{result.passed:>7}{result.failed + result.errors:>7}"
            f"{result.skipped:>7}{result.seconds:>8.2f}s   {status}"
        )
    print("  " + "─" * (width - 2))
    total_passed = sum(r.passed for r in results)
    total_failed = sum(r.failed + r.errors for r in results)
    total_skipped = sum(r.skipped for r in results)
    total_time = sum(r.seconds for r in results)
    print(
        f"  {'total':<10}{total_passed:>7}{total_failed:>7}{total_skipped:>7}"
        f"{total_time:>8.2f}s"
    )
    print("═" * width)

    failed_parts = [r.marker for r in results if not r.ok]
    if failed_parts:
        print(f"  ❌ 失败阶段: {', '.join(failed_parts)}")
    else:
        print("  ✅ 全部通过")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="三阶段测试运行器")
    parser.add_argument("--part", choices=["1", "2", "3", "all"], default="all")
    parser.add_argument("--no-parity", action="store_true", help="跳过与 TypeScript 引擎的逐笔比对")
    parser.add_argument("--live", action="store_true", help="包含需要真实行情的用例")
    parser.add_argument("-v", "--verbose", action="store_true", help="始终打印完整 pytest 输出")
    parser.add_argument("-k", dest="keyword", default="", help="传给 pytest 的 -k 过滤表达式")
    args = parser.parse_args(argv)

    extra: list[str] = []
    if args.no_parity:
        extra += ["--deselect", "tests/part2_integration/test_ts_parity.py"]
    if args.live:
        extra.append("--live")
    if args.keyword:
        extra += ["-k", args.keyword]

    selected = [p for p in PARTS if args.part == "all" or p[0].endswith(args.part)]

    print("═" * 62)
    print("  ChanLun Python 后端 · 三阶段测试")
    print("═" * 62)

    results = [run_part(part, extra, args.verbose) for part in selected]
    print_summary(results)
    return 0 if all(r.ok for r in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
