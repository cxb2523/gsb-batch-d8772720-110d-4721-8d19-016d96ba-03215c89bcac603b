# Copyright (c) 2022 The Regents of the University of Michigan
# All rights reserved.
# This software is licensed under the BSD 3-Clause License.
import io
import os
import re
import shutil
import tempfile
import unittest
import zipfile
from unittest import mock

import signac

import signac_dashboard.modules
from signac_dashboard import Dashboard
from signac_dashboard.collect import (
    STATUS_MISSING,
    STATUS_OUT_OF_BOUNDS,
    STATUS_READ_FAILED,
    STATUS_SKIPPED_DIRECTORY,
    STATUS_SKIPPED_SPECIAL,
    STATUS_SUCCESS,
    unique_archive_name,
)


class CollectTestCase(unittest.TestCase):
    """Base class creating a local signac project with a single job."""

    def setUp(self):
        self._tmp_dir = tempfile.mkdtemp()
        self.project = signac.init_project(os.path.join(self._tmp_dir, "project"))
        self.job = self.project.open_job({"a": 0}).init()
        self.addCleanup(shutil.rmtree, self._tmp_dir, True)

    def make_dashboard(self, modules=None):
        self.dashboard = Dashboard(
            config={"ACCESS_TOKEN": None},
            project=self.project,
            modules=modules or [],
        )
        self.test_client = self.dashboard.app.test_client()

    def write_file(self, name, content="data"):
        path = os.path.join(self.job.path, name)
        with open(path, "w") as file:
            file.write(content)
        return path

    def collect_json(self, jobid=None, **kwargs):
        jobid = jobid or self.job.id
        rv = self.test_client.get(
            f"/jobs/{jobid}/collect", query_string={"format": "json", **kwargs}
        )
        return rv

    def collect_zip(self, jobid=None):
        jobid = jobid or self.job.id
        rv = self.test_client.get(
            f"/jobs/{jobid}/collect", query_string={"format": "zip"}
        )
        self.assertEqual(rv.status_code, 200)
        return zipfile.ZipFile(io.BytesIO(rv.get_data()))


class CollectArchiveTestCase(CollectTestCase):
    def setUp(self):
        super().setUp()
        self.write_file("b.txt", "bbb")
        self.write_file("a.txt", "aaa")
        self.make_dashboard()

    def test_archive_contains_all_files_with_prefixed_names(self):
        archive = self.collect_zip()
        names = archive.namelist()
        assert names == sorted(names), names
        assert f"{self.job.id}_a.txt" in names
        assert f"{self.job.id}_b.txt" in names
        assert archive.read(f"{self.job.id}_a.txt") == b"aaa"
        assert archive.read(f"{self.job.id}_b.txt") == b"bbb"

    def test_archive_names_match_single_file_download_rule(self):
        rv = self.test_client.get(
            f"/jobs/{self.job.id}/file/a.txt",
            query_string={"download_name": f"{self.job.id}_a.txt"},
        )
        assert rv.status_code == 200
        disposition = rv.headers.get("Content-Disposition", "")
        assert f"{self.job.id}_a.txt" in disposition
        assert f"{self.job.id}_a.txt" in self.collect_zip().namelist()

    def test_results_list_every_entry_in_collection_order(self):
        response = self.test_client.get(f"/jobs/{self.job.id}/collect").get_data()
        text = response.decode()
        names = [r["name"] for r in self.collect_json().get_json()["results"]]
        assert "signac_statepoint.json" in names
        positions = [text.index(f"<td>{name}</td>") for name in names]
        assert positions == sorted(positions)
        # Successful entries must be listed with their outcome.
        assert "Success" in text

    def test_json_summary_counts(self):
        data = self.collect_json().get_json()
        assert data["jobid"] == self.job.id
        assert data["total"] == len(data["results"])
        successful = [r for r in data["results"] if r["status"] == STATUS_SUCCESS]
        assert data["packaged"] == len(successful)
        assert data["packaged"] >= 2
        assert data["skipped"] == data["total"] - data["packaged"]
        assert data["archive_url"].endswith("format=zip")

    def test_directories_are_skipped(self):
        subdir = os.path.join(self.job.path, "subdir")
        os.makedirs(subdir)
        with open(os.path.join(subdir, "nested.txt"), "w") as file:
            file.write("nested")
        data = self.collect_json().get_json()
        entry = next(r for r in data["results"] if r["name"] == "subdir")
        assert entry["status"] == STATUS_SKIPPED_DIRECTORY
        assert entry["reason"]
        # Directory contents are not walked or collected.
        assert "nested.txt" not in [r["name"] for r in data["results"]]
        assert "nested.txt" not in "".join(self.collect_zip().namelist())

    def test_read_failure_is_reported(self):
        from signac_dashboard import collect as collect_module

        original_read = collect_module._read_file

        def failing_read(path):
            if path.endswith("b.txt"):
                raise PermissionError("nope")
            return original_read(path)

        with mock.patch.object(collect_module, "_read_file", failing_read):
            data = self.collect_json().get_json()
            entry = next(r for r in data["results"] if r["name"] == "b.txt")
            assert entry["status"] == STATUS_READ_FAILED
            assert entry["reason"]
            assert self.collect_json().status_code == 200

    def test_missing_file_is_reported_distinctly(self):
        from signac_dashboard import collect as collect_module

        original_lstat = collect_module.os.lstat

        def vanishing_lstat(path):
            if path.endswith("a.txt"):
                raise FileNotFoundError(path)
            return original_lstat(path)

        with mock.patch.object(collect_module.os, "lstat", vanishing_lstat):
            data = self.collect_json().get_json()
            names = self.collect_zip().namelist()
        entry = next(r for r in data["results"] if r["name"] == "a.txt")
        assert entry["status"] == STATUS_MISSING
        assert entry["reason"]
        assert STATUS_MISSING != STATUS_READ_FAILED
        assert not any("a.txt" in name for name in names)

    @unittest.skipUnless(hasattr(os, "symlink"), "symbolic links are unavailable")
    def test_symlink_out_of_bounds_is_skipped(self):
        outside = os.path.join(self._tmp_dir, "outside.txt")
        with open(outside, "w") as file:
            file.write("secret")
        link = os.path.join(self.job.path, "escape.txt")
        try:
            os.symlink(outside, link)
        except (OSError, NotImplementedError) as error:
            self.skipTest(f"Could not create a symbolic link: {error}")

        data = self.collect_json().get_json()
        entry = next(r for r in data["results"] if r["name"] == "escape.txt")
        assert entry["status"] == STATUS_OUT_OF_BOUNDS
        assert entry["reason"]
        names = self.collect_zip().namelist()
        assert not any("escape.txt" in name for name in names)
        assert self.collect_zip().read(f"{self.job.id}_a.txt") == b"aaa"

    @unittest.skipUnless(hasattr(os, "symlink"), "symbolic links are unavailable")
    def test_symlink_inside_job_directory_is_not_read(self):
        target = self.write_file("target.txt", "target")
        link = os.path.join(self.job.path, "link.txt")
        try:
            os.symlink(target, link)
        except (OSError, NotImplementedError) as error:
            self.skipTest(f"Could not create a symbolic link: {error}")

        data = self.collect_json().get_json()
        entry = next(r for r in data["results"] if r["name"] == "link.txt")
        assert entry["status"] not in (STATUS_SUCCESS, STATUS_OUT_OF_BOUNDS)
        assert entry["reason"]

    @unittest.skipUnless(hasattr(os, "mkfifo"), "named pipes are unavailable")
    def test_non_regular_files_are_skipped(self):
        fifo = os.path.join(self.job.path, "fifo")
        try:
            os.mkfifo(fifo)
        except OSError as error:
            self.skipTest(f"Could not create a named pipe: {error}")

        data = self.collect_json().get_json()
        entry = next(r for r in data["results"] if r["name"] == "fifo")
        assert entry["status"] == STATUS_SKIPPED_SPECIAL
        assert entry["reason"]
        assert "fifo" not in self.collect_zip().namelist()


class CollectEmptyDirectoryTestCase(CollectTestCase):
    def setUp(self):
        super().setUp()
        # An initialized job always holds its state point file; removing it
        # leaves an existing but empty job directory.
        os.remove(os.path.join(self.job.path, "signac_statepoint.json"))
        self.make_dashboard()

    def test_empty_directory_returns_empty_archive(self):
        rv = self.test_client.get(f"/jobs/{self.job.id}/collect")
        assert rv.status_code == 200
        assert b"0 files" in rv.get_data()

        archive = self.collect_zip()
        assert archive.namelist() == []

    def test_empty_directory_json_reports_zero_files(self):
        data = self.collect_json().get_json()
        assert data["total"] == 0
        assert data["packaged"] == 0
        assert data["results"] == []


class CollectUnknownJobTestCase(CollectTestCase):
    unknown_id = "0" * 32

    def setUp(self):
        super().setUp()
        self.write_file("a.txt")
        self.make_dashboard()

    def test_unknown_job_returns_404_page(self):
        rv = self.test_client.get(f"/jobs/{self.unknown_id}/collect")
        assert rv.status_code == 404
        assert b"could not be found" in rv.get_data().lower()

    def test_unknown_job_returns_404_without_archive(self):
        rv = self.test_client.get(
            f"/jobs/{self.unknown_id}/collect", query_string={"format": "zip"}
        )
        assert rv.status_code == 404
        assert rv.mimetype != "application/zip"
        # The response must not be a readable zip archive.
        with self.assertRaises(zipfile.BadZipFile):
            zipfile.ZipFile(io.BytesIO(rv.get_data())).namelist()

    def test_unknown_job_json_returns_404(self):
        rv = self.collect_json(jobid=self.unknown_id)
        assert rv.status_code == 404
        assert "error" in rv.get_json()

    def test_removed_job_directory_returns_404(self):
        shutil.rmtree(self.job.path)
        rv = self.test_client.get(f"/jobs/{self.job.id}/collect")
        assert rv.status_code == 404


class CollectNamingTestCase(CollectTestCase):
    def test_unique_archive_name_avoids_collisions(self):
        used = set()
        assert unique_archive_name("a.txt", used) == "a.txt"
        assert unique_archive_name("a.txt", used) == "a_1.txt"
        assert unique_archive_name("a.txt", used) == "a_2.txt"
        assert used == {"a.txt", "a_1.txt", "a_2.txt"}

    def test_archive_names_cannot_escape_the_archive(self):
        used = set()
        assert unique_archive_name("../../evil.txt", used) == "evil.txt"
        assert unique_archive_name("..\\..\\evil2.txt", used) == "evil2.txt"
        assert unique_archive_name("/etc/passwd", used) == "passwd"
        assert ".." not in "".join(used)
        assert not any(name.startswith("/") for name in used)

    def test_colliding_download_names_do_not_overwrite(self):
        self.write_file("a.txt", "aaa")
        self.write_file("b.txt", "bbb")

        class FlatFileList(signac_dashboard.modules.FileList):
            def download_name(self, job, filename):
                return "same.txt"

        self.make_dashboard(modules=[FlatFileList()])
        archive = self.collect_zip()
        names = archive.namelist()
        # Every collected entry gets a distinct name; none overwrites another.
        assert len(names) == len(set(names))
        expected = {
            r["name"]: r["archive_name"]
            for r in self.collect_json().get_json()["results"]
            if r["status"] == STATUS_SUCCESS
        }
        assert set(names) == set(expected.values())
        assert archive.read(expected["a.txt"]) == b"aaa"
        assert archive.read(expected["b.txt"]) == b"bbb"

    def test_file_list_card_links_to_collection(self):
        self.write_file("a.txt")
        self.make_dashboard(modules=[signac_dashboard.modules.FileList()])
        response = self.test_client.get(f"/jobs/{self.job.id}").get_data().decode()
        assert f"/jobs/{self.job.id}/collect" in response

    def test_file_list_prefix_disabled_is_respected(self):
        self.write_file("a.txt")
        self.make_dashboard(
            modules=[signac_dashboard.modules.FileList(prefix_jobid=False)]
        )
        names = self.collect_zip().namelist()
        assert "a.txt" in names
        assert "signac_statepoint.json" in names
        assert not any(name.startswith(self.job.id) for name in names)

    def test_results_page_archive_link_matches_listed_results(self):
        self.write_file("a.txt", "aaa")
        self.make_dashboard()
        html = self.test_client.get(f"/jobs/{self.job.id}/collect").get_data()
        match = re.search(rb'href="(/jobs/.*?collect/.*?\.zip)"', html)
        assert match, "The results page must link to an archive"
        rv = self.test_client.get(match.group(1).decode())
        assert rv.status_code == 200
        archive = zipfile.ZipFile(io.BytesIO(rv.get_data()))
        assert f"{self.job.id}_a.txt" in archive.namelist()

    def test_archive_link_survives_cache_eviction(self):
        from signac_dashboard import views

        self.write_file("a.txt", "aaa")
        self.make_dashboard()
        html = self.test_client.get(f"/jobs/{self.job.id}/collect").get_data()
        link = re.search(rb'href="(/jobs/.*?collect/.*?\.zip)"', html).group(1)
        views._archive_cache.clear()
        rv = self.test_client.get(link.decode())
        assert rv.status_code == 200
        archive = zipfile.ZipFile(io.BytesIO(rv.get_data()))
        assert f"{self.job.id}_a.txt" in archive.namelist()

    def test_archive_link_of_unknown_job_returns_404(self):
        self.make_dashboard()
        rv = self.test_client.get(f"/jobs/{'0' * 32}/collect/{'0' * 32}.zip")
        assert rv.status_code == 404

    def test_results_page_lists_success_and_failure_entries(self):
        self.write_file("a.txt")
        os.makedirs(os.path.join(self.job.path, "subdir"))
        self.make_dashboard()
        html = self.test_client.get(f"/jobs/{self.job.id}/collect").get_data().decode()
        assert "<td>a.txt</td>" in html
        assert "Success" in html
        assert "<td>subdir</td>" in html
        assert "Directories are not collected." in html


if __name__ == "__main__":
    unittest.main()
