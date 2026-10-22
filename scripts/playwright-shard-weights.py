#!/usr/bin/env python3
"""Balance PWTEST_SHARD_WEIGHTS on measured test durations.

Playwright shards by test count in --list order, so a few long DM/voice journeys can make one
shard far slower than the others. This prints per-shard test counts (usable directly as weights)
that minimise the slowest shard.

  gh run view <ci-run-id> --log > /tmp/ci.log            # one or more recent CI runs
  cd apps/web && npx playwright test --project=desktop --project=mobile --list > /tmp/list.txt
  python3 scripts/playwright-shard-weights.py 3 /tmp/list.txt /tmp/ci.log

Tests without a measured duration (runtime skips, new tests) count as 0.5 s.
"""
import re
import statistics
import sys
from collections import defaultdict

RESULT = re.compile(
    r"(?:✓|✘|-)\s+\d+\s+(?P<key>\[[a-z-]+\] › \S+ › .*?)(?: \(retry #\d+\))? \((?P<value>[\d.]+)(?P<unit>ms|s|m)\)\s*$"
)
SCALE = {"ms": 0.001, "s": 1, "m": 60}


def normalise(key: str) -> str:
    return re.sub(r"› e2e/", "› ", key).strip()


def measured(log_paths):
    samples = defaultdict(list)
    for path in log_paths:
        with open(path, errors="ignore") as log:
            for line in log:
                match = RESULT.search(line)
                if match:
                    samples[normalise(match["key"])].append(float(match["value"]) * SCALE[match["unit"]])
    return {key: statistics.median(values) for key, values in samples.items()}


def split(durations, shards):
    """Contiguous split whose largest shard total is minimal (binary search on the cap)."""

    def counts_for(cap):
        counts, index = [], 0
        for _ in range(shards):
            total, count = 0.0, 0
            while index < len(durations) and total + durations[index] <= cap:
                total += durations[index]
                index += 1
                count += 1
            counts.append(count)
        return counts if index == len(durations) else None

    low, high = max(durations, default=0), sum(durations)
    while high - low > 0.5:
        middle = (low + high) / 2
        if counts_for(middle):
            high = middle
        else:
            low = middle
    return counts_for(high), high


def main():
    if len(sys.argv) < 4:
        sys.exit(__doc__)
    shards = int(sys.argv[1])
    with open(sys.argv[2]) as listing:
        tests = [normalise(line) for line in listing if "›" in line]
    known = measured(sys.argv[3:])
    durations = [known.get(test, 0.5) for test in tests]
    counts, slowest = split(durations, shards)
    missing = sum(test not in known for test in tests)
    print(f"{len(tests)} tests, {missing} without timing, {sum(durations):.0f} s total, slowest shard {slowest:.0f} s")
    print(":".join(map(str, counts)))


if __name__ == "__main__":
    main()
