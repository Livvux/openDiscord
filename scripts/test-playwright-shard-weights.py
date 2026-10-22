"""Shard weights: duration-balanced contiguous split and CI log parsing."""
import importlib.util
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("weights", Path(__file__).with_name("playwright-shard-weights.py"))
weights = importlib.util.module_from_spec(spec)
spec.loader.exec_module(weights)


class ShardWeightsTest(unittest.TestCase):
    def test_long_test_gets_its_own_shard(self):
        counts, slowest = weights.split([100, 10, 10, 10, 10, 10, 10], 2)
        self.assertEqual(counts, [1, 6])
        self.assertAlmostEqual(slowest, 100, delta=0.5)

    def test_every_test_lands_on_exactly_one_shard(self):
        counts, _ = weights.split([1.0] * 10, 3)
        self.assertEqual(sum(counts), 10)

    def test_parses_list_reporter_units_and_retries(self):
        with tempfile.NamedTemporaryFile("w", suffix=".log", delete=False) as log:
            log.write("browser (1)\tshard\t2026-10-22T13:43:16Z   ✓  3 [desktop] › e2e/a.spec.ts:4:5 › a (1.5m)\n")
            log.write("browser (1)\tshard\t2026-10-22T13:43:17Z   ✘  4 [mobile] › e2e/b.spec.ts:9:7 › b (retry #1) (250ms)\n")
        known = weights.measured([log.name])
        self.assertEqual(known["[desktop] › a.spec.ts:4:5 › a"], 90)
        self.assertEqual(known["[mobile] › b.spec.ts:9:7 › b"], 0.25)


if __name__ == "__main__":
    unittest.main()
