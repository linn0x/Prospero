// Ghostty owns this short-lived PTY child; the actual session stays in the
// daemon. Closing a surface only detaches this relay.
#include <arpa/inet.h>
#include <errno.h>
#include <poll.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <termios.h>
#include <unistd.h>

static volatile sig_atomic_t resized = 1;
static unsigned char io_buffer[65536];

static void winch(int signo) {
  (void)signo;
  resized = 1;
}

static bool read_exact(int fd, void *data, size_t size) {
  unsigned char *bytes = (unsigned char *)data;
  while (size > 0) {
    ssize_t n = read(fd, bytes, size);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) return false;
    bytes += (size_t)n;
    size -= (size_t)n;
  }
  return true;
}

static bool write_all(int fd, const void *data, size_t size) {
  const unsigned char *bytes = (const unsigned char *)data;
  while (size > 0) {
    ssize_t n = write(fd, bytes, size);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) return false;
    bytes += (size_t)n;
    size -= (size_t)n;
  }
  return true;
}

static bool send_frame(int fd, char kind, const void *data, uint32_t size) {
  unsigned char header[5];
  uint32_t net_len = htonl(size);
  header[0] = (unsigned char)kind;
  memcpy(header + 1, &net_len, 4);
  return write_all(fd, header, sizeof(header)) && write_all(fd, data, size);
}

int main(int argc, char **argv) {
  struct sockaddr_un address;
  if (argc != 2 || strlen(argv[1]) >= sizeof(address.sun_path) || !isatty(STDIN_FILENO)) {
    return 2;
  }
  signal(SIGPIPE, SIG_IGN);
  signal(SIGWINCH, winch);

  int fd = socket(AF_UNIX, SOCK_STREAM, 0);
  if (fd < 0) return 3;

  memset(&address, 0, sizeof(address));
  address.sun_family = AF_UNIX;
  memcpy(address.sun_path, argv[1], strlen(argv[1]) + 1);
  if (connect(fd, (const struct sockaddr *)&address, sizeof(address)) != 0) {
    close(fd);
    return 4;
  }

  struct termios saved, raw;
  if (tcgetattr(STDIN_FILENO, &saved) != 0) {
    close(fd);
    return 5;
  }
  raw = saved;
  cfmakeraw(&raw);
  tcsetattr(STDIN_FILENO, TCSAFLUSH, &raw);

  struct pollfd descriptors[2] = {
    {fd, POLLIN, 0},
    {STDIN_FILENO, POLLIN, 0},
  };
  bool running = true;
  while (running) {
    if (resized) {
      resized = 0;
      struct winsize ws;
      memset(&ws, 0, sizeof(ws));
      if (ioctl(STDIN_FILENO, TIOCGWINSZ, &ws) == 0) {
        uint16_t dims[2] = {htons(ws.ws_col), htons(ws.ws_row)};
        if (!send_frame(fd, 'R', dims, sizeof(dims))) break;
      }
    }
    if (poll(descriptors, 2, -1) < 0) {
      if (errno == EINTR) continue;
      break;
    }
    if (descriptors[0].revents & POLLIN) {
      unsigned char header[5];
      if (!read_exact(fd, header, sizeof(header))) break;
      uint32_t size = 0;
      memcpy(&size, header + 1, 4);
      size = ntohl(size);
      if (header[0] != 'O' || size < 4 || size > 1024u * 1024u + 4096u) break;

      unsigned char ack_id[4];
      if (!read_exact(fd, ack_id, sizeof(ack_id))) break;
      uint32_t remaining = size - 4;
      bool stream_ok = true;
      while (remaining > 0) {
        size_t chunk = remaining < sizeof(io_buffer) ? (size_t)remaining : sizeof(io_buffer);
        if (!read_exact(fd, io_buffer, chunk) || !write_all(STDOUT_FILENO, io_buffer, chunk)) {
          stream_ok = false;
          break;
        }
        remaining -= (uint32_t)chunk;
      }
      if (!stream_ok || !send_frame(fd, 'A', ack_id, sizeof(ack_id))) break;
    }
    if (descriptors[1].revents & POLLIN) {
      ssize_t n = read(STDIN_FILENO, io_buffer, sizeof(io_buffer));
      if (n < 0 && errno == EINTR) continue;
      if (n <= 0 || !send_frame(fd, 'I', io_buffer, (uint32_t)n)) break;
    }
    if ((descriptors[0].revents | descriptors[1].revents) & (POLLHUP | POLLERR | POLLNVAL)) {
      running = false;
    }
  }

  tcsetattr(STDIN_FILENO, TCSAFLUSH, &saved);
  close(fd);
  return 0;
}
