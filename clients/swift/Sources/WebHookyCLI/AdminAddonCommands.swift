import ArgumentParser
import Foundation
import WebHooky

/// `webhooky admin addons ...`
struct AddonsCommand: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "addons",
        abstract: "Manage vendor and destination addons.",
        subcommands: [
            ListCommand.self, GetCommand.self, UploadCommand.self, DeleteCommand.self,
        ]
    )

    struct ListCommand: AsyncParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "list", abstract: "List registered addons.")

        @OptionGroup var options: GlobalOptions

        func run() async throws {
            try Output.emit(
                await options.adminClient().listAddons(), pretty: options.pretty)
        }
    }

    struct GetCommand: AsyncParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "get", abstract: "Show one addon.")

        @OptionGroup var options: GlobalOptions
        @Argument(help: "Addon name.") var name: String

        func run() async throws {
            try Output.emit(
                await options.adminClient().getAddon(name: name), pretty: options.pretty)
        }
    }

    struct UploadCommand: AsyncParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "upload",
            abstract: "Install an addon package (a zip archive with addon.json)."
        )

        @OptionGroup var options: GlobalOptions
        @Argument(help: "Path to the zip archive.") var path: String

        func run() async throws {
            let url = URL(fileURLWithPath: path)
            let archive: Data
            do {
                archive = try Data(contentsOf: url)
            } catch {
                throw CLIUsageError(
                    "failed to read \(path): \(error.localizedDescription)")
            }
            try Output.emit(
                await options.adminClient().uploadAddon(
                    fileName: url.lastPathComponent, archive: archive),
                pretty: options.pretty
            )
        }
    }

    struct DeleteCommand: AsyncParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "delete", abstract: "Remove an installed addon.")

        @OptionGroup var options: GlobalOptions
        @Argument(help: "Addon name.") var name: String

        func run() async throws {
            try await options.adminClient().deleteAddon(name: name)
            try Output.emit(DeletedAck(deleted: name), pretty: options.pretty)
        }
    }
}

/// `webhooky admin keys ...`
struct KeysCommand: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "keys",
        abstract: "Manage admin API keys.",
        subcommands: [ListCommand.self, CreateCommand.self, DeleteCommand.self]
    )

    struct ListCommand: AsyncParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "list", abstract: "List admin API keys.")

        @OptionGroup var options: GlobalOptions

        func run() async throws {
            try Output.emit(
                await options.adminClient().listAdminKeys(), pretty: options.pretty)
        }
    }

    struct CreateCommand: AsyncParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "create",
            abstract: "Mint an admin API key; the secret is shown exactly once."
        )

        @OptionGroup var options: GlobalOptions
        @Option(name: .long, help: "Human-readable label.") var label: String

        func run() async throws {
            try Output.emit(
                await options.adminClient().createAdminKey(label: label),
                pretty: options.pretty
            )
        }
    }

    struct DeleteCommand: AsyncParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "delete", abstract: "Revoke an admin API key.")

        @OptionGroup var options: GlobalOptions
        @Argument(help: "Admin key id.") var id: String

        func run() async throws {
            try await options.adminClient().deleteAdminKey(id: id)
            try Output.emit(DeletedAck(deleted: id), pretty: options.pretty)
        }
    }
}

/// `webhooky admin admin-users ...`
struct AdminUsersCommand: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "admin-users",
        abstract: "Manage identity-provider subjects allowed into the admin surface.",
        subcommands: [ListCommand.self, CreateCommand.self, DeleteCommand.self]
    )

    struct ListCommand: AsyncParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "list", abstract: "List admin subjects.")

        @OptionGroup var options: GlobalOptions

        func run() async throws {
            try Output.emit(
                await options.adminClient().listAdminUsers(), pretty: options.pretty)
        }
    }

    struct CreateCommand: AsyncParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "create", abstract: "Admit a subject.")

        @OptionGroup var options: GlobalOptions
        @Argument(help: "Identity-provider subject.") var subject: String

        func run() async throws {
            try Output.emit(
                await options.adminClient().createAdminUser(subject: subject),
                pretty: options.pretty
            )
        }
    }

    struct DeleteCommand: AsyncParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "delete", abstract: "Remove a subject.")

        @OptionGroup var options: GlobalOptions
        @Argument(help: "Identity-provider subject.") var subject: String

        func run() async throws {
            try await options.adminClient().deleteAdminUser(subject: subject)
            try Output.emit(DeletedAck(deleted: subject), pretty: options.pretty)
        }
    }
}
