// Ghostty owns this short-lived PTY child; the actual session stays in the
// daemon. Closing a surface only detaches this relay.
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/ioctl.h>
#include <arpa/inet.h>
#include <unistd.h>
#include <termios.h>
#include <poll.h>
#include <signal.h>
#include <errno.h>
#include <cstring>
#include <vector>
#include <cstdint>

static volatile sig_atomic_t resized = 1;
static void winch(int) { resized = 1; }
static bool transfer(int fd, void *data, size_t size, bool output) {
  auto *bytes = static_cast<char *>(data);
  while (size) {
    ssize_t n = output ? write(fd, bytes, size) : read(fd, bytes, size);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) return false;
    bytes += n; size -= n;
  }
  return true;
}
static bool sendFrame(int fd, char kind, const void *data, uint32_t size) {
  unsigned char header[5]; header[0] = kind; uint32_t length = htonl(size); memcpy(header + 1, &length, 4);
  return transfer(fd, header, 5, true) && transfer(fd, const_cast<void *>(data), size, true);
}
int main(int argc, char **argv) {
  if (argc != 2 || strlen(argv[1]) >= sizeof(sockaddr_un::sun_path) || !isatty(STDIN_FILENO)) return 2;
  signal(SIGPIPE, SIG_IGN); signal(SIGWINCH, winch);
  int fd = socket(AF_UNIX, SOCK_STREAM, 0); if (fd < 0) return 3;
  sockaddr_un address = {}; address.sun_family = AF_UNIX; strcpy(address.sun_path, argv[1]);
  if (connect(fd, reinterpret_cast<sockaddr *>(&address), sizeof(address))) return 4;
  termios saved, raw;
  if (tcgetattr(STDIN_FILENO, &saved)) return 5;
  raw = saved; cfmakeraw(&raw); tcsetattr(STDIN_FILENO, TCSAFLUSH, &raw);
  pollfd descriptors[2] = {{fd, POLLIN, 0}, {STDIN_FILENO, POLLIN, 0}};
  bool running = true;
  while (running) {
    if (resized) {
      resized = 0; winsize size = {};
      if (!ioctl(STDIN_FILENO, TIOCGWINSZ, &size)) {
        uint16_t dims[2] = {htons(size.ws_col), htons(size.ws_row)};
        if (!sendFrame(fd, 'R', dims, sizeof(dims))) break;
      }
    }
    if (poll(descriptors, 2, -1) < 0) { if (errno == EINTR) continue; break; }
    if (descriptors[0].revents & POLLIN) {
      unsigned char header[5];
      if (!transfer(fd, header, 5, false)) break;
      uint32_t size; memcpy(&size, header + 1, 4); size = ntohl(size);
      if (header[0] != 'O' || size < 4 || size > 1024 * 1024 + 4096) break;
      std::vector<unsigned char> bytes(size);
      if (!transfer(fd, bytes.data(), size, false) || !transfer(STDOUT_FILENO, bytes.data() + 4, size - 4, true)) break;
      if (!sendFrame(fd, 'A', bytes.data(), 4)) break;
    }
    if (descriptors[1].revents & POLLIN) {
      char bytes[8192]; ssize_t n = read(STDIN_FILENO, bytes, sizeof(bytes));
      if (n <= 0 || !sendFrame(fd, 'I', bytes, static_cast<uint32_t>(n))) break;
    }
    if ((descriptors[0].revents | descriptors[1].revents) & (POLLHUP | POLLERR | POLLNVAL)) running = false;
  }
  tcsetattr(STDIN_FILENO, TCSAFLUSH, &saved); close(fd); return 0;
}
