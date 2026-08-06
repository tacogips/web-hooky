import Foundation

/// The client version, reported in the default `User-Agent`.
public let webHookyClientVersion = "0.1.0"

public let webHookyDefaultTimeout: TimeInterval = 30
public let webHookyDefaultUserAgent = "webhooky-swift/\(webHookyClientVersion)"

/// The http and ws forms of one server base URL.
public struct BaseURLs: Equatable, Sendable {
    public let http: String
    public let ws: String
}

/// Configuration for a fetch client.
///
/// Nothing in this library reads the process environment: credentials, base
/// URL, timeouts and extra headers are passed here explicitly, so one process
/// can hold several clients with different identities. Only the bundled CLI
/// consults `WEBHOOKY_*` variables.
public struct FetchClientConfig: Sendable {
    /// Server root, for example `https://hooks.example.com`. `ws://` is
    /// accepted and mapped to its http equivalent.
    public var baseURL: String
    /// Fetch API user key id.
    public var apiKey: String
    /// Fetch API user secret.
    public var apiSecret: String
    /// Per-request timeout. A stream is long-lived and is not bounded by it.
    public var timeout: TimeInterval
    /// Extra request headers, for an identity-provider header or proxy secret.
    public var headers: [String: String]
    public var userAgent: String

    public init(
        baseURL: String,
        apiKey: String,
        apiSecret: String,
        timeout: TimeInterval = webHookyDefaultTimeout,
        headers: [String: String] = [:],
        userAgent: String = webHookyDefaultUserAgent
    ) {
        self.baseURL = baseURL
        self.apiKey = apiKey
        self.apiSecret = apiSecret
        self.timeout = timeout
        self.headers = headers
        self.userAgent = userAgent
    }
}

/// Configuration for an admin client.
public struct AdminClientConfig: Sendable {
    public var baseURL: String
    /// `"<keyId>:<secret>"` for an admin API key.
    ///
    /// May be empty when the deployment authenticates through an
    /// identity-provider proxy and ``headers`` carry the identity.
    public var credential: String
    public var timeout: TimeInterval
    public var headers: [String: String]
    public var userAgent: String

    public init(
        baseURL: String,
        credential: String = "",
        timeout: TimeInterval = webHookyDefaultTimeout,
        headers: [String: String] = [:],
        userAgent: String = webHookyDefaultUserAgent
    ) {
        self.baseURL = baseURL
        self.credential = credential
        self.timeout = timeout
        self.headers = headers
        self.userAgent = userAgent
    }
}

/// A validated configuration, shared by both client types.
public struct ResolvedConfig: Sendable {
    public let urls: BaseURLs
    public let authorization: String
    public let headers: [String: String]
    public let timeout: TimeInterval
    public let userAgent: String
}

/// Parses a base URL into its http and ws forms.
///
/// A `ws://` base URL is accepted and mapped to `http://`; handling both here
/// saves every caller from remembering which scheme a given surface wants.
public func normalizeBaseURL(_ raw: String) throws -> BaseURLs {
    var trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    while trimmed.hasSuffix("/") {
        trimmed.removeLast()
    }
    guard trimmed.isEmpty == false else {
        throw WebhookyError(message: "baseURL is required")
    }
    guard
        var components = URLComponents(string: trimmed),
        let host = components.host, host.isEmpty == false
    else {
        throw WebhookyError(message: "baseURL \"\(raw)\" is not a valid URL")
    }

    let schemes: (http: String, ws: String)
    switch components.scheme?.lowercased() {
    case "http", "ws":
        schemes = ("http", "ws")
    case "https", "wss":
        schemes = ("https", "wss")
    default:
        throw WebhookyError(
            message:
                "baseURL scheme \"\(components.scheme ?? "")\" must be http, https, ws or wss"
        )
    }

    while components.path.hasSuffix("/") {
        components.path.removeLast()
    }
    let authority = components.port.map { "\(host):\($0)" } ?? host
    return BaseURLs(
        http: "\(schemes.http)://\(authority)\(components.path)",
        ws: "\(schemes.ws)://\(authority)\(components.path)"
    )
}

/// Splits `"<keyId>:<secret>"` into its two halves.
public func splitCredential(_ credential: String) throws -> (
    keyID: String, secret: String
) {
    let trimmed = credential.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let separator = trimmed.firstIndex(of: ":"),
        separator != trimmed.startIndex,
        trimmed.index(after: separator) != trimmed.endIndex
    else {
        throw WebhookyError(message: "credential must be \"<keyId>:<secret>\"")
    }
    return (
        String(trimmed[trimmed.startIndex..<separator]),
        String(trimmed[trimmed.index(after: separator)...])
    )
}

extension ResolvedConfig {
    /// Validates and normalizes a fetch client configuration.
    static func forFetch(_ config: FetchClientConfig) throws -> ResolvedConfig {
        let key = config.apiKey.trimmingCharacters(in: .whitespaces)
        guard key.isEmpty == false, config.apiSecret.isEmpty == false else {
            throw WebhookyError(message: "apiKey and apiSecret are required")
        }
        return ResolvedConfig(
            urls: try normalizeBaseURL(config.baseURL),
            authorization: "Bearer \(key):\(config.apiSecret)",
            headers: config.headers,
            timeout: config.timeout > 0 ? config.timeout : webHookyDefaultTimeout,
            userAgent: config.userAgent.isEmpty
                ? webHookyDefaultUserAgent : config.userAgent
        )
    }

    /// Validates and normalizes an admin client configuration.
    ///
    /// All three of a credential, and no credential with identity headers, are
    /// valid: a deployment fronted by an identity-provider proxy authenticates
    /// through headers instead.
    static func forAdmin(_ config: AdminClientConfig) throws -> ResolvedConfig {
        let credential = config.credential.trimmingCharacters(in: .whitespaces)
        var authorization = ""
        if credential.isEmpty == false {
            // Validates the shape; a malformed credential should fail here
            // rather than as a puzzling 401 later.
            _ = try splitCredential(credential)
            authorization = "Bearer \(credential)"
        } else if config.headers.isEmpty {
            throw WebhookyError(
                message:
                    "admin credentials are required: pass credential: \"<keyId>:<secret>\", "
                    + "or headers for an identity-provider deployment"
            )
        }
        return ResolvedConfig(
            urls: try normalizeBaseURL(config.baseURL),
            authorization: authorization,
            headers: config.headers,
            timeout: config.timeout > 0 ? config.timeout : webHookyDefaultTimeout,
            userAgent: config.userAgent.isEmpty
                ? webHookyDefaultUserAgent : config.userAgent
        )
    }

    /// Builds the header set for one request.
    ///
    /// Caller-supplied headers never override the ones the client owns: an
    /// `Authorization` header passed through ``headers`` would silently defeat
    /// the credentials the caller gave explicitly.
    func requestHeaders(contentType: String?) -> [String: String] {
        var result = headers
        result["accept"] = "application/json"
        result["user-agent"] = userAgent
        if authorization.isEmpty == false {
            result["authorization"] = authorization
        }
        if let contentType {
            result["content-type"] = contentType
        }
        return result
    }
}
