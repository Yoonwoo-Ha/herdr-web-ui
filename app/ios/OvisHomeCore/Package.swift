// swift-tools-version: 5.9
import PackageDescription

// Which screen the iOS app opens and what its hosted Connect a PC screen does while it is up (docs/native-app.md,
// The first screen): the decisions alone, which HerdrBridgeViewController carries out. `swift test` here on a Mac
// runs the tests; Home.java and HomeTest.java are the Android twins.
let package = Package(
    name: "OvisHomeCore",
    platforms: [.iOS(.v15), .macOS(.v12)],
    products: [.library(name: "OvisHomeCore", targets: ["OvisHomeCore"])],
    targets: [
        .target(name: "OvisHomeCore"),
        .testTarget(name: "OvisHomeCoreTests", dependencies: ["OvisHomeCore"])
    ]
)
