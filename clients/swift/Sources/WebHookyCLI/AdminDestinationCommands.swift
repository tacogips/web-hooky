import ArgumentParser
import Foundation
import WebHooky

/// `webhooky admin ...`
struct AdminCommand: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "admin",
        abstract: "Administer the server.",
        subcommands: [
            MeCommand.self,
            DestinationsCommand.self,
            RelaysCommand.self,
            UsersCommand.self,
            AddonsCommand.self,
            KeysCommand.self,
            AdminUsersCommand.self,
        ]
    )

    /// `webhooky admin me`
    struct MeCommand: AsyncParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "me",
            abstract: "Show the identity the server resolved."
        )

        @OptionGroup var options: GlobalOptions

        func run() async throws {
            let identity = try await options.adminClient().me()
            try Output.emit(identity, pretty: options.pretty)
        }
    }
}

/// `webhooky admin destinations ...`
struct DestinationsCommand: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "destinations",
        abstract: "Manage webhook destinations.",
        subcommands: [
            ListCommand.self,
            GetCommand.self,
            CreateCommand.self,
            PatchCommand.self,
            DeleteCommand.self,
            RotateCommand.self,
            RecordsCommand.self,
        ]
    )

    struct ListCommand: AsyncParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "list", abstract: "List every destination.")

        @OptionGroup var options: GlobalOptions

        func run() async throws {
            try Output.emit(
                await options.adminClient().listDestinations(),
                pretty: options.pretty
            )
        }
    }

    struct GetCommand: AsyncParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "get", abstract: "Show one destination.")

        @OptionGroup var options: GlobalOptions
        @Argument(help: "Destination id.") var id: String

        func run() async throws {
            try Output.emit(
                await options.adminClient().getDestination(id: id),
                pretty: options.pretty
            )
        }
    }

    struct CreateCommand: AsyncParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "create", abstract: "Register a destination.")

        @OptionGroup var options: GlobalOptions

        @Option(name: .long, help: "Destination name.") var name: String
        @Option(name: .long, help: "Vendor addon name.") var vendorAddon: String
        @Option(name: .long, help: "Destination addon name.")
        var destinationAddon: String?
        @Option(name: .long, help: "Vendor addon config: inline JSON or @file.json.")
        var vendorConfig: String?
        @Option(
            name: .long,
            help: "Destination addon config: inline JSON or @file.json."
        )
        var destinationConfig: String?
        @Option(name: .long, help: "Per-destination retention override.")
        var retentionSeconds: Int?

        func run() async throws {
            let created = try await options.adminClient().createDestination(
                CreateDestinationInput(
                    name: name,
                    vendorAddon: vendorAddon,
                    destinationAddon: destinationAddon,
                    vendorConfig: try parseJSONArgument(
                        vendorConfig, flag: "vendor-config"),
                    destinationConfig: try parseJSONArgument(
                        destinationConfig, flag: "destination-config"),
                    retentionSeconds: retentionSeconds
                )
            )
            try Output.emit(created, pretty: options.pretty)
        }
    }

    struct PatchCommand: AsyncParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "patch", abstract: "Update a destination.")

        @OptionGroup var options: GlobalOptions
        @Argument(help: "Destination id.") var id: String

        @Option(name: .long) var name: String?
        @Option(
            name: .long,
            help: "true enables every public surface; false disables them."
        )
        var enabled: Bool?
        @Option(name: .long) var destinationAddon: String?
        @Option(name: .long, help: "Inline JSON or @file.json.")
        var vendorConfig: String?
        @Option(name: .long, help: "Inline JSON or @file.json.")
        var destinationConfig: String?
        @Option(name: .long) var retentionSeconds: Int?

        func run() async throws {
            // Only flags the user typed become fields: a patch must never reset
            // something the caller did not mention.
            let updated = try await options.adminClient().updateDestination(
                id: id,
                UpdateDestinationInput(
                    name: name,
                    enabled: enabled,
                    destinationAddon: destinationAddon,
                    vendorConfig: try parseJSONArgument(
                        vendorConfig, flag: "vendor-config"),
                    destinationConfig: try parseJSONArgument(
                        destinationConfig, flag: "destination-config"),
                    retentionSeconds: retentionSeconds
                )
            )
            try Output.emit(updated, pretty: options.pretty)
        }
    }

    struct DeleteCommand: AsyncParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "delete",
            abstract: "Delete a destination and every record stored for it."
        )

        @OptionGroup var options: GlobalOptions
        @Argument(help: "Destination id.") var id: String

        func run() async throws {
            try await options.adminClient().deleteDestination(id: id)
            try Output.emit(DeletedAck(deleted: id), pretty: options.pretty)
        }
    }

    struct RotateCommand: AsyncParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "rotate-fetch-uuid",
            abstract: "Issue a new fetch uuid, invalidating the old read and stream URLs."
        )

        @OptionGroup var options: GlobalOptions
        @Argument(help: "Destination id.") var id: String

        func run() async throws {
            try Output.emit(
                await options.adminClient().rotateFetchUUID(id: id),
                pretty: options.pretty
            )
        }
    }

    struct RecordsCommand: AsyncParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "records",
            abstract: "Read stored records without marking them as fetched."
        )

        @OptionGroup var options: GlobalOptions
        @Argument(help: "Destination id.") var id: String
        @Option(name: .long, help: "Maximum records to return.") var limit: Int?

        func run() async throws {
            try Output.emit(
                await options.adminClient().listDestinationRecords(
                    destinationID: id, limit: limit),
                pretty: options.pretty
            )
        }
    }
}
