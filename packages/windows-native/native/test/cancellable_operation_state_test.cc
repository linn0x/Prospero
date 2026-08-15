#include <iostream>

#include "prospero_cancellable_operation_state.h"

namespace {

bool Expect(bool condition, const char* message) {
  if (condition) return true;
  std::cerr << message << std::endl;
  return false;
}

}  // namespace

int main() {
  // This is the Windows ARM64 failure ordering: an accept borrower exists,
  // but cancellation wins before ConnectNamedPipe has submitted its
  // OVERLAPPED request.  The later issue must be rejected rather than wait
  // forever for a CancelIoEx that necessarily happened too early.
  prospero_cancellable_operation::State cancelled_before_issue;
  if (!Expect(cancelled_before_issue.BeginBorrow(),
              "a new endpoint must be borrowable before cancellation")) {
    return 1;
  }
  {
    auto stop = cancelled_before_issue.BeginStop();
    stop.Release();
  }
  auto late_issue = cancelled_before_issue.BeginIssue();
  if (!Expect(!late_issue.active(),
              "cancellation must reject an overlapped request issued after CancelIoEx")) {
    return 1;
  }
  cancelled_before_issue.EndBorrow();
  cancelled_before_issue.WaitForBorrowers();

  // Conversely, a request that obtains the issue guard before cancellation
  // remains a valid in-flight borrower.  Closing only becomes visible after
  // that submission guard has been released, at which point no new issue can
  // begin and the final close can wait for exactly this borrower to drain.
  prospero_cancellable_operation::State issued_before_cancel;
  if (!Expect(issued_before_cancel.BeginBorrow(),
              "a second endpoint must be borrowable before issue")) {
    return 1;
  }
  {
    auto issue = issued_before_cancel.BeginIssue();
    if (!Expect(issue.active(),
                "an uncancelled borrower must be allowed to submit one request")) {
      return 1;
    }
  }
  {
    auto stop = issued_before_cancel.BeginStop();
    stop.Release();
  }
  auto rejected_after_cancel = issued_before_cancel.BeginIssue();
  if (!Expect(!rejected_after_cancel.active(),
              "the same endpoint must not submit a second request after cancellation")) {
    return 1;
  }
  issued_before_cancel.EndBorrow();
  issued_before_cancel.WaitForBorrowers();
  return 0;
}
