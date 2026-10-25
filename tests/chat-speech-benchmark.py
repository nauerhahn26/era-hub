"""Metric checks use invented strings; measured transcripts stay outside the repo."""
import importlib.util
import pathlib
import sys
import unittest

sys.dont_write_bytecode = True
root = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("benchmark", root / "tools/chat-benchmark.py")


class MetricsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.module)

    def test_word_error_counts_deletion_and_negation(self):
        self.assertEqual(self.module.word_errors("I do not want it", "I do want it"), (1, 5))

    def test_empty_reference_counts_hallucination(self):
        self.assertEqual(self.module.word_errors("", "hello"), (1, 0))

    def test_meaning_checks_word_boundaries_and_negation(self):
        row = {"mustContain": ["not"], "mustNotContain": ["yes"]}
        self.assertFalse(self.module.meaning_ok(row, "nothing"))
        self.assertTrue(self.module.meaning_ok(row, "not today"))

    def test_percentiles_are_interpolated(self):
        self.assertEqual(self.module.percentile([10, 20, 30], .5), 20)
        self.assertEqual(self.module.percentile([10, 20, 30], .95), 29)

    def test_keyword_mentions_are_not_counted_as_acoustic_errors(self):
        rows = [{"mode": "negative_wake", "negativeType": kind, "wakeDetected": woke,
                 "firstPartialMs": None, "finalAfterFinishMs": None}
                for kind, woke in [("name_mention", True), ("phonetic", False)]]
        result = self.module.summarize(rows)["negativeWakeChecks"]
        self.assertEqual(result["acousticFalseActivations"], 0)
        self.assertEqual(result["nameMentionActivations"], 1)


if __name__ == "__main__":
    unittest.main()
