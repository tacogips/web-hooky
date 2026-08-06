import ArgumentParser
import Foundation
import WebHooky

/// `webhooky admin relays ...`
struct RelaysCommand: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "relays",
        abstract: "Manage forwarding targets.",
        subcommands: [
            ListCommand.self,
            GetCommand.self,
            CreateCommand.self,
            PatchCommand.self,
            DeleteCommand.self,
            DeliveriesCommand.self,
            RetryCommand.self,
        ]
    )

    struct ListCommand: AsyncParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "list", abstract: "List relays.")

        @OptionGroup var options: GlobalOptions
        @Option(name: .long, help: "Narrow the listing to one destination.")
        var destinationId: String?

        func run() async throws {
            try Output.emit(
                await options.adminClient().listRelays(destinationID: destinationId),
                pretty: options.pretty
            )
        }
    }

    struct GetCommand: AsyncParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "get", abstract: "Show one relay.")

        @OptionGroup var options: GlobalOptions
        @Argument(help: "Relay id.") var id: String

        func run() async throws {
            try Output.emit(
                await options.adminClient().getRelay(id: id), pretty: options.pretty)
        }
    }

    struct CreateCommand: AsyncParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "create",
            abstract: "Attach a forwarding target to a destination."
        )

        @OptionGroup var options: GlobalOptions
        @Option(name: .long) var destinationId: String
        @Option(name: .long) var name: String
        @Option(name: .long, help: "http(s) URL to forward to.") var targetUrl: String
        @Option(name: .long, help: "HMAC-SHA256 signing secret.") var secret: String?
        @Option(name: .long) var maxAttempts: Int?
        @Option(name: .long) var backoffSeconds: Int?
        @Option(
            name: .long,
            help: "Must stay below the server's delivery lease."
        )
        var timeoutSeconds: Int?

        func run() async throws {
            let relay = try await options.adminClient().createRelay(
                CreateRelayInput(
                    destinationId: destinationId,
                    name: name,
                    targetUrl: targetUrl,
                    secret: secret,
                    maxAttempts: maxAttempts,
                    backoffSeconds: backoffSeconds,
                    timeoutSeconds: timeoutSeconds
                )
            )
            try Output.emit(relay, pretty: options.pretty)
        }
    }

    struct PatchCommand: AsyncParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "patch", abstract: "Update a relay.")

        @OptionGroup var options: GlobalOptions
        @Argument(help: "Relay id.") var id: String

        @Option(name: .long) var name: String?
        @Option(name: .long) var targetUrl: String?
        @Option(name: .long, help: "An empty value clears the signing secret.")
        var secret: String?
        @Option(name: .long) var enabled: Bool?
        @Option(name: .long) var maxAttempts: Int?
        @Option(name: .long) var backoffSeconds: Int?
        @Option(name: .long) var timeoutSeconds: Int?

        func run() async throws {
            let relay = try await options.adminClient().updateRelay(
                id: id,
                UpdateRelayInput(
                    name: name,
                    targetUrl: targetUrl,
                    secret: secret,
                    enabled: enabled,
                    maxAttempts: maxAttempts,
                    backoffSeconds: backoffSeconds,
                    timeoutSeconds: timeoutSeconds
                )
            )
            try Output.emit(relay, pretty: options.pretty)
        }
    }

    struct DeleteCommand: AsyncParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "delete", abstract: "Delete a relay.")

        @OptionGroup var options: GlobalOptions
        @Argument(help: "Relay id.") var id: String

        func run() async throws {
            try await options.adminClient().deleteRelay(id: id)
            try Output.emit(DeletedAck(deleted: id), pretty: options.pretty)
        }
    }

    struct DeliveriesCommand: AsyncParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "deliveries", abstract: "List a relay's deliveries.")

        @OptionGroup var options: GlobalOptions
        @Argument(help: "Relay id.") var id: String
        @Option(name: .long) var limit: Int?

        func run() async throws {
            try Output.emit(
                await options.adminClient().listRelayDeliveries(id: id, limit: limit),
                pretty: options.pretty
            )
        }
    }

    struct RetryCommand: AsyncParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "retry",
            abstract: "Requeue this relay's failed deliveries."
        )

        @OptionGroup var options: GlobalOptions
        @Argument(help: "Relay id.") var id: String

        func run() async throws {
            let requeued = try await options.adminClient().retryRelay(id: id)
            try Output.emit(RequeuedAck(requeued: requeued), pretty: options.pretty)
        }
    }
}

/// `webhooky admin users ...`
struct UsersCommand: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "users",
        abstract: "Manage fetch API users and their grants.",
        subcommands: [
            ListCommand.self,
            GetCommand.self,
            CreateCommand.self,
            RotateCommand.self,
            EnableCommand.self,
            DisableCommand.self,
            DeleteCommand.self,
            GrantCommand.self,
            RevokeCommand.self,
        ]
    )

    struct ListCommand: AsyncParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "list", abstract: "List every fetch API user.")

        @OptionGroup var options: GlobalOptions

        func run() async throws {
            try Output.emit(
                await options.adminClient().listApiUsers(), pretty: options.pretty)
        }
    }

    struct GetCommand: AsyncParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "get", abstract: "Show one fetch API user.")

        @OptionGroup var options: GlobalOptions
        @Argument(help: "Fetch API user id.") var id: String

        func run() async throws {
            try Output.emit(
                await options.adminClient().getApiUser(id: id), pretty: options.pretty)
        }
    }

    struct CreateCommand: AsyncParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "create",
            abstract: "Mint a key/secret pair; the secret is shown exactly once."
        )

        @OptionGroup var options: GlobalOptions
        @Option(name: .long, help: "Human-readable label.") var label: String

        func run() async throws {
            try Output.emit(
                await options.adminClient().createApiUser(label: label),
                pretty: options.pretty
            )
        }
    }

    struct RotateCommand: AsyncParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "rotate", abstract: "Issue a new secret.")

        @OptionGroup var options: GlobalOptions
        @Argument(help: "Fetch API user id.") var id: String

        func run() async throws {
            try Output.emit(
                await options.adminClient().rotateApiUserSecret(id: id),
                pretty: options.pretty
            )
        }
    }

    struct EnableCommand: AsyncParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "enable", abstract: "Enable a fetch API user.")

        @OptionGroup var options: GlobalOptions
        @Argument(help: "Fetch API user id.") var id: String

        func run() async throws {
            try Output.emit(
                await options.adminClient().setApiUserEnabled(id: id, enabled: true),
                pretty: options.pretty
            )
        }
    }

    struct DisableCommand: AsyncParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "disable", abstract: "Disable a fetch API user.")

        @OptionGroup var options: GlobalOptions
        @Argument(help: "Fetch API user id.") var id: String

        func run() async throws {
            try Output.emit(
                await options.adminClient().setApiUserEnabled(id: id, enabled: false),
                pretty: options.pretty
            )
        }
    }

    struct DeleteCommand: AsyncParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "delete", abstract: "Delete a fetch API user.")

        @OptionGroup var options: GlobalOptions
        @Argument(help: "Fetch API user id.") var id: String

        func run() async throws {
            try await options.adminClient().deleteApiUser(id: id)
            try Output.emit(DeletedAck(deleted: id), pretty: options.pretty)
        }
    }

    struct GrantCommand: AsyncParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "grant",
            abstract: "Authorize a fetch API user to read a destination."
        )

        @OptionGroup var options: GlobalOptions
        @Argument(help: "Fetch API user id.") var id: String
        @Argument(help: "Destination id.") var destinationId: String

        func run() async throws {
            try Output.emit(
                await options.adminClient().grantDestination(
                    userID: id, destinationID: destinationId),
                pretty: options.pretty
            )
        }
    }

    struct RevokeCommand: AsyncParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "revoke",
            abstract: "Withdraw a grant, closing the streams it authorized."
        )

        @OptionGroup var options: GlobalOptions
        @Argument(help: "Fetch API user id.") var id: String
        @Argument(help: "Destination id.") var destinationId: String

        func run() async throws {
            try Output.emit(
                await options.adminClient().revokeDestination(
                    userID: id, destinationID: destinationId),
                pretty: options.pretty
            )
        }
    }
}
