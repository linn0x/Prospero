@testable import ProsperoShell
import XCTest

// Contract tests for the Mac daemon cursor boundary.
final class LocalSessionControlTests: XCTestCase {
  func testStructuredDeltaChecksRequestedBaseAndEventContinuity() throws {
    let response = Data(#"""
    {
      "kind":"structured", "mode":"delta", "baseSeq":4, "evSeq":6,
      "events":[
        {"kind":"text.delta", "msgId":"m", "textId":"t", "delta":"one"},
        {"kind":"turn.end", "msgId":"m", "finish":"completed"}
      ]
    }
    """#.utf8)

    guard case .delta(let delta) = try LocalStructuredFrame.decode(response, requestedAfterSeq: 4) else {
      return XCTFail("expected delta")
    }
    XCTAssertEqual(delta.baseSeq, 4)
    XCTAssertEqual(delta.evSeq, 6)
    XCTAssertEqual(delta.events.count, 2)
    XCTAssertThrowsError(try LocalStructuredFrame.decode(response, requestedAfterSeq: 3))
  }

  func testStructuredDeltaRejectsMismatchedEventCount() {
    let response = Data(#"""
    {
      "kind":"structured", "mode":"delta", "baseSeq":1, "evSeq":3,
      "events":[{"kind":"agent.error", "message":"only one"}]
    }
    """#.utf8)
    XCTAssertThrowsError(try LocalStructuredFrame.decode(response, requestedAfterSeq: 1))
  }

  func testSnapshotCanReplaceAStaleHigherCursorAfterDaemonRestart() throws {
    let response = Data(#"""
    {
      "kind":"structured", "mode":"snapshot", "evSeq":1,
      "events":[{"kind":"user.message", "msgId":"fresh", "text":"new daemon"}]
    }
    """#.utf8)
    guard case .snapshot(let snapshot) = try LocalStructuredFrame.decode(response, requestedAfterSeq: 99) else {
      return XCTFail("expected snapshot")
    }
    XCTAssertEqual(snapshot.evSeq, 1)
    XCTAssertEqual(snapshot.events.count, 1)
  }

  func testToolOutputDecoderRetainsDaemonTruncationSignal() throws {
    let output = try LocalToolOutput.decode(Data(#"{"output":"complete","truncated":true}"#.utf8))
    XCTAssertEqual(output.output, "complete")
    XCTAssertTrue(output.truncated)
  }
}
