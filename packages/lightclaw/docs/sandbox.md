# LightClaw Docker Sandbox

LightClaw connects to chat platforms and models on the host while `bash/read/write/edit` tools execute inside Docker. The container receives only the selected data directory, not other host files or API keys.

## Create the sandbox

Run from the repository root:

```bash
mkdir -p lightclaw-data
bash packages/lightclaw/docker.sh create ./lightclaw-data
```

The script builds a local image with these defaults:

- 1 CPU
- 512 MB memory and no additional swap
- 128 processes
- All Linux capabilities removed
- Privilege escalation disabled
- The current host UID/GID instead of root
- A separate 64 MB temporary filesystem at `/tmp`

The image includes bash, curl, git, jq, and Python 3. The running Agent cannot use `apk add`. Add required system packages to `Dockerfile` and rebuild so the environment remains reproducible.

## Configure limits

Set variables before `create`:

```bash
export LIGHTCLAW_SANDBOX_CPUS=2
export LIGHTCLAW_SANDBOX_MEMORY=1g
export LIGHTCLAW_SANDBOX_PIDS_LIMIT=256
export LIGHTCLAW_SANDBOX_NETWORK=none
bash packages/lightclaw/docker.sh create ./lightclaw-data
```

`LIGHTCLAW_SANDBOX_NETWORK=none` blocks network access from tools without affecting host-side chat or model connections. Keep the default `bridge` setting when tools need git or curl.

## Management commands

```bash
bash packages/lightclaw/docker.sh status
bash packages/lightclaw/docker.sh stop
bash packages/lightclaw/docker.sh start
bash packages/lightclaw/docker.sh shell
bash packages/lightclaw/docker.sh remove
```

Existing containers do not receive new limits automatically. Recreate the container once after upgrading:

```bash
bash packages/lightclaw/docker.sh remove
bash packages/lightclaw/docker.sh create ./lightclaw-data
```

Docker reduces the blast radius but is not an absolute security boundary. Do not mount sensitive directories, and use dedicated least-privilege credentials for external services.
