#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <sched.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/mman.h>
#include <unistd.h>

static void record(const char *path) {
    int fd = open(path, O_WRONLY | O_CREAT | O_EXCL, 0600);
    if (fd == -1 || dprintf(fd, "%ld\n", (long)getpid()) < 0 || close(fd) != 0) {
        _exit(120);
    }
}

static int child(void *path) {
    if (signal(SIGTERM, SIG_IGN) == SIG_ERR) {
        return 121;
    }
    record(path);
    for (;;) {
        pause();
    }
}

int main(int argc, char **argv) {
    if (argc != 4) {
        return 122;
    }
    size_t size = 64 * 1024;
    void *stack = mmap(NULL, size, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS | MAP_STACK, -1, 0);
    if (stack == MAP_FAILED) {
        return 123;
    }
    /* A zero exit signal creates a clone child that ordinary waitpid skips. */
    if (clone(child, (char *)stack + size, 0, argv[1]) == -1) {
        perror("clone");
        return 124;
    }
    record(argv[2]);
    while (access(argv[3], F_OK) != 0) {
        if (errno != ENOENT) {
            return 125;
        }
        usleep(1000);
    }
    return 3;
}
