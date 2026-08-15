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
}
