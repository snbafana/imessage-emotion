// swift-tools-version: 5.9

import PackageDescription

let package = Package(
  name: "ContactsHelper",
  platforms: [.macOS(.v13)],
  products: [
    .executable(name: "imessage-emotion-native-helper", targets: ["ContactsHelper"])
  ],
  targets: [
    .executableTarget(name: "ContactsHelper")
  ]
)
