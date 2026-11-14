# Copyright (c) 2022 The Regents of the University of Michigan
# All rights reserved.
# This software is licensed under the BSD 3-Clause License.
"""Collect all files from a job directory into an archive.

The functions in this module implement the server side of the "collect"
feature. :func:`collect_job_files` walks the job directory, retrieving every
regular file once and recording the outcome for each entry. Only successfully
retrieved files are included in the archive built by :func:`build_archive`.
"""

import os
import stat
import zipfile
from io import BytesIO

# Outcomes that are recorded for every entry of the job directory.
STATUS_SUCCESS = "success"
STATUS_MISSING = "missing"
STATUS_OUT_OF_BOUNDS = "out_of_bounds"
STATUS_READ_FAILED = "read_failed"
STATUS_SKIPPED_DIRECTORY = "skipped_directory"
STATUS_SKIPPED_SYMLINK = "skipped_symlink"
STATUS_SKIPPED_SPECIAL = "skipped_special"

STATUS_LABELS = {
    STATUS_SUCCESS: "Success",
    STATUS_MISSING: "File not found",
    STATUS_OUT_OF_BOUNDS: "Path out of bounds",
    STATUS_READ_FAILED: "Read failed",
    STATUS_SKIPPED_DIRECTORY: "Skipped: directory",
    STATUS_SKIPPED_SYMLINK: "Skipped: symbolic link",
    STATUS_SKIPPED_SPECIAL: "Skipped: not a regular file",
}


def make_download_name(job, filename, prefix_jobid=True):
    """Return the download name for a file, matching single-file downloads.

    :param job: The job that contains the file.
    :type job: :py:class:`signac.job.Job`
    :param filename: Name of the file within the job directory.
    :type filename: str
    :param prefix_jobid: Whether the job id should be prepended to the name
        (default: :code:`True`).
    :type prefix_jobid: bool
    :returns: The name used when the file is downloaded.
    :rtype: str
    """
    if prefix_jobid:
        return f"{job}_{filename}"
    return filename


def sanitize_archive_name(name):
    """Reduce a name to a safe archive member name.

    Only the final path component is kept and both path separators are
    removed. This prevents a custom naming rule from producing archive members
    that would be extracted outside of the destination directory (zip slip).
    An empty result falls back to ``file``.

    :param name: The desired member name.
    :type name: str
    :returns: A safe archive member name.
    :rtype: str
    """
    name = str(name).replace("\\", "/").split("/")[-1]
    name = name.strip()
    if name in ("", ".", ".."):
        return "file"
    return name


def unique_archive_name(name, used_names):
    """Return an archive name that does not collide with ``used_names``.

    If ``name`` is already taken, a numeric suffix is inserted before the file
    extension (``report.txt`` becomes ``report_1.txt``). The returned name is
    added to ``used_names``. The name is sanitized before use.

    :param name: Desired archive member name.
    :type name: str
    :param used_names: Names that have already been assigned in the archive.
    :type used_names: set
    :returns: A unique archive member name.
    :rtype: str
    """
    name = sanitize_archive_name(name)
    if name not in used_names:
        used_names.add(name)
        return name

    stem, extension = os.path.splitext(name)
    index = 1
    while f"{stem}_{index}{extension}" in used_names:
        index += 1
    unique_name = f"{stem}_{index}{extension}"
    used_names.add(unique_name)
    return unique_name


def _is_within(path, directory):
    """Return whether ``path`` resolves to a location inside ``directory``."""
    resolved_path = os.path.realpath(path)
    resolved_directory = os.path.realpath(directory)
    try:
        return os.path.commonpath([resolved_path, resolved_directory]) == (
            resolved_directory
        )
    except ValueError:
        # Raised by commonpath when the paths are on different drives.
        return False


def _read_file(path):
    """Read and return the contents of a regular file.

    The file is opened without following a symbolic link (where the platform
    supports :data:`os.O_NOFOLLOW`) and the opened descriptor is checked to be
    a regular file, so that a link swapped in after inspection cannot cause a
    file outside of the job directory to be read.

    This indirection also allows read failures to be simulated in tests.
    """
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0)
    flags |= getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags)
    with os.fdopen(descriptor, "rb") as file:
        file_stat = os.fstat(file.fileno())
        if not stat.S_ISREG(file_stat.st_mode):
            raise OSError("Not a regular file.")
        return file.read()


def _result(name, status, reason=None):
    return {
        "name": name,
        "status": status,
        "status_label": STATUS_LABELS[status],
        "reason": reason,
    }


def _collect_entry(name, directory):
    """Retrieve a single directory entry and record its outcome."""
    path = os.path.join(directory, name)
    try:
        entry_stat = os.lstat(path)
    except FileNotFoundError:
        return _result(name, STATUS_MISSING, "The file does not exist.")
    except OSError as error:
        return _result(name, STATUS_READ_FAILED, f"Could not inspect file: {error}")

    mode = entry_stat.st_mode

    if stat.S_ISLNK(mode):
        # Symbolic links are never followed, whether they point inside or
        # outside of the job directory.
        if not _is_within(path, directory):
            return _result(
                name,
                STATUS_OUT_OF_BOUNDS,
                "Symbolic link resolves outside the job directory.",
            )
        return _result(
            name,
            STATUS_SKIPPED_SYMLINK,
            "Symbolic links are not collected.",
        )

    if stat.S_ISDIR(mode):
        return _result(
            name,
            STATUS_SKIPPED_DIRECTORY,
            "Directories are not collected.",
        )

    if not stat.S_ISREG(mode):
        return _result(
            name,
            STATUS_SKIPPED_SPECIAL,
            "Only regular files are collected.",
        )

    if not _is_within(path, directory):
        return _result(
            name,
            STATUS_OUT_OF_BOUNDS,
            "Path resolves outside the job directory.",
        )

    try:
        data = _read_file(path)
    except FileNotFoundError:
        return _result(name, STATUS_MISSING, "The file does not exist.")
    except PermissionError as error:
        return _result(name, STATUS_READ_FAILED, f"Permission denied: {error}")
    except OSError as error:
        return _result(name, STATUS_READ_FAILED, f"Could not read file: {error}")

    result = _result(name, STATUS_SUCCESS)
    result["size"] = len(data)
    result["data"] = data
    return result


def collect_job_files(job, prefix_jobid=True, download_name=None):
    """Collect every entry in a job directory and record its outcome.

    Entries are visited in filename order. Directories, symbolic links and
    paths that resolve outside of the job directory are never read; they are
    reported as skipped together with the reason.

    :param job: The job whose directory is collected.
    :type job: :py:class:`signac.job.Job`
    :param prefix_jobid: Whether archive names should be prefixed with the job
        id, matching single-file downloads (default: :code:`True`).
    :type prefix_jobid: bool
    :param download_name: Optional callable that maps ``(job, filename)`` to
        the name used inside the archive. When given, it takes precedence over
        ``prefix_jobid``.
    :type download_name: callable
    :returns: A summary dictionary with keys ``jobid``, ``total``,
        ``packaged``, ``skipped`` and ``results``. Each entry of ``results``
        is a dictionary with the keys ``name``, ``status``, ``status_label``
        and ``reason``; successfully collected files additionally carry
        ``archive_name``, ``size`` and (transiently) ``data``.
    :rtype: dict
    """
    directory = os.fspath(job.path)

    if download_name is None:

        def download_name(job, filename):
            return make_download_name(job, filename, prefix_jobid)

    try:
        with os.scandir(directory) as entries:
            names = sorted(entry.name for entry in entries)
    except (FileNotFoundError, NotADirectoryError):
        names = []

    results = [_collect_entry(name, directory) for name in names]

    used_names = set()
    for result in results:
        if result["status"] == STATUS_SUCCESS:
            desired_name = download_name(job, result["name"])
            result["archive_name"] = unique_archive_name(desired_name, used_names)

    packaged = sum(1 for result in results if result["status"] == STATUS_SUCCESS)
    return {
        "jobid": str(job.id),
        "total": len(results),
        "packaged": packaged,
        "skipped": len(results) - packaged,
        "results": results,
    }


def build_archive(summary):
    """Build a zip archive containing the successfully collected files.

    The archive is built in memory and returned as bytes. An empty result set
    produces a valid, empty zip archive.

    :param summary: A summary returned by :func:`collect_job_files`.
    :type summary: dict
    :returns: The zip archive.
    :rtype: bytes
    """
    buffer = BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for result in summary["results"]:
            if result["status"] == STATUS_SUCCESS:
                archive.writestr(result["archive_name"], result["data"])
    return buffer.getvalue()


def summary_to_dict(summary):
    """Return a JSON-serializable copy of a collection summary."""
    return {
        "jobid": summary["jobid"],
        "total": summary["total"],
        "packaged": summary["packaged"],
        "skipped": summary["skipped"],
        "results": [
            {key: value for key, value in result.items() if key != "data"}
            for result in summary["results"]
        ],
    }
