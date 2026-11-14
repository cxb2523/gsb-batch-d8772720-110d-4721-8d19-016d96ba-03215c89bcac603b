from types import SimpleNamespace
from typing import Any, Dict, List, Optional

import pytest
import trio

from osn_selenium.exceptions.base import ExceptionThrown
from osn_selenium.dev_tools.domains import fetch as fetch_domain
from osn_selenium.dev_tools.domains.fetch import (
	AuthRequiredActionsHandlerSettings,
	AuthRequiredActionsSettings,
	AuthRequiredSettings,
	ContinueRequestHandlersSettings,
	ContinueRequestSettings,
	ContinueWithAuthParameterHandlersSettings,
	ContinueWithAuthSettings,
	FetchInterceptionResult,
	ParameterHandler,
	RequestPausedActionsHandlerSettings,
	RequestPausedActionsSettings,
	RequestPausedSettings,
	_handle_auth_required,
	_handle_request_paused,
)
from osn_selenium.dev_tools.domains_default.fetch import (
	auth_required_choose_func,
	request_paused_choose_func,
)


class FakeCDPFunction:
	"""
	Stand-in for a generated CDP command function (e.g. ``fetch.continue_request``).

	It only records that it was called and with which keyword arguments, and returns
	a canned response or raises a configured error. No browser or websocket involved.
	"""

	def __init__(self, name: str, response: Any = "fake-response", raise_error: Optional[BaseException] = None):
		self.__name__ = name
		self._response = response
		self._raise_error = raise_error
		self.calls: List[Dict[str, Any]] = []

	def __call__(self, *args: Any, **kwargs: Any) -> Any:
		self.calls.append({"args": args, "kwargs": kwargs})

		if self._raise_error is not None:
			raise self._raise_error

		return self._response


class FakeDevToolsPackage:
	"""Minimal DevToolsPackage replacement resolving ``["fetch", action_name]``."""

	def __init__(self, functions: Dict[str, FakeCDPFunction]):
		self._functions = functions

	def get(self, name: Any) -> FakeCDPFunction:
		parts = [name] if isinstance(name, str) else list(name)

		assert parts[0] == "fetch"

		return self._functions[parts[1]]


class FakeTarget:
	"""
	Controllable fake DevTools target.

	Implements only the surface touched by the Fetch event handlers: identity,
	the trio nursery used by parameter handlers, the devtools package lookup and
	the logging methods. CDP command execution is intercepted so no real CDP
	session is ever required.
	"""

	def __init__(self, nursery: trio.Nursery, cdp_functions: Dict[str, FakeCDPFunction]):
		self.target_id = "fake-target-id"
		self._nursery = nursery
		self.devtools_package = FakeDevToolsPackage(cdp_functions)
		self.log_messages: List[str] = []
		self.logged_errors: List[BaseException] = []
		self.executed_commands: List[Dict[str, Any]] = []

	async def log_cdp(self, level: str, message: str, extra_data: Optional[Dict[str, Any]] = None) -> None:
		self.log_messages.append(f"{level}: {message}")

	async def log_cdp_error(self, error: BaseException, extra_data: Optional[Dict[str, Any]] = None) -> None:
		self.logged_errors.append(error)


def make_paused_event(request_id: str = "request-1") -> SimpleNamespace:
	"""Builds a fake fetch.RequestPaused event carrying a request id."""

	return SimpleNamespace(request_id=request_id)


async def successful_parameter_handler(
		self: FakeTarget,
		ready_event: trio.Event,
		instances: Any,
		event: Any,
		kwargs: Dict[str, Any]
) -> None:
	"""Parameter handler that adds one kwarg and signals completion."""

	kwargs["url"] = instances["url"]
	ready_event.set()


async def failing_parameter_handler(
		self: FakeTarget,
		ready_event: trio.Event,
		instances: Any,
		event: Any,
		kwargs: Dict[str, Any]
) -> None:
	"""Parameter handler that always raises, mimicking a broken handler."""

	raise ValueError("parameter handler exploded")


async def failing_kwargs_func(self: FakeTarget, handlers: Any, event: Any) -> Dict[str, Any]:
	"""Replacement kwargs builder that fails before any complete kwargs exist."""

	raise RuntimeError("kwargs building failed")


def make_request_paused_settings(
		fake_target: FakeTarget,
		callback: Any = None,
		failing_handler: bool = False,
		failing_kwargs_builder: bool = False,
		on_error_func: Any = None,
) -> RequestPausedSettings:
	"""Assembles real RequestPausedSettings around the fake target's behavior."""

	handler = ParameterHandler(
			func=failing_parameter_handler if failing_handler else successful_parameter_handler,
			instances={"url": "https://example.com/rewritten"}
	)

	action_settings = ContinueRequestSettings(
			parameters_handlers=ContinueRequestHandlersSettings(url=handler)
	)

	if failing_kwargs_builder:
		action_settings.kwargs_func = failing_kwargs_func

	actions_handler = RequestPausedActionsHandlerSettings(
			actions=RequestPausedActionsSettings(continue_request=action_settings)
	)

	return RequestPausedSettings(
			actions_handler=actions_handler,
			on_error_func=on_error_func,
			interception_result_callback=callback
	)


def make_auth_required_settings(
		fake_target: FakeTarget,
		callback: Any = None,
		failing_handler: bool = False,
		failing_kwargs_builder: bool = False,
		on_error_func: Any = None,
) -> AuthRequiredSettings:
	"""Assembles real AuthRequiredSettings around the fake target's behavior."""

	handler = ParameterHandler(
			func=failing_parameter_handler if failing_handler else successful_parameter_handler,
			instances={"url": "https://example.com/auth"}
	)

	action_settings = ContinueWithAuthSettings(
			parameters_handlers=ContinueWithAuthParameterHandlersSettings(response=handler)
	)

	if failing_kwargs_builder:
		action_settings.kwargs_func = failing_kwargs_func

	actions_handler = AuthRequiredActionsHandlerSettings(
			actions=AuthRequiredActionsSettings(continue_with_auth=action_settings)
	)

	return AuthRequiredSettings(
			actions_handler=actions_handler,
			on_error_func=on_error_func,
			interception_result_callback=callback
	)


async def run_handler_with_fake_cdp(
		fake_target: FakeTarget,
		handler_settings: Any,
		event: Any,
		command_outcome: str = "success",
		command_error: Optional[BaseException] = None,
) -> None:
	"""
	Runs a real Fetch event handler while intercepting ``execute_cdp_command``.

	The intercepted executor either returns a normal response (success), an
	``ExceptionThrown`` wrapper (the 'log' error mode used by RequestPaused) or
	raises directly (the 'raise' error mode used by AuthRequired).
	"""

	async def fake_execute_cdp_command(self: FakeTarget, function: FakeCDPFunction, *args: Any, **kwargs: Any) -> Any:
		fake_target.executed_commands.append(
				{"command": function.__name__, "args": args, "kwargs": dict(kwargs)}
		)

		if command_outcome == "exception_thrown":
			return ExceptionThrown(exception=command_error)

		if command_outcome == "raise":
			raise command_error

		return function(**kwargs)

	original = fetch_domain.execute_cdp_command
	fetch_domain.execute_cdp_command = fake_execute_cdp_command

	try:
		if isinstance(handler_settings, RequestPausedSettings):
			await _handle_request_paused(fake_target, handler_settings, event)
		else:
			await _handle_auth_required(fake_target, handler_settings, event)
	finally:
		fetch_domain.execute_cdp_command = original


# ---------------------------------------------------------------------------
# RequestPaused: successful action is recorded with the executed command name
# ---------------------------------------------------------------------------


def test_request_paused_success_records_result() -> None:
	recorded: List[FetchInterceptionResult] = []

	async def callback(target: FakeTarget, result: FetchInterceptionResult) -> None:
		recorded.append(result)

	async def scenario() -> None:
		cdp_functions = {"continue_request": FakeCDPFunction("continue_request")}

		async with trio.open_nursery() as nursery:
			fake_target = FakeTarget(nursery, cdp_functions)
			settings = make_request_paused_settings(fake_target, callback=callback)
			event = make_paused_event()

			await run_handler_with_fake_cdp(fake_target, settings, event)

	trio.run(scenario)

	assert len(recorded) == 1
	result = recorded[0]
	assert result.target_id == "fake-target-id"
	assert result.event_path == "fetch.RequestPaused"
	assert result.action_name == "continue_request"
	assert result.success is True
	assert result.error_type is None
	assert result.error_message is None


def test_request_paused_success_executes_real_cdp_command() -> None:
	recorded: List[FetchInterceptionResult] = []

	async def callback(target: FakeTarget, result: FetchInterceptionResult) -> None:
		recorded.append(result)

	async def scenario() -> None:
		cdp_functions = {"continue_request": FakeCDPFunction("continue_request")}

		async with trio.open_nursery() as nursery:
			fake_target = FakeTarget(nursery, cdp_functions)
			settings = make_request_paused_settings(fake_target, callback=callback)

			await run_handler_with_fake_cdp(fake_target, settings, make_paused_event("req-42"))

			# Command really executed, once, with kwargs built by the real handler.
			assert len(fake_target.executed_commands) == 1
			command = fake_target.executed_commands[0]
			assert command["command"] == "continue_request"
			assert command["kwargs"]["request_id"] == "req-42"
			assert command["kwargs"]["url"] == "https://example.com/rewritten"

			# Action name in the record equals the executed command name.
			assert recorded[0].action_name == command["command"]

	trio.run(scenario)


# ---------------------------------------------------------------------------
# RequestPaused: parameter handler failure -> failure record, no CDP command
# ---------------------------------------------------------------------------


def unwrap_exception_group(error: BaseException) -> BaseException:
	"""Digs the first concrete exception out of a nested trio ExceptionGroup."""

	while isinstance(error, ExceptionGroup) and error.exceptions:
		error = error.exceptions[0]

	return error


def test_request_paused_parameter_handler_failure_records_and_skips_command() -> None:
	recorded: List[FetchInterceptionResult] = []
	on_error_events: List[Any] = []

	async def callback(target: FakeTarget, result: FetchInterceptionResult) -> None:
		recorded.append(result)

	def on_error_func(target: FakeTarget, event: Any, error: BaseException) -> None:
		on_error_events.append((event, error))

	async def scenario() -> None:
		cdp_functions = {"continue_request": FakeCDPFunction("continue_request")}
		fake_target_holder: List[FakeTarget] = []

		# The handler re-raises after recording; the nursery surfaces it as an
		# ExceptionGroup when the failing parameter-handler task unwinds.
		with pytest.raises(BaseException) as exc_info:
			async with trio.open_nursery() as nursery:
				fake_target = FakeTarget(nursery, cdp_functions)
				fake_target_holder.append(fake_target)
				settings = make_request_paused_settings(
						fake_target,
						callback=callback,
						failing_handler=True,
						on_error_func=on_error_func
				)

				await run_handler_with_fake_cdp(fake_target, settings, make_paused_event())

		assert isinstance(unwrap_exception_group(exc_info.value), ValueError)

		# Nothing half-built was ever sent to the CDP.
		assert fake_target_holder[0].executed_commands == []
		assert cdp_functions["continue_request"].calls == []

	trio.run(scenario)

	assert len(recorded) == 1
	result = recorded[0]
	assert result.success is False
	assert result.action_name == "continue_request"
	assert result.event_path == "fetch.RequestPaused"
	assert result.target_id == "fake-target-id"
	assert result.error_type == "ValueError"
	assert result.error_message == "parameter handler exploded"

	# on_error_func is not invoked for kwargs-build failures (they propagate instead).
	assert on_error_events == []


def test_request_paused_failing_kwargs_builder_records_and_skips_command() -> None:
	recorded: List[FetchInterceptionResult] = []

	async def callback(target: FakeTarget, result: FetchInterceptionResult) -> None:
		recorded.append(result)

	async def scenario() -> None:
		cdp_functions = {"continue_request": FakeCDPFunction("continue_request")}
		fake_target_holder: List[FakeTarget] = []

		with pytest.raises(BaseException) as exc_info:
			async with trio.open_nursery() as nursery:
				fake_target = FakeTarget(nursery, cdp_functions)
				fake_target_holder.append(fake_target)
				settings = make_request_paused_settings(
						fake_target,
						callback=callback,
						failing_kwargs_builder=True
				)

				await run_handler_with_fake_cdp(fake_target, settings, make_paused_event())

		assert unwrap_exception_group(exc_info.value).args == ("kwargs building failed",)
		assert fake_target_holder[0].executed_commands == []

	trio.run(scenario)

	assert len(recorded) == 1
	assert recorded[0].success is False
	assert recorded[0].error_type == "RuntimeError"
	assert recorded[0].error_message == "kwargs building failed"


# ---------------------------------------------------------------------------
# RequestPaused: CDP command failure is still recorded as a failed action
# ---------------------------------------------------------------------------


def test_request_paused_cdp_command_failure_records_failure() -> None:
	recorded: List[FetchInterceptionResult] = []
	on_error_events: List[BaseException] = []

	async def callback(target: FakeTarget, result: FetchInterceptionResult) -> None:
		recorded.append(result)

	def on_error_func(target: FakeTarget, event: Any, error: BaseException) -> None:
		on_error_events.append(error)

	async def scenario() -> None:
		cdp_functions = {"continue_request": FakeCDPFunction("continue_request")}

		async with trio.open_nursery() as nursery:
			fake_target = FakeTarget(nursery, cdp_functions)
			settings = make_request_paused_settings(
					fake_target,
					callback=callback,
					on_error_func=on_error_func
			)

			await run_handler_with_fake_cdp(
					fake_target,
					settings,
					make_paused_event(),
					command_outcome="exception_thrown",
					command_error=RuntimeError("cdp said no")
			)

			# The command was attempted, but its failure was recorded.
			assert len(fake_target.executed_commands) == 1

	trio.run(scenario)

	assert len(recorded) == 1
	result = recorded[0]
	assert result.success is False
	assert result.action_name == "continue_request"
	assert result.error_type == "RuntimeError"
	assert result.error_message == "cdp said no"
	assert len(on_error_events) == 1


# ---------------------------------------------------------------------------
# Callback raising must not break processing of subsequent events
# ---------------------------------------------------------------------------


def test_request_paused_callback_error_does_not_stop_later_events() -> None:
	call_count = 0

	async def bad_callback(target: FakeTarget, result: FetchInterceptionResult) -> None:
		nonlocal call_count
		call_count += 1

		raise RuntimeError("callback broken")

	async def scenario() -> None:
		cdp_functions = {"continue_request": FakeCDPFunction("continue_request")}

		async with trio.open_nursery() as nursery:
			fake_target = FakeTarget(nursery, cdp_functions)
			settings = make_request_paused_settings(fake_target, callback=bad_callback)

			# Two independent events: the first callback failure must not poison the second.
			await run_handler_with_fake_cdp(fake_target, settings, make_paused_event("req-1"))
			await run_handler_with_fake_cdp(fake_target, settings, make_paused_event("req-2"))

			assert call_count == 2
			assert len(fake_target.executed_commands) == 2
			assert [cmd["kwargs"]["request_id"] for cmd in fake_target.executed_commands] == ["req-1", "req-2"]
			# Callback failures were swallowed and logged, not propagated. They reach
			# the logger through the nursery, so they may be wrapped in ExceptionGroups.
			assert len(fake_target.logged_errors) == 2
			assert all(
					isinstance(unwrap_exception_group(error), RuntimeError)
					for error in fake_target.logged_errors
			)

	trio.run(scenario)


# ---------------------------------------------------------------------------
# No callback configured: zero extra calls, behavior unchanged
# ---------------------------------------------------------------------------


def test_request_paused_without_callback_has_no_extra_calls() -> None:
	async def scenario() -> None:
		cdp_functions = {"continue_request": FakeCDPFunction("continue_request")}

		async with trio.open_nursery() as nursery:
			fake_target = FakeTarget(nursery, cdp_functions)
			settings = make_request_paused_settings(fake_target, callback=None)

			assert settings.interception_result_callback is None

			await run_handler_with_fake_cdp(fake_target, settings, make_paused_event())

			# Only the CDP command itself ran; nothing else was invoked.
			assert len(fake_target.executed_commands) == 1
			assert fake_target.executed_commands[0]["command"] == "continue_request"
			assert fake_target.logged_errors == []

	trio.run(scenario)


def test_request_paused_default_choose_action_func_keeps_continue_request() -> None:
	async def scenario() -> None:
		cdp_functions = {"continue_request": FakeCDPFunction("continue_request")}

		async with trio.open_nursery() as nursery:
			fake_target = FakeTarget(nursery, cdp_functions)
			settings = make_request_paused_settings(fake_target)

			# The configured chooser is the library default and still picks continue_request.
			assert settings.actions_handler.choose_action_func is request_paused_choose_func
			assert settings.actions_handler.choose_action_func(fake_target, make_paused_event()) == ["continue_request"]

			await run_handler_with_fake_cdp(fake_target, settings, make_paused_event())

			assert fake_target.executed_commands[0]["command"] == "continue_request"

	trio.run(scenario)


# ---------------------------------------------------------------------------
# Parameter handlers keep running concurrently and only complete kwargs are used
# ---------------------------------------------------------------------------


def test_parameter_handlers_run_concurrently_and_merge_kwargs() -> None:
	from osn_selenium.dev_tools.domains.fetch import _build_kwargs_from_handlers_func

	first_started = trio.Event()
	release_second = trio.Event()

	async def slow_url_handler(
			self: FakeTarget,
			ready_event: trio.Event,
			instances: Any,
			event: Any,
			kwargs: Dict[str, Any],
	) -> None:
		first_started.set()

		# Block until the second handler has also started, proving they overlap.
		await release_second.wait()

		kwargs["url"] = instances
		ready_event.set()

	async def fast_method_handler(
			self: FakeTarget,
			ready_event: trio.Event,
			instances: Any,
			event: Any,
			kwargs: Dict[str, Any],
	) -> None:
		await first_started.wait()
		release_second.set()
		kwargs["method"] = instances
		ready_event.set()

	async def scenario() -> None:
		cdp_functions = {"continue_request": FakeCDPFunction("continue_request")}

		async with trio.open_nursery() as nursery:
			fake_target = FakeTarget(nursery, cdp_functions)
			handlers = ContinueRequestHandlersSettings(
					url=ParameterHandler(func=slow_url_handler, instances="https://example.com"),
					method=ParameterHandler(func=fast_method_handler, instances="POST")
			)

			kwargs = await _build_kwargs_from_handlers_func(
					fake_target,
					handlers,
					make_paused_event("req-concurrent")
			)

			# Both handlers contributed and the base request id is always present.
			assert kwargs == {
					"request_id": "req-concurrent",
					"url": "https://example.com",
					"method": "POST"
			}

	trio.run(scenario)


# ---------------------------------------------------------------------------
# AuthRequired: same recording guarantees on the auth event path
# ---------------------------------------------------------------------------


def test_auth_required_success_records_result() -> None:
	recorded: List[FetchInterceptionResult] = []

	async def callback(target: FakeTarget, result: FetchInterceptionResult) -> None:
		recorded.append(result)

	async def scenario() -> None:
		cdp_functions = {"continue_with_auth": FakeCDPFunction("continue_with_auth")}

		async with trio.open_nursery() as nursery:
			fake_target = FakeTarget(nursery, cdp_functions)
			settings = make_auth_required_settings(fake_target, callback=callback)

			assert settings.actions_handler.choose_action_func is auth_required_choose_func

			await run_handler_with_fake_cdp(fake_target, settings, make_paused_event("auth-1"))

			assert len(fake_target.executed_commands) == 1
			assert fake_target.executed_commands[0]["command"] == "continue_with_auth"
			assert fake_target.executed_commands[0]["kwargs"]["request_id"] == "auth-1"

	trio.run(scenario)

	assert len(recorded) == 1
	result = recorded[0]
	assert result.success is True
	assert result.target_id == "fake-target-id"
	assert result.event_path == "fetch.AuthRequired"
	assert result.action_name == "continue_with_auth"
	assert result.error_type is None


def test_auth_required_parameter_handler_failure_records_and_skips_command() -> None:
	recorded: List[FetchInterceptionResult] = []

	async def callback(target: FakeTarget, result: FetchInterceptionResult) -> None:
		recorded.append(result)

	async def scenario() -> None:
		cdp_functions = {"continue_with_auth": FakeCDPFunction("continue_with_auth")}
		fake_target_holder: List[FakeTarget] = []

		with pytest.raises(BaseException) as exc_info:
			async with trio.open_nursery() as nursery:
				fake_target = FakeTarget(nursery, cdp_functions)
				fake_target_holder.append(fake_target)
				settings = make_auth_required_settings(fake_target, callback=callback, failing_handler=True)

				await run_handler_with_fake_cdp(fake_target, settings, make_paused_event())

		assert isinstance(unwrap_exception_group(exc_info.value), ValueError)
		assert fake_target_holder[0].executed_commands == []
		assert cdp_functions["continue_with_auth"].calls == []

	trio.run(scenario)

	assert len(recorded) == 1
	result = recorded[0]
	assert result.success is False
	assert result.event_path == "fetch.AuthRequired"
	assert result.action_name == "continue_with_auth"
	assert result.error_type == "ValueError"
	assert result.error_message == "parameter handler exploded"


def test_auth_required_cdp_command_failure_records_failure() -> None:
	recorded: List[FetchInterceptionResult] = []
	on_error_events: List[BaseException] = []

	async def callback(target: FakeTarget, result: FetchInterceptionResult) -> None:
		recorded.append(result)

	def on_error_func(target: FakeTarget, event: Any, error: BaseException) -> None:
		on_error_events.append(error)

	async def scenario() -> None:
		cdp_functions = {"continue_with_auth": FakeCDPFunction("continue_with_auth")}

		async with trio.open_nursery() as nursery:
			fake_target = FakeTarget(nursery, cdp_functions)
			settings = make_auth_required_settings(
					fake_target,
					callback=callback,
					on_error_func=on_error_func
			)

			await run_handler_with_fake_cdp(
					fake_target,
					settings,
					make_paused_event(),
					command_outcome="raise",
					command_error=RuntimeError("auth rejected")
			)

			assert len(fake_target.executed_commands) == 1

	trio.run(scenario)

	assert len(recorded) == 1
	assert recorded[0].success is False
	assert recorded[0].event_path == "fetch.AuthRequired"
	assert recorded[0].action_name == "continue_with_auth"
	assert recorded[0].error_type == "RuntimeError"
	assert recorded[0].error_message == "auth rejected"
	assert len(on_error_events) == 1


def test_auth_required_callback_error_does_not_stop_later_events() -> None:
	call_count = 0

	async def bad_callback(target: FakeTarget, result: FetchInterceptionResult) -> None:
		nonlocal call_count
		call_count += 1

		raise ValueError("auth callback broken")

	async def scenario() -> None:
		cdp_functions = {"continue_with_auth": FakeCDPFunction("continue_with_auth")}

		async with trio.open_nursery() as nursery:
			fake_target = FakeTarget(nursery, cdp_functions)
			settings = make_auth_required_settings(fake_target, callback=bad_callback)

			await run_handler_with_fake_cdp(fake_target, settings, make_paused_event("auth-1"))
			await run_handler_with_fake_cdp(fake_target, settings, make_paused_event("auth-2"))

			assert call_count == 2
			assert len(fake_target.executed_commands) == 2
			assert len(fake_target.logged_errors) == 2

	trio.run(scenario)


def test_auth_required_without_callback_has_no_extra_calls() -> None:
	async def scenario() -> None:
		cdp_functions = {"continue_with_auth": FakeCDPFunction("continue_with_auth")}

		async with trio.open_nursery() as nursery:
			fake_target = FakeTarget(nursery, cdp_functions)
			settings = make_auth_required_settings(fake_target)

			assert settings.interception_result_callback is None

			await run_handler_with_fake_cdp(fake_target, settings, make_paused_event())

			assert len(fake_target.executed_commands) == 1
			assert fake_target.executed_commands[0]["command"] == "continue_with_auth"
			assert fake_target.logged_errors == []

	trio.run(scenario)
