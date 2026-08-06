package main

import (
	"context"
	"flag"
	"fmt"
	"os"

	"github.com/tacogips/web-hooky/clients/go/webhooky"
)

func runRecords(ctx context.Context, global *globals, args []string) error {
	if len(args) == 0 {
		return usageErrorf("expected \"records get\" or \"records stream\"")
	}
	switch args[0] {
	case "get":
		return recordsGet(ctx, global, args[1:])
	case "stream":
		return recordsStream(ctx, global, args[1:])
	default:
		return usageErrorf("unknown records command %q", args[0])
	}
}

func recordsGet(ctx context.Context, global *globals, args []string) error {
	set := flag.NewFlagSet("records get", flag.ContinueOnError)
	set.SetOutput(os.Stderr)
	registerGlobals(set, global)
	fetchUUID := set.String("fetch-uuid", "", "destination fetch uuid ("+envFetchUUID+")")
	onlyUnfetched := set.Bool("only-unfetched", false, "return only records not yet fetched")
	noMarkFetched := set.Bool("no-mark-fetched", false, "leave the returned records unmarked")
	from := set.String("from", "", "lower time bound: unix seconds or RFC 3339")
	to := set.String("to", "", "upper time bound: unix seconds or RFC 3339")
	limit := set.Int("limit", 0, "maximum records to return (server default when unset)")
	set.Usage = func() {
		fmt.Fprintln(os.Stderr, "Usage: webhooky records get [flags]")
		set.PrintDefaults()
	}
	if err := set.Parse(args); err != nil {
		return usageErrorf("%v", err)
	}

	uuid, err := resolveFetchUUID(*fetchUUID)
	if err != nil {
		return err
	}
	fromTime, err := parseTimeArg(*from, "from")
	if err != nil {
		return err
	}
	toTime, err := parseTimeArg(*to, "to")
	if err != nil {
		return err
	}

	client, err := global.fetchClient()
	if err != nil {
		return err
	}
	records, err := client.Records(ctx, uuid, webhooky.RecordQuery{
		OnlyUnfetched: *onlyUnfetched,
		KeepUnfetched: *noMarkFetched,
		From:          fromTime,
		To:            toTime,
		Limit:         *limit,
	})
	if err != nil {
		return err
	}
	return emit(global, records)
}

func recordsStream(ctx context.Context, global *globals, args []string) error {
	set := flag.NewFlagSet("records stream", flag.ContinueOnError)
	set.SetOutput(os.Stderr)
	registerGlobals(set, global)
	fetchUUID := set.String("fetch-uuid", "", "destination fetch uuid ("+envFetchUUID+")")
	reconnect := set.Bool("reconnect", false, "reconnect with backoff after a transport failure")
	maxRecords := set.Int("max-records", 0, "stop after this many records (0 = unlimited)")
	queryCredentials := set.Bool("query-credentials", false,
		"send credentials as query parameters instead of an Authorization header")
	set.Usage = func() {
		fmt.Fprintln(os.Stderr, "Usage: webhooky records stream [flags]")
		fmt.Fprintln(os.Stderr, "Writes one JSON record per line until interrupted.")
		set.PrintDefaults()
	}
	if err := set.Parse(args); err != nil {
		return usageErrorf("%v", err)
	}

	uuid, err := resolveFetchUUID(*fetchUUID)
	if err != nil {
		return err
	}
	client, err := global.fetchClient()
	if err != nil {
		return err
	}

	writer := newLineWriter()
	return client.Stream(ctx, uuid, webhooky.StreamOptions{
		Reconnect:        *reconnect,
		QueryCredentials: *queryCredentials,
		MaxRecords:       *maxRecords,
		// Progress goes to stderr so stdout stays a clean record stream.
		OnReady: func() {
			fmt.Fprintln(os.Stderr, "webhooky: streaming "+uuid)
		},
		OnReconnect: func(attempt int, cause error) {
			fmt.Fprintf(os.Stderr, "webhooky: reconnect attempt %d after: %v\n", attempt, cause)
		},
	}, func(record webhooky.Record) error {
		return writer.write(record)
	})
}
