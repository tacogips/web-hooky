// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "WebHooky",
    platforms: [
        .macOS(.v13),
        .iOS(.v16),
        .tvOS(.v16),
        .watchOS(.v9),
    ],
    products: [
        // The library, for embedding in an application.
        .library(name: "WebHooky", targets: ["WebHooky"]),
        // The `webhooky` command line interface.
        .executable(name: "webhooky", targets: ["WebHookyCLI"]),
    ],
    dependencies: [
        .package(
            url: "https://github.com/apple/swift-argument-parser.git",
            from: "1.3.0"
        )
    ],
    targets: [
        .target(name: "WebHooky"),
        .executableTarget(
            name: "WebHookyCLI",
            dependencies: [
                "WebHooky",
                .product(name: "ArgumentParser", package: "swift-argument-parser"),
            ]
        ),
        .testTarget(name: "WebHookyTests", dependencies: ["WebHooky"]),
    ]
)
