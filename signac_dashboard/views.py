# Copyright (c) 2022 The Regents of the University of Michigan
# All rights reserved.
# This software is licensed under the BSD 3-Clause License.

import os
import secrets
import threading
from collections import OrderedDict
from io import BytesIO

from flask import (
    abort,
    flash,
    g,
    jsonify,
    redirect,
    render_template,
    request,
    send_file,
    send_from_directory,
    session,
    url_for,
)

from .collect import (
    build_archive,
    collect_job_files,
    make_download_name,
    summary_to_dict,
)

# Archives built for a results page are cached so that the download link
# returns exactly the collection that is listed. The cache is bounded; the
# direct ``?format=zip`` endpoint never depends on it.
_MAX_CACHED_ARCHIVES = 16
_archive_cache: "OrderedDict[tuple, bytes]" = OrderedDict()
_archive_cache_lock = threading.Lock()


def _cache_archive(jobid, archive):
    """Cache an archive and return a URL that downloads it."""
    token = secrets.token_hex(16)
    with _archive_cache_lock:
        _archive_cache[(jobid, token)] = archive
        while len(_archive_cache) > _MAX_CACHED_ARCHIVES:
            _archive_cache.popitem(last=False)
    return url_for("download_collection", jobid=jobid, collection_id=token)


def _cached_archive(jobid, token):
    """Return a cached archive, or :code:`None` when it is unavailable."""
    with _archive_cache_lock:
        return _archive_cache.get((jobid, token))


def home(dashboard):
    return redirect(url_for("project_info"))


def search(dashboard):
    g.query = request.args.get("q", None)
    jobs = []
    try:
        if request.method != "GET":
            # Someday we may support search via POST, returning json
            raise NotImplementedError("Unsupported search method.")
        jobs = dashboard._job_search(g.query)
        if not jobs:
            flash("No jobs found for the provided query.", "warning")
    except Exception as error:
        return dashboard._render_error(error)
    else:
        g.pagination = dashboard._setup_pagination(jobs)
        g.jobs = dashboard._get_job_details(g.pagination.paginate(jobs))
        g.title = f"Search: {g.query}"
        g.subtitle = g.pagination.item_counts()
        return dashboard._render_job_view(default_view="list")


def jobs_list(dashboard):
    jobs = dashboard._get_all_jobs()
    g.pagination = dashboard._setup_pagination(jobs)
    if not jobs:
        flash("No jobs found.", "warning")
    g.jobs = dashboard._get_job_details(g.pagination.paginate(jobs))
    g.title = "signac-dashboard: Jobs"
    g.subtitle = g.pagination.item_counts()
    return dashboard._render_job_view(default_view="list")


def project_info(dashboard):
    g.project = dashboard.project
    g.title = "signac-dashboard"
    num_jobs = len(dashboard.project)
    g.subtitle = f"{num_jobs} jobs"
    return dashboard._render_project_view()


def show_job(dashboard, jobid):
    try:
        job = dashboard.project.open_job(id=jobid)
    except KeyError:
        abort(404, "The job id requested could not be found.")
    else:
        g.jobs = dashboard._get_job_details([job])
        g.title = g.jobs[0]["title"]
        g.subtitle = g.jobs[0]["subtitle"]
        return dashboard._render_job_view(default_view="grid")


def get_file(dashboard, filename, jobid=None):
    if jobid is not None:
        try:
            job_or_project = dashboard.project.open_job(id=jobid)
        except KeyError:
            abort(404, "The job id requested could not be found.")
        except LookupError:
            dashboard.project.find_jobs()
            abort(404, "Multiple jobs match the requested job id.")
    else:
        job_or_project = dashboard.project
    if job_or_project.isfile(filename):
        directory = job_or_project.fn("")
        mimetype = None
        max_age = 0
        download_name = request.args.get("download_name", filename)
        return send_from_directory(
            directory=directory,
            path=filename,
            mimetype=mimetype,
            max_age=max_age,
            conditional=True,
            download_name=download_name,
        )
    else:
        abort(404, "The file requested does not exist.")


def _collect_error(message, fmt):
    """Return an error response for a failed collection request.

    The dashboard's error handler renders error pages with status 200, so the
    404 status is set explicitly here. An unresolvable job id must not produce
    an archive, regardless of the requested format.
    """
    if fmt == "json":
        return jsonify({"error": message}), 404
    if fmt == "zip":
        return message, 404
    g.active_page = "jobs"
    g.title = "Collection failed"
    return render_template("collect_error.html", message=message), 404


def _resolve_job(dashboard, jobid):
    """Return ``(job, error_message)`` for a job id.

    An id that cannot be resolved leaves the job as :code:`None` and provides
    a message describing the failure. A job whose workspace directory no
    longer exists is treated as unresolvable as well.
    """
    try:
        job = dashboard.project.open_job(id=jobid)
    except KeyError:
        return None, "The job id requested could not be found."
    except LookupError:
        dashboard.project.find_jobs()
        return None, "Multiple jobs match the requested job id."
    except Exception:
        return None, "The job id requested could not be found."

    if not os.path.isdir(job.path):
        return None, "The job id requested could not be found."
    return job, None


def _download_name_func(dashboard):
    """Return the callable used to name files inside a collected archive.

    The naming rule follows the :class:`~signac_dashboard.modules.FileList`
    module when it is configured, and defaults to prefixing with the job id.
    """
    from .modules.file_list import FileList

    for module in dashboard.modules:
        if isinstance(module, FileList):
            return module.download_name
    return lambda job, filename: make_download_name(job, filename)


def collect_job(dashboard, jobid):
    """Collect every file in a job directory into a zip archive.

    The per-file outcome is displayed on a results page. Requesting
    :code:`?format=zip` returns the archive itself and
    :code:`?format=json` returns the results as JSON.
    """
    fmt = request.args.get("format", "html").lower()
    job, error_message = _resolve_job(dashboard, jobid)
    if job is None:
        return _collect_error(error_message, fmt)

    try:
        summary = collect_job_files(job, download_name=_download_name_func(dashboard))
        archive = build_archive(summary)
    except Exception as error:
        return dashboard._render_error(error)

    if fmt == "zip":
        return send_file(
            BytesIO(archive),
            mimetype="application/zip",
            as_attachment=True,
            download_name=f"{jobid}_files.zip",
        )
    if fmt == "json":
        data = summary_to_dict(summary)
        data["archive_url"] = url_for("collect_job", jobid=jobid, format="zip")
        return jsonify(data)

    archive_url = _cache_archive(jobid, archive)
    g.active_page = "jobs"
    g.title = f"Collect files: {jobid}"
    g.subtitle = (
        f"{summary['packaged']} of {summary['total']} files collected"
        if summary["total"]
        else "0 files"
    )
    return render_template(
        "collect_results.html",
        summary=summary,
        results_json=summary_to_dict(summary),
        archive_url=archive_url,
        jobid=jobid,
    )


def download_collection(dashboard, jobid, collection_id):
    """Download the archive produced by a particular collection.

    The cached archive is returned when it is still available; otherwise the
    collection is repeated so that the link keeps working across processes
    and after the cache has been recycled.
    """
    archive = _cached_archive(jobid, collection_id)
    if archive is None:
        job, error_message = _resolve_job(dashboard, jobid)
        if job is None:
            return _collect_error(error_message, "zip")
        try:
            summary = collect_job_files(
                job, download_name=_download_name_func(dashboard)
            )
            archive = build_archive(summary)
        except Exception as error:
            return dashboard._render_error(error)
    return send_file(
        BytesIO(archive),
        mimetype="application/zip",
        as_attachment=True,
        download_name=f"{jobid}_files.zip",
    )


def change_modules(dashboard):
    enabled_module_indices = session.get(
        "enabled_module_indices", dashboard._setup_enabled_module_indices()
    )
    enabled_module_indices = {
        k: set(v) for k, v in enabled_module_indices.items()
    }  # remove duplicates
    context = session.get("context", "JobContext")

    for i, module in enumerate(dashboard._modules_by_context[context]):
        if request.form.get(f"modules[{i}]") == "on":
            enabled_module_indices[context].add(i)
        else:
            enabled_module_indices[context].discard(i)

    session["enabled_module_indices"] = {
        k: list(v) for k, v in enabled_module_indices.items()
    }
    return redirect(request.form.get("redirect", url_for("home")))


def settings(dashboard):
    g.active_page = "settings"
    return render_template("settings.html")


def page_not_found(dashboard, error):
    return dashboard._render_error(str(error))
