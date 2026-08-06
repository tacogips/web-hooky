// Command webhooky is the CLI for a web-hooky server.
//
// It reads credentials from WEBHOOKY_* environment variables and writes JSON to
// stdout; every capability it offers is one call into the webhooky package, so
// anything scriptable here is equally available to a Go program.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/tacogips/web-hooky/clients/go/webhooky"
)

const userAgent = "webhooky-go-cli/" + webhooky.Version

// Exit codes. Usage problems are distinguished from server failures so a shell
// script can tell "I called it wrong" from "the call was refused".
const (
	exitOK      = 0
	exitFailure = 1
	exitUsage   = 2
)

// usageError marks a failure in how the command was invoked.
type usageError struct{ message string }

func (u *usageError) Error() string { return u.message }

func usageErrorf(format string, args ...any) error {
	return &usageError{message: fmt.Sprintf(format, args...)}
}

func main() {
	os.Exit(run(os.Args[1:]))
}

func run(args []string) int {
	global := &globals{}
	set := flag.NewFlagSet("webhooky", flag.ContinueOnError)
	set.SetOutput(os.Stderr)
	set.Usage = func() { fmt.Fprint(os.Stderr, usageText) }
	registerGlobals(set, global)
	showVersion := set.Bool("version", false, "print the client version and exit")

	if err := set.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return exitOK
		}
		return exitUsage
	}
	if *showVersion {
		fmt.Println(userAgent)
		return exitOK
	}

	rest := set.Args()
	if len(rest) == 0 {
		fmt.Fprint(os.Stderr, usageText)
		return exitUsage
	}

	// Ctrl-C has to reach a running stream, which otherwise blocks forever.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	var err error
	switch rest[0] {
	case "records":
		err = runRecords(ctx, global, rest[1:])
	case "admin":
		err = runAdmin(ctx, global, rest[1:])
	case "help":
		fmt.Fprint(os.Stdout, usageText)
		return exitOK
	default:
		err = usageErrorf("unknown command group %q", rest[0])
	}
	return report(err)
}

// registerGlobals attaches the flags every command accepts to a flag set.
//
// They are registered on each subcommand set as well, so both
// `webhooky --pretty records get` and `webhooky records get --pretty` work;
// users should not have to remember which side of the verb a flag lives on.
func registerGlobals(set *flag.FlagSet, into *globals) {
	set.StringVar(&into.url, "url", into.url, "server base URL ("+envURL+")")
	set.Float64Var(&into.timeout, "timeout", into.timeout, "request timeout in seconds ("+envTimeout+")")
	set.Var(&into.headers, "header", "extra request header \"name=value\"; repeatable ("+envHeaders+")")
	set.BoolVar(&into.pretty, "pretty", into.pretty, "indent JSON output")
}

// report renders an error and picks the process exit code.
func report(err error) int {
	if err == nil {
		return exitOK
	}
	var usage *usageError
	if errors.As(err, &usage) {
		fmt.Fprintln(os.Stderr, "webhooky: "+usage.message)
		fmt.Fprintln(os.Stderr, `Run "webhooky help" for usage.`)
		return exitUsage
	}
	if errors.Is(err, context.Canceled) {
		// Ctrl-C during a stream is a normal way to stop.
		return exitOK
	}

	var apiError *webhooky.Error
	if errors.As(err, &apiError) {
		payload := map[string]any{"error": map[string]any{
			"status":  apiError.Status,
			"kind":    apiError.Kind,
			"message": apiError.Message,
		}}
		if encoded, marshalErr := json.Marshal(payload); marshalErr == nil {
			fmt.Fprintln(os.Stderr, string(encoded))
			return exitFailure
		}
	}
	fmt.Fprintln(os.Stderr, "webhooky: "+err.Error())
	return exitFailure
}

const usageText = `webhooky - client for a web-hooky server

Usage:
  webhooky [flags] <group> <command> [flags]

Global flags:
  --url <url>            server base URL (WEBHOOKY_URL, default http://127.0.0.1:8787)
  --timeout <seconds>    request timeout (WEBHOOKY_TIMEOUT_SECONDS, default 30)
  --header <name=value>  extra request header; repeatable (WEBHOOKY_HEADERS)
  --pretty               indent JSON output
  --version              print the client version

Command groups:
  records get       read stored records
  records stream    stream records over WebSocket as newline-delimited JSON
  admin me          show the identity the server resolved
  admin destinations  list | get | create | patch | delete | rotate-fetch-uuid | records
  admin relays        list | get | create | patch | delete | deliveries | retry
  admin users         list | get | create | rotate | enable | disable | delete | grant | revoke
  admin addons        list | get | upload | delete
  admin keys          list | create | delete
  admin admin-users   list | create | delete

Environment:
  WEBHOOKY_URL                 server base URL
  WEBHOOKY_API_KEY             fetch API user key id       (records)
  WEBHOOKY_API_SECRET          fetch API user secret       (records)
  WEBHOOKY_CREDENTIAL          "<keyId>:<secret>" instead of the pair above
  WEBHOOKY_FETCH_UUID          default --fetch-uuid
  WEBHOOKY_ADMIN_CREDENTIAL    "<keyId>:<secret>" admin API key   (admin)
  WEBHOOKY_ADMIN_KEY           admin key id                       (admin)
  WEBHOOKY_ADMIN_SECRET        admin key secret                   (admin)
  WEBHOOKY_TIMEOUT_SECONDS     request timeout in seconds
  WEBHOOKY_HEADERS             "name=value,name=value" extra headers

Exit codes:
  0 success   1 request failed   2 usage error

Run "webhooky <group> <command> -h" for the flags of one command.
`
