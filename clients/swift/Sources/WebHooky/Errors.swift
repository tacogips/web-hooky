import Foundation

/// Error kinds the server emits, mirroring `src/core/errors.ts`.
public enum WebhookyErrorKind: String, Sendable {
    case badRequest = "bad_request"
    case unauthorized = "unauthorized"
    case forbidden = "forbidden"
    case notFound = "not_found"
    case methodNotAllowed = "method_not_allowed"
    case conflict = "conflict"
    case payloadTooLarge = "payload_too_large"
    case unprocessableEntity = "unprocessable_entity"
    case notImplemented = "not_implemented"
    case internalError = "internal"
}

/// A failed call against a web-hooky server.
///
/// A `status` of `0` with an empty `kind` means the request never reached the
/// server, which is how a caller tells a transport failure from a refusal.
public struct WebhookyError: Error, CustomStringConvertible, Sendable {
    /// HTTP status code, or `0` for a transport or protocol failure.
    public let status: Int
    /// The server's error kind, or an empty string when the body carried none.
    public let kind: String
    public let message: String
    /// Machine-readable detail the server attached, as raw JSON.
    public let details: Data?

    public init(
        message: String,
        status: Int = 0,
        kind: String = "",
        details: Data? = nil
    ) {
        self.message = message
        self.status = status
        self.kind = kind
        self.details = details
    }

    public var description: String {
        var text = ""
        if status > 0 {
            text += "\(status) "
        }
        if kind.isEmpty == false {
            text += "(\(kind)) "
        }
        return text + message
    }

    /// The typed form of ``kind``, when the server sent one this client knows.
    public var errorKind: WebhookyErrorKind? {
        WebhookyErrorKind(rawValue: kind)
    }

    public var isNotFound: Bool { errorKind == .notFound }
    public var isUnauthorized: Bool { errorKind == .unauthorized }
    public var isForbidden: Bool { errorKind == .forbidden }

    /// How much of a failure body is kept in a message.
    private static let maxSnippet = 200

    /// Builds an error from a non-2xx response body.
    ///
    /// A body that is not the server's `{"error": {...}}` envelope - a proxy's
    /// HTML page, an empty 502 - still has to produce something actionable, so
    /// the status becomes the message in that case.
    public static func fromResponse(status: Int, body: Data) -> WebhookyError {
        if let envelope = try? JSONDecoder().decode(ErrorEnvelope.self, from: body),
            envelope.error.message.isEmpty == false
        {
            return WebhookyError(
                message: envelope.error.message,
                status: status,
                kind: envelope.error.kind ?? "",
                details: envelope.error.details?.rawData
            )
        }

        let text = String(decoding: body, as: UTF8.self)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty {
            return WebhookyError(
                message: "request failed with status \(status)",
                status: status
            )
        }
        let snippet =
            text.count > maxSnippet
            ? String(text.prefix(maxSnippet)) + "..."
            : text
        return WebhookyError(
            message: "request failed with status \(status): \(snippet)",
            status: status
        )
    }
}

/// The server's failure body.
struct ErrorEnvelope: Decodable {
    struct Body: Decodable {
        let kind: String?
        let message: String
        let details: AnyJSON?
    }
    let error: Body
}
