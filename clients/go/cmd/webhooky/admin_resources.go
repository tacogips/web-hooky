package main

import (
	"context"
	"os"
	"path/filepath"

	"github.com/tacogips/web-hooky/clients/go/webhooky"
)

// -- relays ------------------------------------------------------------------

func adminRelays(ctx context.Context, global *globals, args []string) error {
	if len(args) == 0 {
		return usageErrorf("expected: list | get | create | patch | delete | deliveries | retry")
	}
	command, rest := args[0], args[1:]

	switch command {
	case "list":
		set := newAdminSet("admin relays list", global)
		destinationID := set.String("destination-id", "", "narrow the listing to one destination")
		if _, err := parseSet(set, rest); err != nil {
			return err
		}
		client, err := global.adminClient()
		if err != nil {
			return err
		}
		relays, err := client.ListRelays(ctx, *destinationID)
		if err != nil {
			return err
		}
		return emit(global, relays)

	case "get":
		set := newAdminSet("admin relays get <id>", global)
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
		relay, err := client.GetRelay(ctx, id)
		if err != nil {
			return err
		}
		return emit(global, relay)

	case "create":
		return relaysCreate(ctx, global, rest)

	case "patch":
		return relaysPatch(ctx, global, rest)

	case "delete":
		set := newAdminSet("admin relays delete <id>", global)
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
		if err := client.DeleteRelay(ctx, id); err != nil {
			return err
		}
		return emit(global, map[string]any{"deleted": id})

	case "deliveries":
		set := newAdminSet("admin relays deliveries <id>", global)
		limit := set.Int("limit", 0, "maximum deliveries to return")
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
		page, err := client.ListRelayDeliveries(ctx, id, *limit)
		if err != nil {
			return err
		}
		return emit(global, page)

	case "retry":
		set := newAdminSet("admin relays retry <id>", global)
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
		result, err := client.RetryRelay(ctx, id)
		if err != nil {
			return err
		}
		return emit(global, result)

	default:
		return usageErrorf("unknown relays command %q", command)
	}
}

func relaysCreate(ctx context.Context, global *globals, args []string) error {
	set := newAdminSet("admin relays create", global)
	destinationID := set.String("destination-id", "", "destination to forward from (required)")
	name := set.String("name", "", "relay name (required)")
	targetURL := set.String("target-url", "", "http(s) URL to forward to (required)")
	secret := set.String("secret", "", "HMAC-SHA256 signing secret for outbound requests")
	enabled := set.Bool("enabled", true, "start the relay enabled")
	maxAttempts := set.Int64("max-attempts", 0, "attempt budget per delivery")
	backoff := set.Int64("backoff-seconds", 0, "base delay of the exponential backoff")
	timeout := set.Int64("timeout-seconds", 0, "per-request timeout; must stay below the server's delivery lease")
	provided, err := parseSet(set, args)
	if err != nil {
		return err
	}
	if *destinationID == "" || *name == "" || *targetURL == "" {
		return usageErrorf("--destination-id, --name and --target-url are required")
	}

	input := webhooky.CreateRelayInput{
		DestinationID: *destinationID,
		Name:          *name,
		TargetURL:     *targetURL,
	}
	if provided["secret"] {
		input.Secret = stringPtr(*secret)
	}
	if provided["enabled"] {
		input.Enabled = boolPtr(*enabled)
	}
	if provided["max-attempts"] {
		input.MaxAttempts = int64Ptr(*maxAttempts)
	}
	if provided["backoff-seconds"] {
		input.BackoffSeconds = int64Ptr(*backoff)
	}
	if provided["timeout-seconds"] {
		input.TimeoutSeconds = int64Ptr(*timeout)
	}

	client, err := global.adminClient()
	if err != nil {
		return err
	}
	relay, err := client.CreateRelay(ctx, input)
	if err != nil {
		return err
	}
	return emit(global, relay)
}

func relaysPatch(ctx context.Context, global *globals, args []string) error {
	set := newAdminSet("admin relays patch <id>", global)
	name := set.String("name", "", "new name")
	targetURL := set.String("target-url", "", "new target URL")
	secret := set.String("secret", "", "new signing secret; an empty value clears it")
	enabled := set.Bool("enabled", true, "enable or disable the relay")
	maxAttempts := set.Int64("max-attempts", 0, "attempt budget per delivery")
	backoff := set.Int64("backoff-seconds", 0, "base delay of the exponential backoff")
	timeout := set.Int64("timeout-seconds", 0, "per-request timeout")
	provided, err := parseSet(set, args)
	if err != nil {
		return err
	}
	id, err := requireArg(set, 0, "id")
	if err != nil {
		return err
	}

	var input webhooky.UpdateRelayInput
	if provided["name"] {
		input.Name = stringPtr(*name)
	}
	if provided["target-url"] {
		input.TargetURL = stringPtr(*targetURL)
	}
	if provided["secret"] {
		input.Secret = stringPtr(*secret)
	}
	if provided["enabled"] {
		input.Enabled = boolPtr(*enabled)
	}
	if provided["max-attempts"] {
		input.MaxAttempts = int64Ptr(*maxAttempts)
	}
	if provided["backoff-seconds"] {
		input.BackoffSeconds = int64Ptr(*backoff)
	}
	if provided["timeout-seconds"] {
		input.TimeoutSeconds = int64Ptr(*timeout)
	}

	client, err := global.adminClient()
	if err != nil {
		return err
	}
	relay, err := client.UpdateRelay(ctx, id, input)
	if err != nil {
		return err
	}
	return emit(global, relay)
}

// -- fetch API users ---------------------------------------------------------

func adminUsers(ctx context.Context, global *globals, args []string) error {
	if len(args) == 0 {
		return usageErrorf("expected: list | get | create | rotate | enable | disable | delete | grant | revoke")
	}
	command, rest := args[0], args[1:]

	// Every branch needs the client; building it once keeps the switch flat.
	set := newAdminSet("admin users "+command, global)
	label := set.String("label", "", "human-readable label (create)")
	if _, err := parseSet(set, rest); err != nil {
		return err
	}
	client, err := global.adminClient()
	if err != nil {
		return err
	}

	switch command {
	case "list":
		users, err := client.ListAPIUsers(ctx)
		if err != nil {
			return err
		}
		return emit(global, users)

	case "create":
		if *label == "" {
			return usageErrorf("--label is required")
		}
		created, err := client.CreateAPIUser(ctx, *label)
		if err != nil {
			return err
		}
		// The secret appears here and nowhere else, ever.
		return emit(global, created)

	case "get", "rotate", "enable", "disable", "delete":
		id, err := requireArg(set, 0, "id")
		if err != nil {
			return err
		}
		return usersByID(ctx, global, client, command, id)

	case "grant", "revoke":
		userID, err := requireArg(set, 0, "userId")
		if err != nil {
			return err
		}
		destinationID, err := requireArg(set, 1, "destinationId")
		if err != nil {
			return err
		}
		var user webhooky.APIUser
		if command == "grant" {
			user, err = client.GrantDestination(ctx, userID, destinationID)
		} else {
			user, err = client.RevokeDestination(ctx, userID, destinationID)
		}
		if err != nil {
			return err
		}
		return emit(global, user)

	default:
		return usageErrorf("unknown users command %q", command)
	}
}

func usersByID(
	ctx context.Context,
	global *globals,
	client *webhooky.AdminClient,
	command string,
	id string,
) error {
	switch command {
	case "get":
		user, err := client.GetAPIUser(ctx, id)
		if err != nil {
			return err
		}
		return emit(global, user)
	case "rotate":
		created, err := client.RotateAPIUserSecret(ctx, id)
		if err != nil {
			return err
		}
		return emit(global, created)
	case "enable", "disable":
		user, err := client.SetAPIUserEnabled(ctx, id, command == "enable")
		if err != nil {
			return err
		}
		return emit(global, user)
	case "delete":
		if err := client.DeleteAPIUser(ctx, id); err != nil {
			return err
		}
		return emit(global, map[string]any{"deleted": id})
	default:
		return usageErrorf("unknown users command %q", command)
	}
}

// -- addons ------------------------------------------------------------------

func adminAddons(ctx context.Context, global *globals, args []string) error {
	if len(args) == 0 {
		return usageErrorf("expected: list | get | upload | delete")
	}
	command, rest := args[0], args[1:]

	set := newAdminSet("admin addons "+command, global)
	if _, err := parseSet(set, rest); err != nil {
		return err
	}
	client, err := global.adminClient()
	if err != nil {
		return err
	}

	switch command {
	case "list":
		addons, err := client.ListAddons(ctx)
		if err != nil {
			return err
		}
		return emit(global, addons)

	case "get":
		name, err := requireArg(set, 0, "name")
		if err != nil {
			return err
		}
		addon, err := client.GetAddon(ctx, name)
		if err != nil {
			return err
		}
		return emit(global, addon)

	case "upload":
		path, err := requireArg(set, 0, "package.zip")
		if err != nil {
			return err
		}
		archive, err := os.ReadFile(path)
		if err != nil {
			return usageErrorf("failed to read %s: %v", path, err)
		}
		addon, err := client.UploadAddon(ctx, filepath.Base(path), archive)
		if err != nil {
			return err
		}
		return emit(global, addon)

	case "delete":
		name, err := requireArg(set, 0, "name")
		if err != nil {
			return err
		}
		if err := client.DeleteAddon(ctx, name); err != nil {
			return err
		}
		return emit(global, map[string]any{"deleted": name})

	default:
		return usageErrorf("unknown addons command %q", command)
	}
}

// -- admin keys and admin users ----------------------------------------------

func adminKeys(ctx context.Context, global *globals, args []string) error {
	if len(args) == 0 {
		return usageErrorf("expected: list | create | delete")
	}
	command, rest := args[0], args[1:]

	set := newAdminSet("admin keys "+command, global)
	label := set.String("label", "", "human-readable label (create)")
	if _, err := parseSet(set, rest); err != nil {
		return err
	}
	client, err := global.adminClient()
	if err != nil {
		return err
	}

	switch command {
	case "list":
		keys, err := client.ListAdminKeys(ctx)
		if err != nil {
			return err
		}
		return emit(global, keys)

	case "create":
		if *label == "" {
			return usageErrorf("--label is required")
		}
		created, err := client.CreateAdminKey(ctx, *label)
		if err != nil {
			return err
		}
		return emit(global, created)

	case "delete":
		id, err := requireArg(set, 0, "id")
		if err != nil {
			return err
		}
		if err := client.DeleteAdminKey(ctx, id); err != nil {
			return err
		}
		return emit(global, map[string]any{"deleted": id})

	default:
		return usageErrorf("unknown keys command %q", command)
	}
}

func adminAdminUsers(ctx context.Context, global *globals, args []string) error {
	if len(args) == 0 {
		return usageErrorf("expected: list | create | delete")
	}
	command, rest := args[0], args[1:]

	set := newAdminSet("admin admin-users "+command, global)
	if _, err := parseSet(set, rest); err != nil {
		return err
	}
	client, err := global.adminClient()
	if err != nil {
		return err
	}

	switch command {
	case "list":
		users, err := client.ListAdminUsers(ctx)
		if err != nil {
			return err
		}
		return emit(global, users)

	case "create":
		subject, err := requireArg(set, 0, "subject")
		if err != nil {
			return err
		}
		user, err := client.CreateAdminUser(ctx, subject)
		if err != nil {
			return err
		}
		return emit(global, user)

	case "delete":
		subject, err := requireArg(set, 0, "subject")
		if err != nil {
			return err
		}
		if err := client.DeleteAdminUser(ctx, subject); err != nil {
			return err
		}
		return emit(global, map[string]any{"deleted": subject})

	default:
		return usageErrorf("unknown admin-users command %q", command)
	}
}
