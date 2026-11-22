// swift-tools-version: 5.9
import PackageDescription

// PCs added over SSH in the iOS app (docs/native-app.md, PCs over SSH): the SSH client (SwiftNIO SSH, Apache-2.0,
// whose cryptography is CryptoKit on Apple platforms), the key store, and the loopback tunnel the WebView loads
// the PC through. The app's own pieces (Keychain, the setup screen, the plugin) are in App/App/OvisSsh*.swift.
// `swift test` here on a Mac runs the tests, over the same ssh-test-keys files as the Android app's.
let package = Package(
    name: "OvisSshCore",
    platforms: [.iOS(.v15), .macOS(.v12)],
    products: [.library(name: "OvisSshCore", targets: ["OvisSshCore"])],
    dependencies: [
        .package(url: "https://github.com/apple/swift-nio.git", from: "2.81.0"),
        .package(url: "https://github.com/apple/swift-nio-ssh.git", from: "0.12.0")
    ],
    targets: [
        .target(name: "OvisSshCore", dependencies: [
            .product(name: "NIOCore", package: "swift-nio"),
            .product(name: "NIOPosix", package: "swift-nio"),
            .product(name: "NIOSSH", package: "swift-nio-ssh")
        ]),
        .testTarget(name: "OvisSshCoreTests", dependencies: [
            "OvisSshCore",
            .product(name: "NIOCore", package: "swift-nio"),
            .product(name: "NIOPosix", package: "swift-nio")
        ])
    ]
)
