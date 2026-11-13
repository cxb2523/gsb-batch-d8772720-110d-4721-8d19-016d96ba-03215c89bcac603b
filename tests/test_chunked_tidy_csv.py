"""Tests for chunked CSV reading and per-chunk tidy conversion."""

import shutil
import tempfile
import unittest
from pathlib import Path

import numpy as np
import pandas as pd

from syndat import (
    AllChunksFailedError,
    TidyReadResult,
    convert_data_to_tidy,
    read_csv_to_tidy,
)


def make_wide_long(n_patients=6, n_repi=2, n_timepoints=3):
    """Build a small deterministic wide-format longitudinal DataFrame."""
    rows = []
    for ptno in range(1, n_patients + 1):
        for repi in range(1, n_repi + 1):
            for time_index in range(n_timepoints):
                base = ptno * 100 + repi * 10 + time_index
                rows.append({
                    "PTNO": ptno,
                    "REPI": repi,
                    "TIME": float(time_index * 6),
                    "DRUG": "A" if ptno % 2 else "B",
                    "OBS_Long_Var1": base,
                    "REC_Long_Var1": base + 0.5,
                    "MASK_Long_Var1": int(time_index % 2 == 0),
                    "OBS_Long_Var2": -base,
                    "REC_Long_Var2": base + 1.25,
                    "MASK_Long_Var2": 1,
                })
    return pd.DataFrame(rows)


def make_wide_static(n_patients=8):
    """Build a small deterministic wide-format static DataFrame."""
    rows = []
    for ptno in range(1, n_patients + 1):
        rows.append({
            "PTNO": ptno,
            "REPI": 1,
            "OBS_Stat_Var1": ptno,
            "REC_Stat_Var1": ptno + 0.1,
            "MASK_Stat_Var1": int(ptno % 2),
            "OBS_Stat_Var2": -ptno,
            "REC_Stat_Var2": ptno - 0.2,
            "MASK_Stat_Var2": 1,
        })
    return pd.DataFrame(rows)


def long_aggregated(tidy_df):
    """Aggregate tidy longitudinal data by variable, subject and time."""
    return (
        tidy_df
        .groupby(["Variable", "SUBJID", "TIME"], as_index=False)["DV"]
        .sum()
        .sort_values(["Variable", "SUBJID", "TIME"])
        .reset_index(drop=True)
    )


def static_aggregated(tidy_df):
    """Aggregate tidy static data by variable and subject."""
    return (
        tidy_df
        .groupby(["Variable", "SUBJID"], as_index=False)["DV"]
        .sum()
        .sort_values(["Variable", "SUBJID"])
        .reset_index(drop=True)
    )


def frames_equal(left, right):
    """Compare frames ignoring row order and column dtype differences."""
    left = left.sort_values(list(left.columns)).reset_index(drop=True)
    right = right.sort_values(list(right.columns)).reset_index(drop=True)
    pd.testing.assert_frame_equal(left, right, check_dtype=False)


class TestReadCsvToTidyLong(unittest.TestCase):
    def setUp(self):
        self.temp_dir = Path(tempfile.mkdtemp(prefix="syndat_chunk_long_"))
        self.wide = make_wide_long()
        self.csv_path = self.temp_dir / "long_wide.csv"
        self.wide.to_csv(self.csv_path, index=False)
        self.reference = convert_data_to_tidy(
            self.wide, "long", only_pos=True, only_realtimes=False)

    def tearDown(self):
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_chunked_reading_matches_full_read_for_every_chunk_size(self):
        for chunksize in (1, 2, 5, 7, 100):
            with self.subTest(chunksize=chunksize):
                result = read_csv_to_tidy(
                    self.csv_path, "long", chunksize=chunksize,
                    only_pos=True, only_realtimes=False)

                self.assertIsInstance(result, TidyReadResult)

                # Boundary invariance: same tidy rows regardless of chunking.
                self.assertEqual(len(result.tidy), len(self.reference))
                frames_equal(result.tidy, self.reference)

                # Aggregated statistics per variable, subject and time match.
                pd.testing.assert_frame_equal(
                    long_aggregated(result.tidy),
                    long_aggregated(self.reference),
                    check_dtype=False)

                # Every chunk succeeded and the input row counts add up.
                self.assertTrue(result.chunk_report["success"].all())
                self.assertEqual(
                    result.chunk_report["input_rows"].sum(), len(self.wide))
                self.assertEqual(
                    result.chunk_report["output_rows"].sum(),
                    len(self.reference))
                expected_chunks = int(np.ceil(len(self.wide) / chunksize))
                self.assertEqual(len(result.chunk_report), expected_chunks)
                self.assertEqual(
                    result.chunk_report["chunk"].tolist(),
                    list(range(1, expected_chunks + 1)))
                self.assertTrue(
                    result.chunk_report["error"].isna().all())

    def test_only_realtimes_is_passed_through(self):
        full = convert_data_to_tidy(
            self.wide, "long", only_pos=False, only_realtimes=True)
        result = read_csv_to_tidy(
            self.csv_path, "long", chunksize=3,
            only_pos=False, only_realtimes=True)
        self.assertEqual(len(result.tidy), len(full))
        frames_equal(result.tidy, full)

    def test_only_pos_clips_negative_values(self):
        result = read_csv_to_tidy(
            self.csv_path, "long", chunksize=4, only_pos=True)
        self.assertTrue((result.tidy["DV"] >= 0).all())

    def test_bad_row_in_middle_chunk_does_not_abort_the_read(self):
        wide = make_wide_long(n_patients=4, n_repi=2, n_timepoints=3)
        chunksize = 4
        # Corrupt the TIME value of the first row of the second chunk.
        bad_index = chunksize
        lines = wide.to_csv(index=False).splitlines()
        header, data_lines = lines[0], lines[1:]
        time_position = wide.columns.get_loc("TIME")
        bad_fields = data_lines[bad_index].split(",")
        bad_fields[time_position] = ""
        data_lines[bad_index] = ",".join(bad_fields)
        bad_path = self.temp_dir / "long_wide_bad_chunk.csv"
        bad_path.write_text("\n".join([header, *data_lines]) + "\n")

        result = read_csv_to_tidy(bad_path, "long", chunksize=chunksize)

        self.assertEqual(len(result.chunk_report), 6)
        failed = result.chunk_report[~result.chunk_report["success"]]
        self.assertEqual(failed["chunk"].tolist(), [2])
        self.assertEqual(len(failed), 1)
        self.assertTrue(failed["error"].iloc[0])
        self.assertTrue(result.chunk_report["success"].sum() == 5)

        # Tidy output only contains the rows belonging to successful chunks.
        keep = np.ones(len(wide), dtype=bool)
        keep[chunksize:2 * chunksize] = False
        expected = convert_data_to_tidy(wide[keep].reset_index(drop=True),
                                        "long")
        frames_equal(result.tidy, expected)

    def test_all_chunks_failing_raises_explicit_exception(self):
        wide = make_wide_long(n_patients=3)
        wide["TIME"] = None
        path = self.temp_dir / "long_all_bad.csv"
        wide.to_csv(path, index=False)

        with self.assertRaises(AllChunksFailedError) as context:
            read_csv_to_tidy(path, "long", chunksize=5)

        report = context.exception.chunk_report
        self.assertFalse(report["success"].any())
        self.assertTrue(report["error"].notna().all())
        self.assertEqual(report["output_rows"].notna().sum(), 0)

    def test_missing_time_column_is_a_distinguishable_error(self):
        wide = make_wide_long().drop(columns=["TIME"])
        path = self.temp_dir / "long_no_time.csv"
        wide.to_csv(path, index=False)
        with self.assertRaises(ValueError) as context:
            read_csv_to_tidy(path, "long", chunksize=10)
        self.assertIn("TIME", str(context.exception))

    def test_missing_ptno_column_is_a_distinguishable_error(self):
        wide = make_wide_long().drop(columns=["PTNO"])
        path = self.temp_dir / "long_no_ptno.csv"
        wide.to_csv(path, index=False)
        with self.assertRaises(ValueError) as context:
            read_csv_to_tidy(path, "long", chunksize=10)
        self.assertIn("PTNO", str(context.exception))


class TestReadCsvToTidyStatic(unittest.TestCase):
    def setUp(self):
        self.temp_dir = Path(tempfile.mkdtemp(prefix="syndat_chunk_static_"))
        self.wide = make_wide_static()
        self.csv_path = self.temp_dir / "static_wide.csv"
        self.wide.to_csv(self.csv_path, index=False)
        self.reference = convert_data_to_tidy(
            self.wide, "static", only_pos=True, only_realtimes=False)

    def tearDown(self):
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_chunked_static_reading_matches_full_read(self):
        for chunksize in (1, 3, 5, 100):
            with self.subTest(chunksize=chunksize):
                result = read_csv_to_tidy(
                    self.csv_path, "static", chunksize=chunksize,
                    only_pos=True)
                self.assertEqual(len(result.tidy), len(self.reference))
                frames_equal(result.tidy, self.reference)
                pd.testing.assert_frame_equal(
                    static_aggregated(result.tidy),
                    static_aggregated(self.reference),
                    check_dtype=False)
                self.assertTrue(result.chunk_report["success"].all())

    def test_static_data_without_time_column_is_accepted(self):
        result = read_csv_to_tidy(self.csv_path, "static", chunksize=2)
        self.assertNotIn("TIME", result.tidy.columns)


class TestReadCsvToTidyValidation(unittest.TestCase):
    def setUp(self):
        self.temp_dir = Path(tempfile.mkdtemp(prefix="syndat_chunk_val_"))
        self.csv_path = self.temp_dir / "wide.csv"
        make_wide_long(n_patients=2).to_csv(self.csv_path, index=False)

    def tearDown(self):
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_chunksize_below_one_raises_value_error(self):
        for invalid_chunksize in (0, -1, -100):
            with self.subTest(chunksize=invalid_chunksize):
                with self.assertRaises(ValueError) as context:
                    read_csv_to_tidy(self.csv_path, "long",
                                     chunksize=invalid_chunksize)
                self.assertIn("chunksize", str(context.exception))

    def test_non_integer_chunksize_raises_value_error(self):
        for invalid_chunksize in (1.5, "10", None, True):
            with self.subTest(chunksize=invalid_chunksize):
                with self.assertRaises(ValueError):
                    read_csv_to_tidy(self.csv_path, "long",
                                     chunksize=invalid_chunksize)

    def test_invalid_data_type_raises_value_error(self):
        with self.assertRaises(ValueError) as context:
            read_csv_to_tidy(self.csv_path, "longitudinal", chunksize=10)
        self.assertIn("data_type", str(context.exception))

    def test_missing_file_raises_file_not_found_error(self):
        missing = self.temp_dir / "does_not_exist.csv"
        with self.assertRaises(FileNotFoundError):
            read_csv_to_tidy(missing, "long", chunksize=10)

    def test_file_without_data_rows_raises_value_error(self):
        empty_path = self.temp_dir / "empty.csv"
        make_wide_long(n_patients=1).head(0).to_csv(empty_path, index=False)
        with self.assertRaises(ValueError) as context:
            read_csv_to_tidy(empty_path, "long", chunksize=10)
        self.assertIn("No data rows", str(context.exception))


if __name__ == "__main__":
    unittest.main()
