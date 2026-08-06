import Foundation

/// An arbitrary JSON value.
///
/// Webhook payloads and addon schemas are whatever the vendor sent, so they
/// cannot be modelled as a fixed Swift type. This preserves them losslessly and
/// gives typed accessors for the common shapes.
public enum AnyJSON: Codable, Equatable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([AnyJSON])
    case object([String: AnyJSON])

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([AnyJSON].self) {
            self = .array(value)
        } else if let value = try? container.decode([String: AnyJSON].self) {
            self = .object(value)
        } else {
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Value is not valid JSON"
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null:
            try container.encodeNil()
        case .bool(let value):
            try container.encode(value)
        case .number(let value):
            // Whole numbers round-trip as integers so a unix timestamp is not
            // re-rendered as 1.7234e9.
            if value.rounded() == value, value.magnitude < 9_007_199_254_740_992 {
                try container.encode(Int64(value))
            } else {
                try container.encode(value)
            }
        case .string(let value):
            try container.encode(value)
        case .array(let value):
            try container.encode(value)
        case .object(let value):
            try container.encode(value)
        }
    }

    // -- accessors -----------------------------------------------------------

    public var boolValue: Bool? {
        if case .bool(let value) = self { return value }
        return nil
    }

    public var doubleValue: Double? {
        if case .number(let value) = self { return value }
        return nil
    }

    public var intValue: Int? {
        if case .number(let value) = self { return Int(value) }
        return nil
    }

    public var stringValue: String? {
        if case .string(let value) = self { return value }
        return nil
    }

    public var arrayValue: [AnyJSON]? {
        if case .array(let value) = self { return value }
        return nil
    }

    public var objectValue: [String: AnyJSON]? {
        if case .object(let value) = self { return value }
        return nil
    }

    public subscript(key: String) -> AnyJSON? {
        objectValue?[key]
    }

    /// The value re-encoded as JSON bytes.
    public var rawData: Data? {
        try? JSONEncoder().encode(self)
    }

    /// Builds a value from a Swift dictionary of JSON-compatible values.
    ///
    /// Anything the mapping cannot represent - a date, a custom struct -
    /// becomes its `String(describing:)` form rather than being dropped, so a
    /// caller never silently loses a configuration field.
    public static func from(_ value: Any) -> AnyJSON {
        switch value {
        case is NSNull:
            return .null
        case let value as Bool:
            return .bool(value)
        case let value as Int:
            return .number(Double(value))
        case let value as Double:
            return .number(value)
        case let value as String:
            return .string(value)
        case let value as [Any]:
            return .array(value.map(AnyJSON.from))
        case let value as [String: Any]:
            return .object(value.mapValues(AnyJSON.from))
        case let value as AnyJSON:
            return value
        default:
            return .string(String(describing: value))
        }
    }
}
