// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "ProsperoShell",
  platforms: [.macOS(.v14)],
  targets: [
    .executableTarget(
      name: "ProsperoShell",
      path: "Sources/ProsperoShell",
      swiftSettings: [.swiftLanguageMode(.v6)]
    ),
    .testTarget(
      name: "ProsperoShellTests",
      dependencies: ["ProsperoShell"],
      path: "Tests/ProsperoShellTests",
      swiftSettings: [.swiftLanguageMode(.v6)]
    )
  ]
)
