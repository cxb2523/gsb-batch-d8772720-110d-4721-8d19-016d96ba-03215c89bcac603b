package main

import (
	"bufio"
	"flag"
	"fmt"
	"log"
	"os"
	"strings"
	"time"

	"github.com/froxy/db"
	"github.com/froxy/functions"
	"github.com/froxy/models"
	"github.com/joho/godotenv"
)

// crawlableSites can be hard-coded here; when it is empty the seed URLs are
// taken from the command line instead.
var crawlableSites = []string{}

func main() {

	fmt.Println("starting spider bot")

	retryOnly := flag.Bool("retry", false, "retry only the failed seeds listed in the failed-seeds file")
	failedFile := flag.String("failed-file", "failed_seeds.txt", "path of the file used to record and reload failed seed URLs")
	workers := flag.Int("workers", 5, "number of concurrent crawler workers")
	flag.Parse()

	seedUrls := crawlableSites
	if len(seedUrls) == 0 {
		seedUrls = flag.Args()
	}

	if *retryOnly {
		seeds, err := readFailedSeeds(*failedFile)
		if err != nil {
			if os.IsNotExist(err) {
				fmt.Printf("retry mode: failed-seeds file %q does not exist, nothing to retry. Exiting normally.\n", *failedFile)
				return
			}
			fmt.Printf("retry mode: could not read failed-seeds file %q: %v. Exiting normally.\n", *failedFile, err)
			return
		}
		if len(seeds) == 0 {
			fmt.Printf("retry mode: failed-seeds file %q contains no failed seeds, nothing to retry. Exiting normally.\n", *failedFile)
			return
		}
		seedUrls = seeds
		fmt.Printf("retry mode: loaded %d failed seed(s) from %s\n", len(seedUrls), *failedFile)
	}

	if len(seedUrls) == 0 {
		fmt.Println("No seed URLs provided.")
		fmt.Println("Usage: spider [flags] <seed-url> [seed-url...]")
		flag.PrintDefaults()
		return
	}

	err := godotenv.Load()
	if err != nil {
		log.Panic(err)
		return
	}

	err = db.InitQdrant()
	if err != nil {
		log.Panic(err)
		return
	}

	err = db.InitPostgres(db.Client)
	if err != nil {
		log.Println(err)
		return
	}

	defer db.GetPostgresHandler().GracefulShutdown(time.Second * 5)

	crawler := functions.NewCrawler()

	results := crawler.Start(
		*workers,
		seedUrls...,
	)

	failedCount, err := writeFailedSeeds(*failedFile, results)
	if err != nil {
		log.Printf("Failed to write failed-seeds file %s: %v", *failedFile, err)
		return
	}
	if failedCount > 0 {
		fmt.Printf("%d failed seed(s) written to %s (rerun with -retry to crawl only these)\n", failedCount, *failedFile)
	} else {
		fmt.Printf("All seeds succeeded; failed-seeds file %s contains no entries.\n", *failedFile)
	}
}

// readFailedSeeds loads seed URLs from a failed-seeds file. Blank lines and
// lines starting with '#' are ignored; only the first tab-separated field of
// each remaining line is used, so status/reason annotations are skipped.
func readFailedSeeds(path string) ([]string, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()

	var seeds []string
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		seed := strings.TrimSpace(strings.SplitN(line, "\t", 2)[0])
		if seed != "" {
			seeds = append(seeds, seed)
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	return seeds, nil
}

// writeFailedSeeds rewrites the failed-seeds file with the non-successful
// results of this run. Successful seeds are never written, so a fully
// successful run leaves the file with no retryable entries.
func writeFailedSeeds(path string, results []models.SeedResult) (int, error) {
	file, err := os.Create(path)
	if err != nil {
		return 0, err
	}
	defer file.Close()

	if _, err := fmt.Fprintf(file, "# failed spider seeds, written at %s\n", time.Now().Format("2006-01-02 15:04:05")); err != nil {
		return 0, err
	}
	if _, err := fmt.Fprintln(file, "# format: <seed-url>\t<status>\t<reason> (only the URL is re-read in -retry mode)"); err != nil {
		return 0, err
	}

	failedCount := 0
	for _, result := range results {
		if result.Status == models.SeedStatusSuccess {
			continue
		}
		failedCount++
		reason := strings.NewReplacer("\t", " ", "\r", " ", "\n", " ").Replace(result.Reason)
		if _, err := fmt.Fprintf(file, "%s\t%s\t%s\n", result.SeedURL, result.Status, reason); err != nil {
			return failedCount, err
		}
	}

	return failedCount, nil
}
