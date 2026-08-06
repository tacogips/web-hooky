// swift-tools-version: 5.9
// Root manifest so Swift Package Manager consumers can depend on this
// repository directly. It exposes the same `WebHooky` library that lives in
// `clients/swift`; the CLI executable stays in the nested package because an
// SPM dependency needs only the library product.
import PackageDescription

let package = Package(
    name: "web-hooky",
    platforms: [
        .macOS(.v13),
        .iOS(.v16),
        .tvOS(.v16),
        .watchOS(.v9),
    ],
    products: [
        .library(name: "WebHooky", targets: ["WebHooky"])
    ],
    targets: [
        .target(
            name: "WebHooky",
            path: "clients/swift/Sources/WebHooky"
        ),
        .testTarget(
            name: "WebHookyRootTests",
            dependencies: ["WebHooky"],
            path: "clients/swift/Tests/WebHookyTests"
        ),
    ]
)
