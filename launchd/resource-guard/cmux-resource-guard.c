// Keep a native named launchd executable alive while Node dispatches the duties.
#include <errno.h>
#include <fcntl.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <limits.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/wait.h>
#include <unistd.h>
#include <string.h>
#ifndef GUARD_NODE
#error GUARD_NODE must be an absolute installed node path
#endif
#ifndef GUARD_ENTRY
#error GUARD_ENTRY must be the installed resource-guard.js path
#endif
static volatile sig_atomic_t child = 0;
static void forward(int sig) { if (child > 0) kill(-child, sig); }
static void log_busy(const char *home) {
    char dir[PATH_MAX], file[PATH_MAX], archive[PATH_MAX];
    const char *configured = getenv("CMUX_RESOURCE_GUARD_LOG_DIR");
    int length = configured ? snprintf(dir,sizeof(dir),"%s",configured) : snprintf(dir,sizeof(dir),"%s/Library/Logs/cmux-resource-guard",home);
    if (length < 0 || length >= (int)sizeof(dir)) return;
    for (char *p = dir + 1; *p; p++) if (*p == '/') { *p = 0; (void)mkdir(dir,0700); *p = '/'; }
    (void)mkdir(dir,0700);
    if (snprintf(file,sizeof(file),"%s/guard.lock.log",dir) >= (int)sizeof(file)) return;
    if (snprintf(archive,sizeof(archive),"%s.1",file) >= (int)sizeof(archive)) return;
    const char *message = "resource guard: tick skipped (lock busy)\n";
    struct stat info;
    if (stat(file,&info) == 0 && info.st_size + (off_t)strlen(message) > 5 * 1024 * 1024) (void)rename(file,archive);
    FILE *out = fopen(file,"a");
    if (out) { fputs(message,out); fclose(out); } else fputs(message,stderr);
}
int main(void) {
    char lock[PATH_MAX];
    const char *home = getenv("HOME");
    if (!home || snprintf(lock, sizeof(lock), "%s/.cmux-resource-guard.lock", home) >= (int)sizeof(lock)) return 1;
    int fd = open(lock, O_CREAT | O_RDWR, 0600);
    if (fd < 0) { perror("lock"); return 1; }
    if (flock(fd, LOCK_EX | LOCK_NB) < 0) { log_busy(home); return 0; }
    if (setenv("PATH", GUARD_PATH, 1) < 0) return 1;
    signal(SIGTERM, forward); signal(SIGINT, forward);
    child = fork();
    if (child < 0) { perror("fork"); return 1; }
    if (!child) { if (setpgid(0, 0) < 0) _exit(1); execl(GUARD_NODE, GUARD_NODE, GUARD_ENTRY, (char *)NULL); perror("node"); _exit(127); }
    (void)setpgid(child, child); // Node forwards shutdown to its separately owned duty groups.
    int status;
    while (waitpid(child, &status, 0) < 0) { if (errno != EINTR) { perror("waitpid"); return 1; } }
    return WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
}
