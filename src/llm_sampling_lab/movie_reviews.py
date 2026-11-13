
import time

from dataclasses import dataclass
from typing import Sequence
from collections.abc import Callable
from groq import (
    APIConnectionError as GroqConnectionError,
    Groq,
    RateLimitError as GroqRateLimitError,
)

from llm_sampling_lab.groq_client import (
    EmptyResponseError,
    generate_response,
)
from llm_sampling_lab.sampling import (
    apply_temperature,
    apply_top_k,
    sample_token_indices,
)


REVIEW_STYLES = (
    "Positive",
    "Critical",
    "Technical",
    "Emotional",
)

STYLE_PROBABILITIES = (0.4, 0.3, 0.2, 0.1)

DEFAULT_SCENARIOS = (
    (0.3, 1),
    (0.3, 3),
    (1.0, 1),
    (1.0, 3),
)

DEFAULT_MAX_ATTEMPTS = 3
DEFAULT_RETRY_BACKOFF_SECONDS = 1.0

STATUS_SUCCESS = "success"
STATUS_FAILED = "failed"

# Only transient provider failures are retried. Authentication errors,
# invalid requests and empty responses fail the scenario immediately.
RETRYABLE_ERROR_TYPES = (
    GroqRateLimitError,
    GroqConnectionError,
)


@dataclass(frozen=True)
class Movie:
    title: str
    genre: str
    description: str


@dataclass(frozen=True)
class MovieReviewResult:
    scenario: int
    temperature: float
    local_top_k: int
    review_style: str
    review: str | None
    validation_issues: tuple[str, ...]
    attempts: int = 1
    status: str = STATUS_SUCCESS
    error_type: str | None = None
    error_message: str | None = None


DEFAULT_MOVIE = Movie(
    title="Son İstasyon",
    genre="Science Fiction / Drama",
    description=(
        "A scientist discovers that humanity has only "
        "one year to establish a colony on another planet. "
        "She must choose between her family and the mission."
    ),
)


def select_review_style(
    temperature: float,
    top_k: int,
    seed: int,
) -> str:
    """Select a review style using local temperature and top-k."""

    distribution = apply_temperature(
        STYLE_PROBABILITIES,
        temperature,
    )

    filtered = apply_top_k(
        distribution,
        k=top_k,
    )

    selected = sample_token_indices(
        probabilities=filtered,
        n_samples=1,
        seed=seed,
    )

    return REVIEW_STYLES[int(selected[0])]


def build_review_prompt(
    movie: Movie,
    review_style: str,
) -> str:
    """Build a constrained movie-review generation prompt."""

    if review_style not in REVIEW_STYLES:
        raise ValueError("Unsupported review style.")

    if not all((
        movie.title.strip(),
        movie.genre.strip(),
        movie.description.strip(),
    )):
        raise ValueError("Movie information cannot be empty.")

    return f"""
You are a professional movie critic.

Write a Turkish review for a fictional movie.

MOVIE INFORMATION:
Title: {movie.title}
Genre: {movie.genre}
Plot: {movie.description}

REVIEW STYLE:
{review_style}

STRICT RULES:
1. Begin the review with the exact movie title.
2. Do not change the movie title.
3. Do not invent character names.
4. Do not invent actors, directors, or awards.
5. Do not invent details about acting, music,
   cinematography, or visual effects.
6. Discuss only the provided plot, its themes,
   and potential emotional impact.
7. Follow the selected review style.
8. Write between 80 and 100 Turkish words.
9. Return only the review.
""".strip()


def validate_review(
    review: str,
    movie: Movie,
) -> tuple[str, ...]:
    """Perform deterministic structural checks on a review."""

    issues = []

    if movie.title.casefold() not in review.casefold():
        issues.append("movie_title_missing_or_changed")

    # Simple whitespace-based word count.
    word_count = len(review.split())

    if not 80 <= word_count <= 100:
        issues.append("word_count_out_of_range")

    return tuple(issues)


def is_retryable_error(error: BaseException) -> bool:
    """Return True for transient rate-limit or connection errors."""

    return isinstance(error, RETRYABLE_ERROR_TYPES)


def retry_delay_seconds(
    retry_number: int,
    backoff_seconds: float = DEFAULT_RETRY_BACKOFF_SECONDS,
) -> float:
    """Return an increasing (exponential) wait before the next attempt."""

    if retry_number < 1:
        raise ValueError("retry_number must be positive.")

    return backoff_seconds * (2 ** (retry_number - 1))


def _failure_result(
    scenario: int,
    temperature: float,
    top_k: int,
    style: str,
    attempts: int,
    error: BaseException,
) -> MovieReviewResult:
    """Build a failed scenario entry; it never carries review text."""

    return MovieReviewResult(
        scenario=scenario,
        temperature=temperature,
        local_top_k=top_k,
        review_style=style,
        review=None,
        validation_issues=(),
        attempts=attempts,
        status=STATUS_FAILED,
        error_type=type(error).__name__,
        error_message=str(error),
    )


def run_movie_review_scenario(
    client: Groq,
    model: str,
    movie: Movie,
    scenario: int,
    temperature: float,
    top_k: int,
    seed: int,
    max_attempts: int = DEFAULT_MAX_ATTEMPTS,
    retry_backoff_seconds: float = DEFAULT_RETRY_BACKOFF_SECONDS,
) -> MovieReviewResult:
    """Run one scenario, retrying transient failures with backoff.

    Provider errors never escape: they are captured in the returned result
    so that later scenarios can still run.
    """

    if max_attempts < 1:
        raise ValueError("max_attempts must be a positive integer.")

    if retry_backoff_seconds < 0:
        raise ValueError("retry_backoff_seconds cannot be negative.")

    style = select_review_style(
        temperature=temperature,
        top_k=top_k,
        seed=seed,
    )

    prompt = build_review_prompt(
        movie=movie,
        review_style=style,
    )

    attempts = 0

    while True:
        attempts += 1

        try:
            review = generate_response(
                client=client,
                model=model,
                prompt=prompt,
                temperature=temperature,
                top_p=1.0,
            )

            # Guard against providers or fakes that bypass the shared
            # empty-response check: never persist a blank body.
            if not isinstance(review, str) or not review.strip():
                raise EmptyResponseError(
                    "Groq returned an empty response."
                )

        except Exception as error:
            if is_retryable_error(error) and attempts < max_attempts:
                time.sleep(
                    retry_delay_seconds(
                        retry_number=attempts,
                        backoff_seconds=retry_backoff_seconds,
                    )
                )
                continue

            return _failure_result(
                scenario=scenario,
                temperature=temperature,
                top_k=top_k,
                style=style,
                attempts=attempts,
                error=error,
            )

        issues = validate_review(
            review=review,
            movie=movie,
        )

        return MovieReviewResult(
            scenario=scenario,
            temperature=temperature,
            local_top_k=top_k,
            review_style=style,
            review=review,
            validation_issues=issues,
            attempts=attempts,
            status=STATUS_SUCCESS,
        )


def successful_results_by_scenario(
    results: Sequence[MovieReviewResult],
) -> dict[int, MovieReviewResult]:
    """Index previously successful scenarios for resumable runs."""

    return {
        result.scenario: result
        for result in results
        if result.status == STATUS_SUCCESS
        and bool(result.review and result.review.strip())
    }


def run_movie_review_experiment(
    client: Groq | None,
    model: str,
    movie: Movie = DEFAULT_MOVIE,
    scenarios: Sequence[tuple[float, int]] = DEFAULT_SCENARIOS,
    seed: int = 42,
    on_result: Callable[[MovieReviewResult], None] | None = None,
    previous_results: Sequence[MovieReviewResult] | None = None,
    max_attempts: int = DEFAULT_MAX_ATTEMPTS,
    retry_backoff_seconds: float = DEFAULT_RETRY_BACKOFF_SECONDS,
) -> list[MovieReviewResult]:
    """Run movie-review scenarios independently and resumably.

    Successful entries in ``previous_results`` are reused without issuing a
    request. Failed or missing scenarios are attempted again. Every newly
    attempted result, success or failure, is passed to ``on_result``
    immediately.
    """

    if seed < 0:
        raise ValueError("seed must be non-negative.")

    reused = successful_results_by_scenario(previous_results or ())

    results_by_scenario: dict[int, MovieReviewResult] = {}

    for index, (temperature, top_k) in enumerate(
        scenarios,
        start=1,
    ):
        previous = reused.get(index)

        if previous is not None:
            results_by_scenario[index] = previous
            continue

        if client is None:
            raise ValueError(
                "A Groq client is required to run pending scenarios."
            )

        result = run_movie_review_scenario(
            client=client,
            model=model,
            movie=movie,
            scenario=index,
            temperature=temperature,
            top_k=top_k,
            seed=seed + index - 1,
            max_attempts=max_attempts,
            retry_backoff_seconds=retry_backoff_seconds,
        )

        results_by_scenario[index] = result

        # Save each result immediately, including failed scenarios.
        if on_result is not None:
            on_result(result)

    return [
        results_by_scenario[index]
        for index in sorted(results_by_scenario)
    ]
