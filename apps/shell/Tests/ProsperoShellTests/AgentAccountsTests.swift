@testable import ProsperoShell
import XCTest

final class AgentAccountsTests: XCTestCase {
  private let accountJSON = """
  {
    "id":"profile-1",
    "agent":"codex",
    "name":"工作 Profile",
    "managed":true,
    "isDefault":true,
    "status":"signed_in",
    "apiProfile":{"provider":"openai_compatible","baseUrl":"https://gateway.example.test/v1","model":"test-model"},
    "authMethod":"API Key",
    "detail":"openai_compatible · gateway.example.test",
    "createdAt":1,
    "updatedAt":2,
    "activeSessions":3
  }
  """

  func testDecodesSecretFreeAccountSnapshot() throws {
    let account = try JSONDecoder().decode(CodeAgentAccount.self, from: Data(accountJSON.utf8))
    XCTAssertEqual(account.agent, .codex)
    XCTAssertEqual(account.apiProfile?.model, "test-model")
    XCTAssertEqual(account.activeSessions, 3)
    XCTAssertFalse(String(reflecting: account).contains("api-key"))
  }

  func testRequestUsesTheSharedProtocolMessageShape() {
    let create = AgentAccountOperation.create(agent: .claude, name: "个人 Claude").body
    XCTAssertEqual(create["type"] as? String, "agent.account.create")
    XCTAssertEqual(create["agent"] as? String, "claude")

    let configure = AgentAccountOperation.configureAPI(
      accountID: "profile-1",
      baseURL: "https://gateway.example.test/v1",
      model: "test-model",
      apiKey: "write-only-test-key"
    ).body
    XCTAssertEqual(configure["type"] as? String, "agent.account.api.configure")
    XCTAssertEqual(configure["accountId"] as? String, "profile-1")
    XCTAssertNil(configure["credential"])
  }

  func testEditorStateAndValidationFollowAccountRules() throws {
    let account = try JSONDecoder().decode(CodeAgentAccount.self, from: Data(accountJSON.utf8))
    let editor = AgentAccountEditorState(mode: .configureAPI(account))
    XCTAssertEqual(editor.name, "工作 Profile")
    XCTAssertEqual(editor.baseURL, "https://gateway.example.test/v1")
    XCTAssertEqual(editor.model, "test-model")
    XCTAssertTrue(editor.secret.isEmpty)
    XCTAssertNil(AgentAccountInputValidator.name("有效名称"))
    XCTAssertNotNil(AgentAccountInputValidator.name(""))
    XCTAssertNil(AgentAccountInputValidator.apiProfile(
      baseURL: "http://localhost:11434/v1", model: "local-model"
    ))
    XCTAssertNotNil(AgentAccountInputValidator.apiProfile(
      baseURL: "http://gateway.example.test/v1", model: "local-model"
    ))
    XCTAssertNotNil(AgentAccountInputValidator.credential("short", apiKey: false))
    XCTAssertNil(AgentAccountInputValidator.credential("one-character-key", apiKey: true))
  }

  func testProtocolSelectionAndCredentialPreservationAreCapabilityGated() throws {
    let account = try JSONDecoder().decode(CodeAgentAccount.self, from: Data(accountJSON.utf8))
    let legacy = AgentAccountEditorState(mode: .configureAPI(account))
    XCTAssertEqual(legacy.availableProtocols, [.responses])
    XCTAssertNotNil(legacy.apiValidationError)
    var editor = AgentAccountEditorState(mode: .configureAPI(account), supportsProtocols: true, supportsValidation: true)
    XCTAssertEqual(editor.availableProtocols, [.responses, .chat])
    XCTAssertTrue(editor.keepsCredential)
    XCTAssertNil(editor.apiValidationError)
    editor.apiProtocol = .chat
    editor.contextWindow = "32000"
    editor.maxOutputTokens = "4096"
    let body = AgentAccountOperation.configureAPI(
      accountID: account.id, baseURL: editor.baseURL, model: editor.model, apiKey: "",
      apiProtocol: editor.apiProtocol, modelCapabilities: editor.configuredModelCapabilities
    ).body
    XCTAssertEqual(body["protocol"] as? String, "openai_chat_completions")
    XCTAssertEqual(body["provider"] as? String, "openai_compatible")
    XCTAssertEqual((body["modelCapabilities"] as? [String: Any])?["contextWindow"] as? Int, 32000)
    XCTAssertEqual(body["apiKey"] as? String, "")
    editor.maxOutputTokens = "32001"
    XCTAssertNotNil(editor.apiValidationError)
    editor.maxOutputTokens = "0"
    XCTAssertNotNil(editor.apiValidationError)
  }

  func testNewMetadataReportsProtocolValidationWithoutClaimingLogin() throws {
    var payload = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(accountJSON.utf8)) as? [String: Any])
    let legacy = try JSONDecoder().decode(CodeAgentAccount.self, from: Data(accountJSON.utf8))
    XCTAssertEqual(legacy.statusLabel, "已配置 · 未验证")
    payload["engine"] = "opencode"
    payload["apiValidation"] = [
      "status": "failed", "checkedAt": 1000, "engine": "opencode",
      "checks": ["runtime": "passed", "streaming": "passed", "tools": "failed"],
      "detail": "工具回传测试失败。",
    ]
    let account = try JSONDecoder().decode(CodeAgentAccount.self, from: JSONSerialization.data(withJSONObject: payload))
    XCTAssertEqual(account.statusLabel, "API 验证失败")
    XCTAssertTrue(account.environmentLabel.contains("opencode"))
    XCTAssertEqual(account.apiValidation?.summary, "CLI 通过 · 流式响应 通过 · 工具回传 失败")
    XCTAssertEqual(AgentAccountOperation.testAPI(accountID: account.id).body["type"] as? String, "agent.account.api.test")
    payload.removeValue(forKey: "apiProfile")
    payload["apiProfileError"] = "配置无效"
    let invalid = try JSONDecoder().decode(CodeAgentAccount.self, from: JSONSerialization.data(withJSONObject: payload))
    XCTAssertTrue(invalid.isAPI)
    XCTAssertEqual(invalid.statusLabel, "配置无效")
  }

  func testRunningCapabilitiesDefaultToLegacy() {
    XCTAssertEqual(RunningStatus.load(root: ["pid": 1])?.capabilities, [])
    XCTAssertEqual(RunningStatus.load(root: ["pid": 1, "capabilities": ["agent.api-validation.v1"]])?.capabilities, ["agent.api-validation.v1"])
  }
}
