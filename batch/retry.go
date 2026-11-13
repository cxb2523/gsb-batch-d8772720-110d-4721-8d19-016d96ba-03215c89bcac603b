package batch

import (
	"context"
	"time"
)

// RetryConfig controls exponential backoff retry behavior.
type RetryConfig struct {
	MaxAttempts int           // Total attempts (1 = no retry)
	InitDelay   time.Duration // Delay before first retry; doubles each attempt
}

// Do executes fn with retries on error. It uses exponential backoff and
// respects context cancellation. Only retries if shouldRetry returns true.
func (rc *RetryConfig) Do(ctx context.Context, fn func() error, shouldRetry func(error) bool) error {
	_, err := rc.DoWithAttempts(ctx, fn, shouldRetry)
	return err
}

// DoWithAttempts behaves like Do but also reports how many times fn was
// actually invoked. The count is 1 when the first call succeeds, and is capped
// at MaxAttempts. A non-retryable error returns after a single attempt.
func (rc *RetryConfig) DoWithAttempts(ctx context.Context, fn func() error, shouldRetry func(error) bool) (int, error) {
	var lastErr error
	delay := rc.InitDelay
	attempts := 0

	for attempt := 0; attempt < rc.MaxAttempts; attempt++ {
		attempts++
		lastErr = fn()
		if lastErr == nil {
			return attempts, nil
		}

		if !shouldRetry(lastErr) {
			return attempts, lastErr
		}

		// Don't sleep after the last attempt
		if attempt < rc.MaxAttempts-1 {
			select {
			case <-time.After(delay):
				delay *= 2
			case <-ctx.Done():
				return attempts, ctx.Err()
			}
		}
	}
	return attempts, lastErr
}
