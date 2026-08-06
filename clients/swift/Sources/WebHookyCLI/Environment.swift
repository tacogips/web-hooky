import ArgumentParser
import Foundation
import WebHooky

/// Environment variables the CLI reads.
///
/// This file is the only place in the client that touches the environment; the
/// library takes its configuration as explicit parameters, so an embedding
/// application decides where credentials come from.
enum Env {
    static let url = "WEBHOOKY_URL"
    static let apiKey = "WEBHOOKY_API_KEY"
    static let apiSecret = "WEBHOOKY_API_SECRET"
    static let credential = "WEBHOOKY_CREDENTIAL"
    static let fetchUUID = "WEBHOOKY_FETCH_UUID"
    static let adminCredential = "WEBHOOKY_ADMIN_CREDENTIAL"
    static let adminKey = "WEBHOOKY_ADMIN_KEY"
    static let adminSecret = "WEBHOOKY_ADMIN_SECRET"
    static let timeout = "WEBHOOKY_TIMEOUT_SECONDS"
    static let headers = "WEBHOOKY_HEADERS"

    static let defaultBaseURL = "http://127.0.0.1:8787"
    static let userAgent = "webhooky-swift-cli/\(webHookyClientVersion)"

    /// Reads a variable, treating an empty value as unset.
    static func read(_ name: String) -> String {
        let value = ProcessInfo.processInfo.environment[name] ?? ""
        return value.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

/// The command was invoked incorrectly; the process exits with code 2.
struct CLIUsageError: Error, CustomStringConvertible {
    let description: String
    init(_ message: String) {
        self.description = message
    }
}

/// The flags every command accepts.
///
/// Declared as an `OptionGroup` on each subcommand so both
/// `webhooky --pretty records get` and `webhooky records get --pretty` work;
/// users should not have to remember which side of the verb a flag lives on.
struct GlobalOptions: ParsableArguments {
    @Option(name: .long, help: "Server base URL (\(Env.url)).")
    var url: String?

    @Option(name: .long, help: "Request timeout in seconds (\(Env.timeout)).")
    var timeout: Double?

    @Option(
        name: .long,
        help: "Extra request header \"name=value\"; repeatable (\(Env.headers))."
    )
    var header: [String] = []

    @Flag(name: .long, help: "Indent JSON output.")
    var pretty = false
}

extension GlobalOptions {
    /// Splits `name=value`.
    ///
    /// Only the first separator is significant: a value can itself contain
    /// `=`, as a base64 proxy secret does.
    private static func splitHeader(_ entry: String) throws -> (String, String) {
        guard let separator = entry.firstIndex(of: "="),
            separator != entry.startIndex
        else {
            throw CLIUsageError("invalid header \"\(entry)\": expected \"name=value\"")
        }
        let name = String(entry[entry.startIndex..<separator])
            .trimmingCharacters(in: .whitespaces)
        let value = String(entry[entry.index(after: separator)...])
            .trimmingCharacters(in: .whitespaces)
        return (name, value)
    }

    /// Merges `WEBHOOKY_HEADERS` with repeated `--header` flags; flags win.
    func resolvedHeaders() throws -> [String: String] {
        var headers: [String: String] = [:]
        for entry in Env.read(Env.headers).split(separator: ",") {
            let trimmed = String(entry).trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty { continue }
            let (name, value) = try Self.splitHeader(trimmed)
            headers[name] = value
        }
        for entry in header {
            let (name, value) = try Self.splitHeader(entry)
            headers[name] = value
        }
        return headers
    }

    func resolvedBaseURL() -> String {
        if let url, url.isEmpty == false { return url }
        let fromEnv = Env.read(Env.url)
        return fromEnv.isEmpty ? Env.defaultBaseURL : fromEnv
    }

    func resolvedTimeout() throws -> TimeInterval {
        if let timeout {
            guard timeout > 0 else {
                throw CLIUsageError("--timeout must be a positive number of seconds")
            }
            return timeout
        }
        let raw = Env.read(Env.timeout)
        if raw.isEmpty { return webHookyDefaultTimeout }
        guard let seconds = Double(raw), seconds > 0 else {
            throw CLIUsageError("\(Env.timeout) must be a positive number of seconds")
        }
        return seconds
    }

    /// Builds a read/stream client from flags and the environment.
    func fetchClient() throws -> WebHookyFetchClient {
        var key = Env.read(Env.apiKey)
        var secret = Env.read(Env.apiSecret)

        if key.isEmpty, secret.isEmpty {
            // The combined form is what the admin API hands out when a fetch
            // API user is created, so it is accepted verbatim.
            let combined = Env.read(Env.credential)
            if combined.isEmpty == false {
                guard let pair = try? splitCredential(combined) else {
                    throw CLIUsageError("\(Env.credential) must be \"<keyId>:<secret>\"")
                }
                key = pair.keyID
                secret = pair.secret
            }
        }
        guard key.isEmpty == false, secret.isEmpty == false else {
            throw CLIUsageError(
                "missing fetch credentials: set \(Env.apiKey) and \(Env.apiSecret), "
                    + "or \(Env.credential)=\"<keyId>:<secret>\""
            )
        }

        return try WebHookyFetchClient(
            config: FetchClientConfig(
                baseURL: resolvedBaseURL(),
                apiKey: key,
                apiSecret: secret,
                timeout: try resolvedTimeout(),
                headers: try resolvedHeaders(),
                userAgent: Env.userAgent
            )
        )
    }

    /// Builds an admin client from flags and the environment.
    ///
    /// The credential may be absent: a deployment fronted by an
    /// identity-provider proxy authenticates through headers, which `--header`
    /// supplies.
    func adminClient() throws -> WebHookyAdminClient {
        let headers = try resolvedHeaders()
        var credential = Env.read(Env.adminCredential)
        if credential.isEmpty {
            let keyID = Env.read(Env.adminKey)
            let secret = Env.read(Env.adminSecret)
            if keyID.isEmpty == false, secret.isEmpty == false {
                credential = "\(keyID):\(secret)"
            }
        }
        guard credential.isEmpty == false || headers.isEmpty == false else {
            throw CLIUsageError(
                "missing admin credentials: set \(Env.adminCredential)=\"<keyId>:<secret>\" "
                    + "(or \(Env.adminKey) and \(Env.adminSecret)), or pass "
                    + "identity-provider headers with --header"
            )
        }

        return try WebHookyAdminClient(
            config: AdminClientConfig(
                baseURL: resolvedBaseURL(),
                credential: credential,
                timeout: try resolvedTimeout(),
                headers: headers,
                userAgent: Env.userAgent
            )
        )
    }
}

/// Resolves the destination from `--fetch-uuid` or the environment.
func resolveFetchUUID(_ flagValue: String?) throws -> String {
    if let flagValue, flagValue.isEmpty == false { return flagValue }
    let fromEnv = Env.read(Env.fetchUUID)
    guard fromEnv.isEmpty == false else {
        throw CLIUsageError(
            "missing destination: pass --fetch-uuid or set \(Env.fetchUUID)"
        )
    }
    return fromEnv
}
