"""Publish inbound bytes under pinned channel directory FDs; never follow links."""
import os, sys, stat, uuid
root, channel, name, maximum = sys.argv[1:]
maximum = int(maximum)
if not channel or any(c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-" for c in channel):
    raise ValueError("invalid channel")
if not name or name in (".", "..") or "/" in name or "\\" in name or "\0" in name:
    raise ValueError("invalid filename")
data = sys.stdin.buffer.read(maximum + 1)
if len(data) > maximum:
    raise ValueError("size limit")
flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
fds = [os.open(root, flags)]
temporary = "." + uuid.uuid4().hex + ".partial"
try:
    for component in (channel, "attachments"):
        try: os.mkdir(component, mode=0o700, dir_fd=fds[-1])
        except FileExistsError: pass
        fds.append(os.open(component, flags, dir_fd=fds[-1]))
    directory = fds[-1]
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
    try:
        with os.fdopen(fd, "wb") as out:
            out.write(data)
            out.flush()
            os.fsync(out.fileno())
        try:
            os.link(temporary, name, src_dir_fd=directory, dst_dir_fd=directory, follow_symlinks=False)
        except FileExistsError:
            old = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
            with os.fdopen(old, "rb") as existing:
                info = os.fstat(existing.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > maximum or existing.read(maximum + 1) != data:
                    raise ValueError("existing attachment replaced or changed")
        os.unlink(temporary, dir_fd=directory)
        os.fsync(directory)
        for index, component in enumerate((channel, "attachments")):
            expected = os.fstat(fds[index + 1])
            actual = os.stat(component, dir_fd=fds[index], follow_symlinks=False)
            if actual.st_ino != expected.st_ino or actual.st_dev != expected.st_dev:
                raise ValueError("attachment directory replaced")
    finally:
        try: os.unlink(temporary, dir_fd=directory)
        except FileNotFoundError: pass
finally:
    for fd in reversed(fds): os.close(fd)
