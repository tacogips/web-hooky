package main

import (
	"context"
	"flag"
	"fmt"
	"os"

	"github.com/tacogips/web-hooky/clients/go/webhooky"
)

func runAdmin(ctx context.Context, global *globals, args []string) error {
	if len(args) == 0 {
		return usageErrorf("expected an admin resource: me, destinations, relays, users, addons, keys, admin-users")
	}
	switch args[0] {
	case "me":
		return adminMe(ctx, global, args[1:])
	case "destinations":
		return adminDestinations(ctx, global, args[1:])
	case "relays":
		return adminRelays(ctx, global, args[1:])
	case "users":
		return adminUsers(ctx, global, args[1:])
	case "addons":
		return adminAddons(ctx, global, args[1:])
	case "keys":
		return adminKeys(ctx, global, args[1:])
	case "admin-users":
		return adminAdminUsers(ctx, global, args[1:])
	default:
		return usageErrorf("unknown admin resource %q", args[0])
	}
}

// newAdminSet builds a subcommand flag set that also accepts the global flags.
func newAdminSet(name string, global *globals) *flag.FlagSet {
	set := flag.NewFlagSet(name, flag.ContinueOnError)
	set.SetOutput(os.Stderr)
	registerGlobals(set, global)
	set.Usage = func() {
		fmt.Fprintf(os.Stderr, "Usage: webhooky %s [flags]\n", name)
		set.PrintDefaults()
	}
	return set
}

// parseSet parses args and records which flags were explicitly provided, which
// is what tells a partial update "clear this" from "leave it alone".
func parseSet(set *flag.FlagSet, args []string) (map[string]bool, error) {
	if err := set.Parse(args); err != nil {
		return nil, usageErrorf("%v", err)
	}
	provided := map[string]bool{}
	set.Visit(func(f *flag.Flag) { provided[f.Name] = true })
	return provided, nil
}

// requireArg pulls a positional argument, naming it in the error.
func requireArg(set *flag.FlagSet, index int, name string) (string, error) {
	if set.NArg() <= index {
		return "", usageErrorf("missing required argument <%s>", name)
	}
	return set.Arg(index), nil
}

func adminMe(ctx context.Context, global *globals, args []string) error {
	set := newAdminSet("admin me", global)
	if _, err := parseSet(set, args); err != nil {
		return err
	}
	client, err := global.adminClient()
	if err != nil {
		return err
	}
	identity, err := client.Me(ctx)
	if err != nil {
		return err
	}
	return emit(global, identity)
}

// -- destinations ------------------------------------------------------------

func adminDestinations(ctx context.Context, global *globals, args []string) error {
	if len(args) == 0 {
		return usageErrorf("expected: list | get | create | patch | delete | rotate-fetch-uuid | records")
	}
	command, rest := args[0], args[1:]

	switch command {
	case "list":
		set := newAdminSet("admin destinations list", global)
		if _, err := parseSet(set, rest); err != nil {
			return err
		}
		client, err := global.adminClient()
		if err != nil {
			return err
		}
		destinations, err := client.ListDestinations(ctx)
		if err != nil {
			return err
		}
		return emit(global, destinations)

	case "get":
		set := newAdminSet("admin destinations get <id>", global)
		if _, err := parseSet(set, rest); err != nil {
			return err
		}
		id, err := requireArg(set, 0, "id")
		if err != nil {
			return err
		}
		client, err := global.adminClient()
		if err != nil {
			return err
		}
		destination, err := client.GetDestination(ctx, id)
		if err != nil {
			return err
		}
		return emit(global, destination)

	case "create":
		return destinationsCreate(ctx, global, rest)

	case "patch":
		return destinationsPatch(ctx, global, rest)

	case "delete":
		set := newAdminSet("admin destinations delete <id>", global)
		if _, err := parseSet(set, rest); err != nil {
			return err
		}
		id, err := requireArg(set, 0, "id")
		if err != nil {
			return err
		}
		client, err := global.adminClient()
		if err != nil {
			return err
		}
		if err := client.DeleteDestination(ctx, id); err != nil {
			return err
		}
		return emit(global, map[string]any{"deleted": id})

	case "rotate-fetch-uuid":
		set := newAdminSet("admin destinations rotate-fetch-uuid <id>", global)
		if _, err := parseSet(set, rest); err != nil {
			return err
		}
		id, err := requireArg(set, 0, "id")
		if err != nil {
			return err
		}
		client, err := global.adminClient()
		if err != nil {
			return err
		}
		destination, err := client.RotateFetchUUID(ctx, id)
		if err != nil {
			return err
		}
		return emit(global, destination)

	case "records":
		set := newAdminSet("admin destinations records <id>", global)
		limit := set.Int("limit", 0, "maximum records to return")
		if _, err := parseSet(set, rest); err != nil {
			return err
		}
		id, err := requireArg(set, 0, "id")
		if err != nil {
			return err
		}
		client, err := global.adminClient()
		if err != nil {
			return err
		}
		records, err := client.ListDestinationRecords(ctx, id, *limit)
		if err != nil {
			return err
		}
		return emit(global, records)

	default:
		return usageErrorf("unknown destinations command %q", command)
	}
}

func destinationsCreate(ctx context.Context, global *globals, args []string) error {
	set := newAdminSet("admin destinations create", global)
	name := set.String("name", "", "destination name (required)")
	vendorAddon := set.String("vendor-addon", "", "vendor addon name (required)")
	destinationAddon := set.String("destination-addon", "", "destination addon name")
	vendorConfig := set.String("vendor-config", "", "vendor addon config: inline JSON or @file.json")
	destinationConfig := set.String("destination-config", "", "destination addon config: inline JSON or @file.json")
	retention := set.Int64("retention-seconds", 0, "per-destination retention override")
	provided, err := parseSet(set, args)
	if err != nil {
		return err
	}
	if *name == "" || *vendorAddon == "" {
		return usageErrorf("--name and --vendor-addon are required")
	}

	vendorJSON, err := parseJSONArg(*vendorConfig)
	if err != nil {
		return err
	}
	destinationJSON, err := parseJSONArg(*destinationConfig)
	if err != nil {
		return err
	}

	input := webhooky.CreateDestinationInput{
		Name:              *name,
		VendorAddon:       *vendorAddon,
		VendorConfig:      vendorJSON,
		DestinationConfig: destinationJSON,
	}
	if *destinationAddon != "" {
		input.DestinationAddon = stringPtr(*destinationAddon)
	}
	if provided["retention-seconds"] {
		input.RetentionSeconds = int64Ptr(*retention)
	}

	client, err := global.adminClient()
	if err != nil {
		return err
	}
	destination, err := client.CreateDestination(ctx, input)
	if err != nil {
		return err
	}
	return emit(global, destination)
}

func destinationsPatch(ctx context.Context, global *globals, args []string) error {
	set := newAdminSet("admin destinations patch <id>", global)
	name := set.String("name", "", "new name")
	enabled := set.Bool("enabled", true, "enable or disable every public surface of this destination")
	destinationAddon := set.String("destination-addon", "", "destination addon name (empty string clears it)")
	vendorConfig := set.String("vendor-config", "", "vendor addon config: inline JSON or @file.json")
	destinationConfig := set.String("destination-config", "", "destination addon config: inline JSON or @file.json")
	retention := set.Int64("retention-seconds", 0, "per-destination retention override")
	provided, err := parseSet(set, args)
	if err != nil {
		return err
	}
	id, err := requireArg(set, 0, "id")
	if err != nil {
		return err
	}

	// Only flags the user actually typed are sent, so a patch never resets a
	// field the caller did not mention.
	var input webhooky.UpdateDestinationInput
	if provided["name"] {
		input.Name = stringPtr(*name)
	}
	if provided["enabled"] {
		input.Enabled = boolPtr(*enabled)
	}
	if provided["destination-addon"] {
		input.DestinationAddon = stringPtr(*destinationAddon)
	}
	if provided["retention-seconds"] {
		input.RetentionSeconds = int64Ptr(*retention)
	}
	if provided["vendor-config"] {
		if input.VendorConfig, err = parseJSONArg(*vendorConfig); err != nil {
			return err
		}
	}
	if provided["destination-config"] {
		if input.DestinationConfig, err = parseJSONArg(*destinationConfig); err != nil {
			return err
		}
	}

	client, err := global.adminClient()
	if err != nil {
		return err
	}
	destination, err := client.UpdateDestination(ctx, id, input)
	if err != nil {
		return err
	}
	return emit(global, destination)
}
