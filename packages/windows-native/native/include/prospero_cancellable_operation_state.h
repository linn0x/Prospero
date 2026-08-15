#ifndef PROSPERO_CANCELLABLE_OPERATION_STATE_H_
#define PROSPERO_CANCELLABLE_OPERATION_STATE_H_

#include <condition_variable>
#include <cstdint>
#include <mutex>
#include <utility>

// This small state machine deliberately has no Win32 dependency so its
// cancellation ordering can be tested on every development host.  A borrower
// keeps an OS endpoint alive while it waits for a result.  An IssueGuard makes
// the short transition from "borrowed" to "the overlapped request has been
// submitted" atomic with cancellation: after BeginStop(), no future request
// can be submitted for a handle whose CancelIoEx has already run.
namespace prospero_cancellable_operation {

class State {
 public:
  class IssueGuard {
   public:
    IssueGuard() = default;
    IssueGuard(const IssueGuard&) = delete;
    IssueGuard& operator=(const IssueGuard&) = delete;

    IssueGuard(IssueGuard&& other) noexcept
        : issue_lock_(std::move(other.issue_lock_)), active_(other.active_) {
      other.active_ = false;
    }

    IssueGuard& operator=(IssueGuard&& other) noexcept {
      if (this == &other) return *this;
      Release();
      issue_lock_ = std::move(other.issue_lock_);
      active_ = other.active_;
      other.active_ = false;
      return *this;
    }

    ~IssueGuard() { Release(); }

    bool active() const noexcept { return active_; }

    void Release() noexcept {
      if (issue_lock_.owns_lock()) issue_lock_.unlock();
      active_ = false;
    }

   private:
    friend class State;

    explicit IssueGuard(State* state) : issue_lock_(state->issue_mutex_) {
      std::lock_guard<std::mutex> lock(state->state_mutex_);
      active_ = !state->stopped_;
    }

    std::unique_lock<std::mutex> issue_lock_;
    bool active_ = false;
  };

  class StopGuard {
   public:
    StopGuard(const StopGuard&) = delete;
    StopGuard& operator=(const StopGuard&) = delete;
    StopGuard(StopGuard&&) noexcept = default;
    StopGuard& operator=(StopGuard&&) noexcept = default;

    void Release() noexcept {
      if (issue_lock_.owns_lock()) issue_lock_.unlock();
    }

   private:
    friend class State;

    explicit StopGuard(State* state) : issue_lock_(state->issue_mutex_) {
      std::lock_guard<std::mutex> lock(state->state_mutex_);
      state->stopped_ = true;
    }

    std::unique_lock<std::mutex> issue_lock_;
  };

  bool BeginBorrow() noexcept {
    std::lock_guard<std::mutex> lock(state_mutex_);
    if (stopped_) return false;
    ++borrowers_;
    return true;
  }

  void EndBorrow() noexcept {
    std::lock_guard<std::mutex> lock(state_mutex_);
    if (borrowers_ == 0) return;
    --borrowers_;
    if (stopped_ && borrowers_ == 0) drained_.notify_all();
  }

  IssueGuard BeginIssue() { return IssueGuard(this); }

  // The caller keeps this guard alive through CancelIoEx, then releases it
  // before waiting for borrowers. That orders a cancel after every
  // already-issued request, while later BeginIssue calls observe stopped_ and
  // refuse to submit a request that could not be cancelled.
  StopGuard BeginStop() { return StopGuard(this); }

  /**
   * Keep stopping and the native cancellation call atomic with overlapped
   * submission, then release the issue lock before waiting for borrowers.
   * Centralising this order prevents a closer from waiting while a borrower
   * is itself blocked trying to observe `stopped_`.
   */
  template <typename Cancel>
  void StopCancelAndWait(Cancel&& cancel) {
    {
      auto stop = BeginStop();
      std::forward<Cancel>(cancel)();
    }
    WaitForBorrowers();
  }

  void WaitForBorrowers() noexcept {
    std::unique_lock<std::mutex> lock(state_mutex_);
    drained_.wait(lock, [this] { return borrowers_ == 0; });
  }

 private:
  std::mutex state_mutex_;
  std::mutex issue_mutex_;
  std::condition_variable drained_;
  uint32_t borrowers_ = 0;
  bool stopped_ = false;
};

}  // namespace prospero_cancellable_operation

#endif  // PROSPERO_CANCELLABLE_OPERATION_STATE_H_
