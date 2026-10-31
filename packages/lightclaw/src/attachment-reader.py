"""Bounded POSIX attachment read. No path is reopened after authorization."""

import os
import stat
import sys


def components(path):
    parts = path.split("/")
    if not path or "\\" in path or "\0" in path or any(p in ("", ".", "..") for p in parts):
        raise ValueError("Attachment requires a channel-relative path without traversal")
    return parts


def read_attachment(root, channel, path, limit):
    if len(components(channel)) != 1:
        raise ValueError("Invalid attachment channel")
    parts = components(path)
    if limit <= 0 or not os.path.isabs(root):
        raise ValueError("Invalid attachment read policy")
    # root is a trusted, canonical host configuration, not model input.
    # Walk from / with pinned directory descriptors even for the root itself.
    directories = [p for p in root.split("/") if p] + [channel] + parts[:-1]
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    parent = os.open("/", flags)
    try:
        for name in directories:
            child = os.open(name, flags, dir_fd=parent)
            os.close(parent)
            parent = child
        fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=parent)
        try:
            before = os.fstat(fd)
            if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
                raise ValueError("Attachment must be a regular file with one hard link")
            if before.st_size > limit:
                raise ValueError("Attachment exceeds upload size limit")
            chunks = []
            size = 0
            while True:
                chunk = os.read(fd, min(65536, limit + 1 - size))
                if not chunk:
                    break
                size += len(chunk)
                if size > limit:
                    raise ValueError("Attachment exceeds upload size limit")
                chunks.append(chunk)
            after = os.fstat(fd)
            def fingerprint(s):
                return (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns, s.st_nlink)
            if fingerprint(before) != fingerprint(after) or size != after.st_size:
                raise ValueError("Attachment changed during read")
            return b"".join(chunks)
        finally:
            os.close(fd)
    finally:
        os.close(parent)


if __name__ == "__main__":
    try:
        data = read_attachment(sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4]))
        sys.stdout.buffer.write(data)
    except (OSError, ValueError) as error:
        # Do not expose host paths or file contents in tool errors.
        sys.stderr.write(f"Attachment rejected ({type(error).__name__})\n")
        sys.exit(1)
