import ArgumentParser
import Foundation
import WebHooky

/// The `webhooky` command line interface.
///
/// Every capability offered here is one call into the `WebHooky` library, so
/// anything scriptable at the command line is equally available to a Swift
/// program. Output is JSON on stdout; diagnostics go to stderr.
struct Webhooky: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "webhooky",
        abstract: "Client for a web-hooky server. Output is JSON on stdout.",
        discussion: """
            Environment:
              WEBHOOKY_URL                 server base URL (default http://127.0.0.1:8787)
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
            """,
        version: Env.userAgent,
        subcommands: [RecordsCommand.self, AdminCommand.self]
    )
}

/// Exit codes. Usage problems are distinguished from server failures so a shell
/// script can tell "I called it wrong" from "the call was refused".
private let exitOK: Int32 = 0
private let exitFailure: Int32 = 1
private let exitUsage: Int32 = 2

@main
enum Entrypoint {
    static func main() async {
        do {
            var command = try Webhooky.parseAsRoot()
            if var asyncCommand = command as? AsyncParsableCommand {
                try await asyncCommand.run()
            } else {
                try command.run()
            }
        } catch let error as CLIUsageError {
            Output.note("webhooky: \(error.description)")
            Output.note("Run \"webhooky --help\" for usage.")
            exit(exitUsage)
        } catch let error as WebhookyError {
            // The failure is emitted as JSON so a script can branch on the
            // status and kind without parsing prose.
            let payload =
                "{\"error\":{\"status\":\(error.status),"
                + "\"kind\":\(quoted(error.kind)),"
                + "\"message\":\(quoted(error.message))}}"
            Output.note(payload)
            exit(exitFailure)
        } catch is CancellationError {
            // Ctrl-C during a stream is a normal way to stop.
            exit(exitOK)
        } catch {
            // ArgumentParser's own errors: --help and --version resolve to a
            // success exit code and belong on stdout; everything else is a
            // usage problem, which this CLI reports as 2 rather than the
            // library's default 64.
            let message = Webhooky.fullMessage(for: error)
            if Webhooky.exitCode(for: error) == .success {
                print(message)
                exit(exitOK)
            }
            Output.note(message)
            exit(exitUsage)
        }
        exit(exitOK)
    }

    /// JSON-quotes a string for the hand-built error payload.
    private static func quoted(_ value: String) -> String {
        let data = try? JSONEncoder().encode(value)
        guard let data else { return "\"\"" }
        return String(decoding: data, as: UTF8.self)
    }
}
