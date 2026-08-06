import Foundation

/// One stored webhook payload, as the fetch surfaces return it.
public struct WebhookRecord: Codable, Equatable, Sendable {
    /// Receipt time in unix seconds.
    public let t: Int
    /// The flag's value *before* the reading call marked it, so a consumer can
    /// tell which records it is seeing for the first time.
    public let fetched: Bool
    public let payload: AnyJSON

    public init(t: Int, fetched: Bool, payload: AnyJSON) {
        self.t = t
        self.fetched = fetched
        self.payload = payload
    }
}

/// The admin projection of a configured webhook endpoint.
///
/// `fetchUuid` is returned by the admin API only: it is the secret half of the
/// read and stream URLs.
public struct Destination: Codable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let vendorAddon: String
    public let destinationAddon: String?
    public let inboundUuid: String
    public let inboundPath: String
    public let fetchUuid: String
    public let fetchPath: String
    public let streamPath: String
    public let vendorConfig: AnyJSON?
    public let destinationConfig: AnyJSON?
    public let retentionSeconds: Int?
    public let enabled: Bool
    public let createdAt: Int
    public let createdBy: String?
}

/// The body of `POST /_admin/api/destinations`.
public struct CreateDestinationInput: Codable, Sendable {
    public var name: String
    public var vendorAddon: String
    public var destinationAddon: String?
    public var vendorConfig: AnyJSON?
    public var destinationConfig: AnyJSON?
    public var retentionSeconds: Int?

    public init(
        name: String,
        vendorAddon: String,
        destinationAddon: String? = nil,
        vendorConfig: AnyJSON? = nil,
        destinationConfig: AnyJSON? = nil,
        retentionSeconds: Int? = nil
    ) {
        self.name = name
        self.vendorAddon = vendorAddon
        self.destinationAddon = destinationAddon
        self.vendorConfig = vendorConfig
        self.destinationConfig = destinationConfig
        self.retentionSeconds = retentionSeconds
    }
}

/// A partial destination update.
///
/// A `nil` field is omitted from the request entirely, because the server
/// distinguishes an absent field (keep the current value) from an explicit null
/// (clear it).
public struct UpdateDestinationInput: Codable, Sendable {
    public var name: String?
    public var enabled: Bool?
    public var destinationAddon: String?
    public var vendorConfig: AnyJSON?
    public var destinationConfig: AnyJSON?
    public var retentionSeconds: Int?

    public init(
        name: String? = nil,
        enabled: Bool? = nil,
        destinationAddon: String? = nil,
        vendorConfig: AnyJSON? = nil,
        destinationConfig: AnyJSON? = nil,
        retentionSeconds: Int? = nil
    ) {
        self.name = name
        self.enabled = enabled
        self.destinationAddon = destinationAddon
        self.vendorConfig = vendorConfig
        self.destinationConfig = destinationConfig
        self.retentionSeconds = retentionSeconds
    }
}

/// A fetch-capable API key and the destinations it may read.
public struct ApiUser: Codable, Equatable, Sendable {
    public let id: String
    public let label: String
    public let enabled: Bool
    public let createdAt: Int
    public let grants: [String]
}

/// An API user plus the secret the server returns exactly once.
///
/// A distinct type on purpose: a listing can never be mistaken for something
/// that carries a secret.
public struct CreatedApiUser: Codable, Equatable, Sendable {
    public let id: String
    public let label: String
    public let enabled: Bool
    public let createdAt: Int
    public let grants: [String]
    public let secret: String
    public let credential: String
}

/// Delivery counts per status for one relay.
public struct RelayDeliveryStats: Codable, Equatable, Sendable {
    public let pending: Int
    public let delivered: Int
    public let failed: Int
}

/// A forwarding target attached to a destination.
///
/// The signing secret is never returned; `hasSecret` reports only whether one
/// is configured.
public struct Relay: Codable, Equatable, Sendable {
    public let id: String
    public let destinationId: String
    public let name: String
    public let targetUrl: String
    public let hasSecret: Bool
    public let enabled: Bool
    public let maxAttempts: Int
    public let backoffSeconds: Int
    public let timeoutSeconds: Int
    public let createdAt: Int
    public let createdBy: String?
    public let deliveryStats: RelayDeliveryStats?
}

/// The body of `POST /_admin/api/relays`.
public struct CreateRelayInput: Codable, Sendable {
    public var destinationId: String
    public var name: String
    public var targetUrl: String
    public var secret: String?
    public var enabled: Bool?
    public var maxAttempts: Int?
    public var backoffSeconds: Int?
    public var timeoutSeconds: Int?

    public init(
        destinationId: String,
        name: String,
        targetUrl: String,
        secret: String? = nil,
        enabled: Bool? = nil,
        maxAttempts: Int? = nil,
        backoffSeconds: Int? = nil,
        timeoutSeconds: Int? = nil
    ) {
        self.destinationId = destinationId
        self.name = name
        self.targetUrl = targetUrl
        self.secret = secret
        self.enabled = enabled
        self.maxAttempts = maxAttempts
        self.backoffSeconds = backoffSeconds
        self.timeoutSeconds = timeoutSeconds
    }
}

/// A partial relay update.
public struct UpdateRelayInput: Codable, Sendable {
    public var name: String?
    public var targetUrl: String?
    public var secret: String?
    public var enabled: Bool?
    public var maxAttempts: Int?
    public var backoffSeconds: Int?
    public var timeoutSeconds: Int?

    public init(
        name: String? = nil,
        targetUrl: String? = nil,
        secret: String? = nil,
        enabled: Bool? = nil,
        maxAttempts: Int? = nil,
        backoffSeconds: Int? = nil,
        timeoutSeconds: Int? = nil
    ) {
        self.name = name
        self.targetUrl = targetUrl
        self.secret = secret
        self.enabled = enabled
        self.maxAttempts = maxAttempts
        self.backoffSeconds = backoffSeconds
        self.timeoutSeconds = timeoutSeconds
    }
}

/// One queued delivery of one record to one relay.
public struct RelayDelivery: Codable, Equatable, Sendable {
    public let id: String
    public let relayId: String
    public let recordId: String
    public let t: Int
    public let status: String
    public let attempts: Int
    public let nextAttemptAt: Int
    public let lastStatusCode: Int?
    public let lastError: String?
    public let createdAt: Int
    public let updatedAt: Int
    public let deliveredAt: Int?
}

/// A page of deliveries plus the relay's totals.
public struct RelayDeliveryPage: Codable, Equatable, Sendable {
    public let deliveries: [RelayDelivery]
    public let stats: RelayDeliveryStats
}

/// A registered vendor or destination addon.
public struct Addon: Codable, Equatable, Sendable {
    public let name: String
    public let version: String
    public let kind: String
    public let description: String
    public let source: String
    public let acceptsSchema: AnyJSON?
    public let returnsSchema: AnyJSON?
    public let configSchema: AnyJSON?
    public let hasAuthenticate: Bool
    public let hasTransform: Bool
}

/// An admin-privileged API key.
public struct AdminKey: Codable, Equatable, Sendable {
    public let id: String
    public let label: String
    public let enabled: Bool
    public let createdAt: Int
}

/// An admin key plus the secret the server returns exactly once.
public struct CreatedAdminKey: Codable, Equatable, Sendable {
    public let id: String
    public let label: String
    public let enabled: Bool
    public let createdAt: Int
    public let secret: String
    public let credential: String
}

/// An identity-provider subject allowed into the admin surface.
public struct AdminUser: Codable, Equatable, Sendable {
    public let subject: String
    public let role: String
    public let createdAt: Int
}

/// The identity the server resolved for the caller's credentials.
public struct AdminIdentity: Codable, Equatable, Sendable {
    public let subject: String
    public let viaApiKey: Bool
    public let keyId: String?
    public let adminAuthProvider: String
}

/// Filters for `GET /_get/{fetchUuid}`.
///
/// The default value asks for the server's own defaults: every record, newest
/// first, marked as fetched by this call.
public struct RecordQuery: Sendable {
    /// Return only records no reader has taken yet.
    public var onlyUnfetched: Bool
    /// Mark the returned records as fetched, matching the server's default.
    public var markFetched: Bool
    /// Lower time bound: unix seconds or an ISO-8601 string.
    public var from: TimeBound?
    /// Upper time bound.
    public var to: TimeBound?
    /// Maximum records; the server clamps anything above its ceiling.
    public var limit: Int?

    public init(
        onlyUnfetched: Bool = false,
        markFetched: Bool = true,
        from: TimeBound? = nil,
        to: TimeBound? = nil,
        limit: Int? = nil
    ) {
        self.onlyUnfetched = onlyUnfetched
        self.markFetched = markFetched
        self.from = from
        self.to = to
        self.limit = limit
    }
}

/// A `from`/`to` bound, in either form the server accepts.
public enum TimeBound: Sendable {
    case seconds(Int)
    case date(Date)
    /// An ISO-8601 string, passed through for the server to parse.
    case iso8601(String)

    var queryValue: String {
        switch self {
        case .seconds(let value):
            return String(value)
        case .date(let value):
            return String(Int(value.timeIntervalSince1970))
        case .iso8601(let value):
            return value
        }
    }
}

/// Envelope wrappers the list endpoints return.
struct RecordsEnvelope: Decodable {
    let records: [WebhookRecord]
}

struct DestinationsEnvelope: Decodable {
    let destinations: [Destination]
}

struct RelaysEnvelope: Decodable {
    let relays: [Relay]
}

struct ApiUsersEnvelope: Decodable {
    let users: [ApiUser]
}

struct AddonsEnvelope: Decodable {
    let addons: [Addon]
}

struct AdminKeysEnvelope: Decodable {
    let keys: [AdminKey]
}

struct AdminUsersEnvelope: Decodable {
    let adminUsers: [AdminUser]
}

struct RequeuedEnvelope: Decodable {
    let requeued: Int
}
