package cmd

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gupsammy/EzyCopy/batch"
	"github.com/gupsammy/EzyCopy/output"
)

// resolveOutputPathForTest resolves the file path a title would produce under
// the given output directory.
func resolveOutputPathForTest(dir, title string) (string, error) {
	return output.ResolveOutputPath(dir, title)
}

func TestParseByteSize(t *testing.T) {
	tests := []struct {
		input string
		want  int64
		err   bool
	}{
		{"10MB", 10 * 1024 * 1024, false},
		{"1GB", 1024 * 1024 * 1024, false},
		{"512KB", 512 * 1024, false},
		{"100B", 100, false},
		{"0", 0, false},
		{"1024", 1024, false},
		{"invalid", 0, true},
	}
	for _, tt := range tests {
		got, err := parseByteSize(tt.input)
		if tt.err {
			if err == nil {
				t.Errorf("parseByteSize(%q) expected error", tt.input)
			}
			continue
		}
		if err != nil {
			t.Errorf("parseByteSize(%q) unexpected error: %v", tt.input, err)
			continue
		}
		if got != tt.want {
			t.Errorf("parseByteSize(%q) = %d, want %d", tt.input, got, tt.want)
		}
	}
}

func TestUniqueStrings(t *testing.T) {
	input := []string{"a", "b", "a", "c", "b"}
	got := uniqueStrings(input)
	if len(got) != 3 || got[0] != "a" || got[1] != "b" || got[2] != "c" {
		t.Errorf("uniqueStrings(%v) = %v, want [a b c]", input, got)
	}
}

func TestResolveCollision(t *testing.T) {
	// Non-existent file — should return as-is
	path := "/tmp/ezycopy-test-nonexistent-file-abc123.md"
	got := resolveCollision(path)
	if got != path {
		t.Errorf("resolveCollision(%q) = %q, want same path", path, got)
	}
}

func TestResolveCollision_ExistingFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "article.md")
	if err := os.WriteFile(path, []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}

	got := resolveCollision(path)
	want := filepath.Join(dir, "article-2.md")
	if got != want {
		t.Errorf("resolveCollision(%q) = %q, want %q", path, got, want)
	}

	// A second collision should pick -3
	if err := os.WriteFile(got, []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}
	if got := resolveCollision(path); got != filepath.Join(dir, "article-3.md") {
		t.Errorf("second resolveCollision(%q) = %q, want article-3.md", path, got)
	}
}

// withOutputConfig sets the package-level output flags for a test and restores
// them afterwards.
func withOutputConfig(t *testing.T, out string, skip bool) {
	t.Helper()
	prevOut, prevSkip := outputFlag, skipExisting
	outputFlag, skipExisting = out, skip
	t.Cleanup(func() { outputFlag, skipExisting = prevOut, prevSkip })
}

func okResult(seq int, title, markdown string) BatchResult {
	return BatchResult{
		Seq:         seq,
		OriginalURL: "https://example.com/" + title,
		Status:      "ok",
		Title:       &title,
		Markdown:    markdown,
		Attempts:    1,
	}
}

func TestWriteResultToFile_Written(t *testing.T) {
	dir := t.TempDir()
	withOutputConfig(t, dir, false)

	got := writeResultToFile(okResult(0, "My Article", "# body"))

	if got.Status != "ok" {
		t.Fatalf("status = %q, want ok", got.Status)
	}
	if got.OutputStatus != OutputWritten {
		t.Errorf("output_status = %q, want %q", got.OutputStatus, OutputWritten)
	}
	if got.OutputFile == "" {
		t.Fatal("output_file is empty")
	}
	data, err := os.ReadFile(got.OutputFile)
	if err != nil {
		t.Fatalf("expected file to exist: %v", err)
	}
	if string(data) != "# body" {
		t.Errorf("file content = %q, want %q", data, "# body")
	}
}

func TestWriteResultToFile_SkippedExisting(t *testing.T) {
	dir := t.TempDir()
	withOutputConfig(t, dir, true)

	// Pre-create the file the title resolves to.
	path, err := resolveOutputPathForTest(dir, "My Article")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("original"), 0644); err != nil {
		t.Fatal(err)
	}

	got := writeResultToFile(okResult(0, "My Article", "# new body"))

	if got.Status != "ok" {
		t.Fatalf("status = %q, want ok", got.Status)
	}
	if got.OutputStatus != OutputSkipped {
		t.Errorf("output_status = %q, want %q", got.OutputStatus, OutputSkipped)
	}
	data, _ := os.ReadFile(path)
	if string(data) != "original" {
		t.Errorf("existing file was modified: %q", data)
	}
}

func TestWriteResultToFile_RenamedOnCollision(t *testing.T) {
	dir := t.TempDir()
	withOutputConfig(t, dir, false)

	path, err := resolveOutputPathForTest(dir, "My Article")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("original"), 0644); err != nil {
		t.Fatal(err)
	}

	got := writeResultToFile(okResult(0, "My Article", "# new body"))

	if got.Status != "ok" {
		t.Fatalf("status = %q, want ok", got.Status)
	}
	if got.OutputStatus != OutputRenamed {
		t.Errorf("output_status = %q, want %q", got.OutputStatus, OutputRenamed)
	}
	if got.OutputFile == path {
		t.Errorf("output_file = %q, expected a renamed path", got.OutputFile)
	}
	data, err := os.ReadFile(got.OutputFile)
	if err != nil || string(data) != "# new body" {
		t.Errorf("renamed file content = %q, err = %v", data, err)
	}
	orig, _ := os.ReadFile(path)
	if string(orig) != "original" {
		t.Errorf("original file overwritten: %q", orig)
	}
}

func TestWriteResultToFile_WriteFailureIsError(t *testing.T) {
	// Point -o at a path whose parent is an existing *file*, so MkdirAll fails.
	dir := t.TempDir()
	blocker := filepath.Join(dir, "blocker")
	if err := os.WriteFile(blocker, []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}
	withOutputConfig(t, filepath.Join(blocker, "nested"), false)

	got := writeResultToFile(okResult(0, "My Article", "# body"))

	if got.Status != "error" {
		t.Fatalf("status = %q, want error", got.Status)
	}
	if got.Error != "write_failed" {
		t.Errorf("error = %q, want write_failed", got.Error)
	}
	if got.OutputStatus != OutputFailed {
		t.Errorf("output_status = %q, want %q", got.OutputStatus, OutputFailed)
	}
	if !strings.Contains(got.Message, "failed to write output file") {
		t.Errorf("message = %q, want a readable write failure reason", got.Message)
	}
}

func TestWriteResultToFile_NoOutputRequested(t *testing.T) {
	withOutputConfig(t, "", false)

	got := writeResultToFile(okResult(0, "My Article", "# body"))

	if got.Status != "ok" {
		t.Errorf("status = %q, want ok", got.Status)
	}
	if got.OutputStatus != OutputNotRequested || got.OutputFile != "" {
		t.Errorf("output_status = %q, output_file = %q, want both empty", got.OutputStatus, got.OutputFile)
	}
}

func TestConsumeResults_NDJSONIncludesNewFields(t *testing.T) {
	dir := t.TempDir()
	withOutputConfig(t, dir, false)

	results := make(chan BatchResult, 2)
	results <- okResult(0, "First", "# one")
	results <- BatchResult{
		Seq:         1,
		OriginalURL: "https://example.com/broken",
		Status:      "error",
		Error:       "http_503",
		Message:     "HTTP 503",
		Attempts:    3,
	}
	close(results)

	var out, progress bytes.Buffer
	summary := consumeResults(results, &out, &progress, 2, true)

	if summary.ok != 1 || summary.failed != 1 {
		t.Fatalf("summary = %+v, want 1 ok / 1 failed", summary)
	}

	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	if len(lines) != 2 {
		t.Fatalf("got %d NDJSON lines, want 2: %q", len(lines), out.String())
	}

	var okRec map[string]any
	if err := json.Unmarshal([]byte(lines[0]), &okRec); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if okRec["output_status"] != OutputWritten {
		t.Errorf("output_status = %v, want %q", okRec["output_status"], OutputWritten)
	}
	if _, hasAttempts := okRec["attempts"]; !hasAttempts || okRec["attempts"] != float64(1) {
		t.Errorf("attempts = %v, want 1", okRec["attempts"])
	}
	if _, ok := okRec["output_file"]; !ok {
		t.Error("output_file missing from NDJSON")
	}

	var errRec map[string]any
	if err := json.Unmarshal([]byte(lines[1]), &errRec); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if errRec["attempts"] != float64(3) {
		t.Errorf("attempts = %v, want 3", errRec["attempts"])
	}
	if _, has := errRec["output_status"]; has {
		t.Errorf("output_status should be omitted when output was not attempted, got %v", errRec["output_status"])
	}
}

func TestConsumeResults_NoOutputFlagLeavesFieldsEmpty(t *testing.T) {
	withOutputConfig(t, "", false)

	results := make(chan BatchResult, 1)
	results <- okResult(0, "Lonely", "# md")
	close(results)

	var out bytes.Buffer
	summary := consumeResults(results, &out, nil, 1, outputFlag != "")

	if summary.ok != 1 || summary.failed != 0 {
		t.Fatalf("summary = %+v, want 1 ok", summary)
	}
	var rec map[string]any
	if err := json.Unmarshal(out.Bytes(), &rec); err != nil {
		t.Fatal(err)
	}
	if _, has := rec["output_status"]; has {
		t.Errorf("output_status should be omitted without -o, got %v", rec["output_status"])
	}
	if rec["status"] != "ok" {
		t.Errorf("status = %v, want ok", rec["status"])
	}
}

func TestConsumeResults_WriteFailureCountsAsFailure(t *testing.T) {
	dir := t.TempDir()
	blocker := filepath.Join(dir, "blocker")
	if err := os.WriteFile(blocker, []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}
	withOutputConfig(t, filepath.Join(blocker, "nested"), false)

	results := make(chan BatchResult, 1)
	results <- okResult(0, "Doomed", "# md")
	close(results)

	var out bytes.Buffer
	summary := consumeResults(results, &out, nil, 1, true)

	if summary.ok != 0 || summary.failed != 1 {
		t.Fatalf("summary = %+v, want 1 failed", summary)
	}
	if len(summary.errCodes) != 1 || summary.errCodes[0] != "write_failed" {
		t.Errorf("errCodes = %v, want [write_failed]", summary.errCodes)
	}

	var rec map[string]any
	if err := json.Unmarshal(out.Bytes(), &rec); err != nil {
		t.Fatal(err)
	}
	if rec["status"] != "error" {
		t.Errorf("status = %v, want error", rec["status"])
	}
	if rec["output_status"] != OutputFailed {
		t.Errorf("output_status = %v, want %q", rec["output_status"], OutputFailed)
	}

	// A single write failure out of one URL means total failure.
	be, ok := batchExitError(summary.failed, 1).(*batchError)
	if !ok || be.code != ExitTotalFailure {
		t.Errorf("exit = %v, want ExitTotalFailure", be)
	}
}

func TestBatchExitError(t *testing.T) {
	tests := []struct {
		failed, total int
		want          int // 0 means nil
	}{
		{0, 3, 0},
		{1, 3, ExitPartial},
		{3, 3, ExitTotalFailure},
		{1, 1, ExitTotalFailure},
	}
	for _, tt := range tests {
		err := batchExitError(tt.failed, tt.total)
		if tt.want == 0 {
			if err != nil {
				t.Errorf("batchExitError(%d,%d) = %v, want nil", tt.failed, tt.total, err)
			}
			continue
		}
		be, ok := err.(*batchError)
		if !ok || be.code != tt.want {
			t.Errorf("batchExitError(%d,%d) = %v, want code %d", tt.failed, tt.total, err, tt.want)
		}
	}
}

// testRetryConfig disables Go's HTTP transport keep-alive retries interfering
// with attempt counting and uses near-zero backoff.
func testRetryConfig(maxAttempts int) *batch.RetryConfig {
	return &batch.RetryConfig{MaxAttempts: maxAttempts, InitDelay: time.Millisecond}
}

func TestFetchAndExtract_AttemptsOnTransientThenSuccess(t *testing.T) {
	var hits int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := atomic.AddInt32(&hits, 1)
		if n < 3 {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, `<html><head><title>Recovered</title></head><body><article><h1>Recovered</h1><p>`+
			strings.Repeat("Body text for the article. ", 20)+`</p></article></body></html>`)
	}))
	defer srv.Close()
	restoreCmdFlags(t)

	res := fetchAndExtract(context.Background(), 0, srv.URL, batch.NewDomainLimiter(0), testRetryConfig(3), nil, 0)

	if res.Status != "ok" {
		t.Fatalf("status = %q (%s: %s), want ok", res.Status, res.Error, res.Message)
	}
	if res.Attempts != 3 {
		t.Errorf("attempts = %d, want 3", res.Attempts)
	}
	if got := atomic.LoadInt32(&hits); got != 3 {
		t.Errorf("server hits = %d, want 3", got)
	}
}

func TestFetchAndExtract_AttemptsOnPersistentFailure(t *testing.T) {
	var hits int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()
	restoreCmdFlags(t)

	res := fetchAndExtract(context.Background(), 0, srv.URL, batch.NewDomainLimiter(0), testRetryConfig(3), nil, 0)

	if res.Status != "error" || res.Error != "http_500" {
		t.Fatalf("status = %q, error = %q, want error/http_500", res.Status, res.Error)
	}
	if res.Attempts != 3 {
		t.Errorf("attempts = %d, want 3", res.Attempts)
	}
	if res.OutputStatus != OutputNotRequested {
		t.Errorf("output_status = %q, want empty for failed fetch", res.OutputStatus)
	}
}

func TestFetchAndExtract_NonRetryableAttemptsOnce(t *testing.T) {
	var hits int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		w.Header().Set("Content-Type", "application/pdf")
		fmt.Fprint(w, "%PDF-1.4")
	}))
	defer srv.Close()
	restoreCmdFlags(t)

	res := fetchAndExtract(context.Background(), 0, srv.URL, batch.NewDomainLimiter(0), testRetryConfig(3), nil, 0)

	if res.Status != "error" || res.Error != "unsupported_content_type" {
		t.Fatalf("status = %q, error = %q, want error/unsupported_content_type", res.Status, res.Error)
	}
	if res.Attempts != 1 {
		t.Errorf("attempts = %d, want 1", res.Attempts)
	}
	if got := atomic.LoadInt32(&hits); got != 1 {
		t.Errorf("server hits = %d, want 1", got)
	}
}

func TestFetchAndExtract_TimeoutAttempts(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(200 * time.Millisecond)
	}))
	defer srv.Close()
	restoreCmdFlags(t)

	prevTimeout := timeout
	timeout = 20 * time.Millisecond
	t.Cleanup(func() { timeout = prevTimeout })

	res := fetchAndExtract(context.Background(), 0, srv.URL, batch.NewDomainLimiter(0), testRetryConfig(2), nil, 0)

	if res.Status != "error" || res.Error != "fetch_failed" {
		t.Fatalf("status = %q, error = %q, want error/fetch_failed", res.Status, res.Error)
	}
	if res.Attempts != 2 {
		t.Errorf("attempts = %d, want 2 (network errors are retried)", res.Attempts)
	}
}

// restoreCmdFlags resets package-level command flags read by fetchAndExtract.
func restoreCmdFlags(t *testing.T) {
	t.Helper()
	prevType, prevNoImages := typeFlag, noImages
	typeFlag, noImages = "", false
	t.Cleanup(func() { typeFlag, noImages = prevType, prevNoImages })
}
