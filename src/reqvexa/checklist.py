"""Read-only analysis checklists for hand-off reviews.

A checklist is a deterministic, serializable summary of the request plan
behind one target request. It lists every planned request in capture order
with the state values each one consumes and produces, and separately lists
the values whose source never appears in the capture.

Value contents are masked by default; only stable summaries (a SHA-256
digest and a masked display) and a status are emitted. Pass
``unsafe_raw=True`` to additionally include the original captured value.

Two depths are supported:

* ``recursive`` (the default): prerequisite requests are expanded and the
  values they consume are followed back to their own producers.
* ``one_level``: only the target and the first request in which each target
  value appeared are kept; values consumed by those producers are not
  expanded further.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from reqvexa.planning import (
    FlowPlan,
    _observation_versions,
    _producer_request_id,
    _trace_versions,
    plan_flow,
    safe_path,
    value_name,
)
from reqvexa.provenance import Analysis

DEPTH_RECURSIVE = "recursive"
DEPTH_ONE_LEVEL = "one_level"
CHECKLIST_SCHEMA_VERSION = 1


@dataclass(frozen=True)
class ChecklistValue:
    """One value version as referenced by a checklist step.

    ``raw_value`` is omitted entirely from :meth:`to_dict` unless the
    checklist was built with ``unsafe_raw=True``; producers are never
    embedded here, so an unresolved value cannot gain a fabricated source.
    """

    name: str
    value_id: str
    version_id: str
    status: str
    masked_value: str
    value_digest: str
    raw_value: str | None = None

    def to_dict(self, unsafe_raw: bool) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "name": self.name,
            "value_id": self.value_id,
            "version_id": self.version_id,
            "status": self.status,
            "masked_value": self.masked_value,
            "value_digest": self.value_digest,
        }
        if unsafe_raw:
            payload["raw_value"] = self.raw_value
        return payload


@dataclass(frozen=True)
class ChecklistStep:
    request_id: str
    sequence: int
    depth: int
    method: str
    path: str
    role: str
    consumes: tuple[ChecklistValue, ...]
    produces: tuple[ChecklistValue, ...]

    def to_dict(self, unsafe_raw: bool) -> dict[str, Any]:
        return {
            "request_id": self.request_id,
            "sequence": self.sequence,
            "depth": self.depth,
            "method": self.method,
            "path": self.path,
            "role": self.role,
            "consumes": [value.to_dict(unsafe_raw) for value in self.consumes],
            "produces": [value.to_dict(unsafe_raw) for value in self.produces],
        }


@dataclass(frozen=True)
class AnalysisChecklist:
    """Serializable checklist; a pure, read-only function of an analysis."""

    target_request_id: str
    depth: str
    unsafe_raw: bool
    steps: tuple[ChecklistStep, ...]
    unresolved_values: tuple[ChecklistValue, ...]
    warnings: tuple[str, ...]

    @property
    def mode(self) -> str:
        """Stable alias for the depth label."""
        return self.depth

    @property
    def max_step_depth(self) -> int:
        return max((step.depth for step in self.steps), default=0)

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema_version": CHECKLIST_SCHEMA_VERSION,
            "target_request_id": self.target_request_id,
            "depth": self.depth,
            "mode": self.depth,
            "max_step_depth": self.max_step_depth,
            "unsafe_raw": self.unsafe_raw,
            "steps": [step.to_dict(self.unsafe_raw) for step in self.steps],
            "unresolved_values": [
                value.to_dict(self.unsafe_raw) for value in self.unresolved_values
            ],
            "warnings": list(self.warnings),
        }


def build_checklist(analysis: Analysis, target_request_id: str, *,
                    recursive: bool | None = None,
                    unsafe_raw: bool = False) -> AnalysisChecklist:
    """Build the hand-off checklist for one target request.

    ``recursive=None`` inherits the depth the analysis was built with;
    pass ``recursive=False`` for the one-level mode. The checklist never
    mutates the analysis and performs no I/O.
    """
    if recursive is None:
        recursive = analysis.recursive
    depth_label = DEPTH_RECURSIVE if recursive else DEPTH_ONE_LEVEL
    trace = analysis.trace(target_request_id, recursive=recursive)
    plan = plan_flow(analysis, target_request_id, trace=trace, recursive=recursive)

    def checklist_value(version_id: str) -> ChecklistValue:
        version = analysis.versions[version_id]
        node = analysis._flat_trace_version(version_id)
        return ChecklistValue(
            name=value_name(analysis, version.value_id),
            value_id=version.value_id,
            version_id=version.version_id,
            status=node.status,
            masked_value=version.display_value,
            value_digest=version.value_digest,
            raw_value=version.raw_value if unsafe_raw else None,
        )

    matching = _observation_versions(analysis)
    # Same trace-version scope plan_flow uses for its produced mapping, so a
    # request can only "produce" values that this target's chain requires.
    produced_by_request: dict[str, set[str]] = {}
    for version_id in _trace_versions(trace):
        for hypothesis in analysis.target_producers.get(version_id, ()):
            produced_by_request.setdefault(
                _producer_request_id(analysis, hypothesis.producer), set(),
            ).add(version_id)

    steps = tuple(
        _build_step(
            analysis, plan, matching, produced_by_request, checklist_value,
            step.request_id,
        )
        for step in plan.steps
    )
    depths = _step_depths(analysis, steps)
    steps = tuple(
        ChecklistStep(
            request_id=step.request_id,
            sequence=step.sequence,
            depth=depths[step.request_id],
            method=step.method,
            path=step.path,
            role=step.role,
            consumes=step.consumes,
            produces=step.produces,
        )
        for step in steps
    )
    unresolved = tuple(
        checklist_value(version_id)
        for version_id in _unresolved_version_ids(analysis, plan)
    )
    return AnalysisChecklist(
        target_request_id=target_request_id,
        depth=depth_label,
        unsafe_raw=unsafe_raw,
        steps=steps,
        unresolved_values=unresolved,
        warnings=plan.warnings,
    )


def _build_step(analysis: Analysis, plan: FlowPlan,
                matching: dict[str, tuple[Any, ...]],
                produced_by_request: dict[str, set[str]],
                checklist_value: Any, request_id: str) -> ChecklistStep:
    request = analysis.capture.request(request_id)
    consumed_ids = {
        version.version_id
        for observation_id in analysis.request_observation_ids.get(request_id, ())
        for version in matching.get(observation_id, ())
    }
    role = "target" if request_id == plan.target_request_id else "producer"
    return ChecklistStep(
        request_id=request_id,
        sequence=request.sequence,
        depth=0,
        method=request.method,
        path=safe_path(request.url),
        role=role,
        consumes=_sorted_values(analysis, consumed_ids, checklist_value),
        produces=_sorted_values(
            analysis, produced_by_request.get(request_id, set()), checklist_value,
        ),
    )


def _sorted_values(analysis: Analysis, version_ids: set[str],
                   checklist_value: Any) -> tuple[ChecklistValue, ...]:
    def sort_key(version_id: str) -> tuple[str, str]:
        return (
            value_name(analysis, analysis.versions[version_id].value_id),
            version_id,
        )

    return tuple(checklist_value(version_id) for version_id in sorted(version_ids, key=sort_key))


def _step_depths(analysis: Analysis, steps: tuple[ChecklistStep, ...]) -> dict[str, int]:
    """Hop distance of each planned request from the target.

    The target is depth 0; a request producing a value consumed by a
    depth-N request is one hop deeper. The fixed-point walk terminates
    because every producer relation points backward in capture order.
    """
    target_id = next(step.request_id for step in steps if step.role == "target")
    depths = {request_id: len(steps) for request_id in (step.request_id for step in steps)}
    depths[target_id] = 0
    changed = True
    while changed:
        changed = False
        for step in steps:
            for value in step.consumes:
                for hypothesis in analysis.target_producers.get(value.version_id, ()):
                    producer_id = _producer_request_id(analysis, hypothesis.producer)
                    if producer_id in depths and depths[producer_id] > depths[step.request_id] + 1:
                        depths[producer_id] = depths[step.request_id] + 1
                        changed = True
    return depths


def _unresolved_version_ids(analysis: Analysis, plan: FlowPlan) -> list[str]:
    unresolved_names = set(plan.unresolved_values)
    version_ids = [
        version_id
        for version_id in analysis.versions
        if not analysis.target_producers.get(version_id, ())
        and value_name(analysis, analysis.versions[version_id].value_id) in unresolved_names
    ]
    return sorted(
        version_ids,
        key=lambda version_id: (
            value_name(analysis, analysis.versions[version_id].value_id),
            version_id,
        ),
    )
