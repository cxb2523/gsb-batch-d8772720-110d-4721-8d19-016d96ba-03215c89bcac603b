package functions

import (
	"fmt"
	"log"
	"strings"

	"github.com/froxy/models"
)

// classifySeedResult reduces all page outcomes recorded while crawling one
// seed into a single final SeedResult for that seed.
func (c *Crawler) classifySeedResult(seedURL string) models.SeedResult {
	c.Mu.Lock()
	outcomes := make(map[string]pageOutcome, len(c.PageOutcomes))
	for pageURL, outcome := range c.PageOutcomes {
		outcomes[pageURL] = outcome
	}
	c.Mu.Unlock()

	if len(outcomes) == 0 {
		return models.SeedResult{
			SeedURL: seedURL,
			Status:  models.SeedStatusFetchFailed,
			Reason:  "no pages were attempted for this seed",
		}
	}

	counts := make(map[models.SeedStatus]int)
	for _, outcome := range outcomes {
		counts[outcome.status]++
	}

	// Any successfully stored page means the seed itself succeeded.
	if n := counts[models.SeedStatusSuccess]; n > 0 {
		return models.SeedResult{
			SeedURL: seedURL,
			Status:  models.SeedStatusSuccess,
			Reason:  fmt.Sprintf("stored %d page(s) successfully", n),
		}
	}

	// Prefer the outcome of the seed URL itself when it is decisive.
	if outcome, ok := outcomes[seedURL]; ok && outcome.status != models.SeedStatusSkipped {
		return models.SeedResult{
			SeedURL: seedURL,
			Status:  outcome.status,
			Reason:  outcome.reason,
		}
	}

	// Otherwise report the most relevant failure, in priority order.
	priority := []models.SeedStatus{
		models.SeedStatusRobotsBlocked,
		models.SeedStatusFetchFailed,
		models.SeedStatusStoreFailed,
		models.SeedStatusTooShort,
		models.SeedStatusParseFailed,
	}
	for _, status := range priority {
		if n := counts[status]; n > 0 {
			reason := ""
			for _, outcome := range outcomes {
				if outcome.status == status {
					reason = outcome.reason
					break
				}
			}
			return models.SeedResult{
				SeedURL: seedURL,
				Status:  status,
				Reason:  fmt.Sprintf("%s (%d page(s) affected)", reason, n),
			}
		}
	}

	return models.SeedResult{
		SeedURL: seedURL,
		Status:  models.SeedStatusSkipped,
		Reason:  "all discovered pages were skipped (non-HTML content or already visited)",
	}
}

// PrintSeedSummary prints (and appends to crawler.log) a per-seed summary of
// the whole run plus totals per status.
func PrintSeedSummary(results []models.SeedResult) {
	if len(results) == 0 {
		return
	}

	var lines []string
	lines = append(lines, "================ Seed crawl summary ================")

	counts := make(map[models.SeedStatus]int)
	for i, result := range results {
		counts[result.Status]++
		lines = append(lines,
			fmt.Sprintf("[%d] %s", i+1, result.SeedURL),
			fmt.Sprintf("    status: %s", result.Status),
			fmt.Sprintf("    reason: %s", result.Reason),
		)
	}

	lines = append(lines, "----------------------------------------------------")

	statusOrder := []models.SeedStatus{
		models.SeedStatusSuccess,
		models.SeedStatusRobotsBlocked,
		models.SeedStatusFetchFailed,
		models.SeedStatusTooShort,
		models.SeedStatusParseFailed,
		models.SeedStatusStoreFailed,
		models.SeedStatusNoURLs,
		models.SeedStatusSkipped,
	}
	var totals []string
	for _, status := range statusOrder {
		if n := counts[status]; n > 0 {
			totals = append(totals, fmt.Sprintf("%s: %d", status, n))
		}
	}
	lines = append(lines,
		fmt.Sprintf("Total: %d seed(s) -> %s", len(results), strings.Join(totals, ", ")),
		"====================================================",
	)

	for _, line := range lines {
		fmt.Println(line)
		log.Println(line)
		appendLog(line)
	}
}
