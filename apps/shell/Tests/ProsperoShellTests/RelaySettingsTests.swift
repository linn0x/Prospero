@testable import ProsperoShell
import XCTest

final class RelaySettingsTests: XCTestCase {
  func testParserCombinesConfigAndRuntimeWithoutRetainingSecrets() throws {
    let secret = "host_secret_should_never_reach_the_shell"
    let token = "device_token_should_never_reach_the_shell"
    let result = RelayStatus.parse(
      config: [
        "relay": [
          "enabled": true,
          "url": "wss://override.example.test/v1",
          "hostSecret": secret,
        ],
      ],
      runtime: [
        "relay": [
          "state": "connected",
          "effectiveUrl": "wss://override.example.test/v1",
          "defaultUrl": "wss://published.example.test/v1",
          "lastConnectedAt": 1_786_693_000_000,
          "deviceToken": token,
        ],
      ]
    )

    XCTAssertEqual(result?.enabled, true)
    XCTAssertEqual(result?.configuredURL, "wss://override.example.test/v1")
    XCTAssertEqual(result?.publishedDefaultURL, "wss://published.example.test/v1")
    XCTAssertEqual(result?.connectionState, .connected)
    XCTAssertFalse(String(reflecting: result).contains(secret))
    XCTAssertFalse(String(reflecting: result).contains(token))
  }

  func testParserSupportsMissingRelayFieldsForOlderDaemon() {
    XCTAssertNil(RelayStatus.parse(config: ["port": 7423], runtime: ["pid": 123]))
    XCTAssertEqual(
      RelayStatus.parse(
        config: ["relay": ["enabled": true]],
        runtime: nil
      )?.connectionState,
      .offline
    )
  }

  func testCLIStatusSupportsWrappedAndUnwrappedShapes() {
    let wrapped = """
    {"relay":{"enabled":true,"state":"connecting","defaultUrl":"wss://relay.example.test/v1","retryAfterMs":1250}}
    """
    let unwrapped = """
    {"enabled":true,"state":"error","effectiveUrl":"wss://relay.example.test/v1","lastError":"route unavailable","retryAfterMs":60000}
    """

    XCTAssertEqual(RelayStatus.parseCLIStatus(wrapped)?.connectionState, .connecting)
    XCTAssertEqual(RelayStatus.parseCLIStatus(wrapped)?.retryHint, "将在约 2 秒后重试")
    XCTAssertEqual(RelayStatus.parseCLIStatus(unwrapped)?.connectionState, .error)
    XCTAssertEqual(RelayStatus.parseCLIStatus(unwrapped)?.retryHint, "将在约 1 分钟后重试")
  }

  func testURLPolicyMatchesDaemonContract() {
    XCTAssertEqual(
      RelayURLValidator.validate("wss://relay.example.test/v1", allowInsecureLoopback: false),
      .success("wss://relay.example.test/v1")
    )
    XCTAssertEqual(
      RelayURLValidator.validate("ws://localhost:8787", allowInsecureLoopback: false),
      .failure(.init(message: "Relay URL 必须使用 wss；仅开发构建可使用本机回环 ws"))
    )
    XCTAssertEqual(
      RelayURLValidator.validate("ws://[::1]:8787", allowInsecureLoopback: true),
      .success("ws://[::1]:8787")
    )
    XCTAssertEqual(
      RelayURLValidator.validate("ws://relay.example.test", allowInsecureLoopback: true),
      .failure(.init(message: "Relay URL 必须使用 wss；仅开发构建可使用本机回环 ws"))
    )
    XCTAssertEqual(
      RelayURLValidator.validate("wss://relay.example.test?token=no", allowInsecureLoopback: false),
      .failure(.init(message: "Relay URL 不可包含凭证、查询参数或片段"))
    )
  }

  func testCLIInvocationUsesOnlyPublicRelayCommands() {
    XCTAssertEqual(
      RelayCLIInvocation.enable(url: "wss://relay.example.test/v1", development: false)
        .arguments(cli: "/daemon/cli.js"),
      ["/daemon/cli.js", "relay", "enable", "--url", "wss://relay.example.test/v1"]
    )
    XCTAssertEqual(
      RelayCLIInvocation.enable(url: "ws://127.0.0.1:8787", development: true)
        .arguments(cli: "/daemon/cli.js"),
      ["/daemon/cli.js", "relay", "enable", "--url", "ws://127.0.0.1:8787", "--dev"]
    )
    XCTAssertEqual(
      RelayCLIInvocation.disable.arguments(cli: "/daemon/cli.js"),
      ["/daemon/cli.js", "relay", "disable"]
    )
    XCTAssertEqual(
      RelayCLIInvocation.status.arguments(cli: "/daemon/cli.js"),
      ["/daemon/cli.js", "relay", "status", "--json"]
    )
    XCTAssertEqual(
      RelayCLIInvocation.rotateKey.arguments(cli: "/daemon/cli.js"),
      ["/daemon/cli.js", "relay", "rotate-key", "--yes"]
    )
  }

  @MainActor
  func testModelEnablesThenRefreshesViaCLI() async {
    let executor = RecordingExecutor(results: [
      RelayCLIResult(status: 0, output: "enabled"),
      RelayCLIResult(status: 0, output: "{\"relay\":{\"enabled\":true,\"state\":\"connected\",\"defaultUrl\":\"wss://relay.example.test/v1\",\"token\":\"not-for-ui\"}}"),
    ])
    let model = RelaySettingsModel(
      paths: { RelayCLIPaths(node: "/node", cli: "/daemon/cli.js") },
      executor: executor,
      allowInsecureLoopback: false
    )
    model.urlInput = "wss://relay.example.test/v1"

    await model.setEnabled(true)

    XCTAssertEqual(model.relay?.connectionState, .connected)
    XCTAssertNil(model.actionError)
    let calls = await executor.calls()
    XCTAssertEqual(calls, [
      ["/daemon/cli.js", "relay", "enable", "--url", "wss://relay.example.test/v1"],
      ["/daemon/cli.js", "relay", "status", "--json"],
    ])
  }

  @MainActor
  func testModelRecognizesOlderDaemonWithoutChangingFiles() async {
    let executor = RecordingExecutor(results: [
      RelayCLIResult(status: 1, output: "error: unknown command 'relay'"),
    ])
    let model = RelaySettingsModel(
      paths: { RelayCLIPaths(node: "/node", cli: "/daemon/cli.js") },
      executor: executor,
      allowInsecureLoopback: false
    )

    await model.refresh()

    XCTAssertEqual(model.cliSupported, false)
    XCTAssertNil(model.relay)
    let calls = await executor.calls()
    XCTAssertEqual(calls, [["/daemon/cli.js", "relay", "status", "--json"]])
  }

  func testRedactionRemovesRelayCredentialValues() {
    let input = "hostSecret=abc token=def relayToken=ghi deviceToken=jkl https://relay.test?token=secret"
    let redacted = RelayRedaction.redact(input)
    XCTAssertFalse(redacted.contains("abc"))
    XCTAssertFalse(redacted.contains("def"))
    XCTAssertFalse(redacted.contains("ghi"))
    XCTAssertFalse(redacted.contains("jkl"))
    XCTAssertFalse(redacted.contains("secret"))
  }
}

private actor RecordingExecutor: RelayCommandExecuting {
  private var queuedResults: [RelayCLIResult]
  private var recordedCalls: [[String]] = []

  init(results: [RelayCLIResult]) {
    queuedResults = results
  }

  func run(node: String, arguments: [String]) async -> RelayCLIResult {
    recordedCalls.append(arguments)
    return queuedResults.isEmpty
      ? RelayCLIResult(status: 1, output: "unexpected invocation")
      : queuedResults.removeFirst()
  }

  func calls() -> [[String]] { recordedCalls }
}
