# Container identity and writable paths

Newly built runtime and migration images run as `mailhub`, fixed UID/GID
`10001:10001`. Web and Worker share this identity. Application code and installed
packages remain owned by root and cannot be modified by the application. The
entrypoint does not escalate privileges or automatically change volume ownership.
The existing `npm run worker`, `npx prisma ...` and `npx --no-install prisma ...`
container commands still work through the package-manager-free entrypoint.

Writable paths are:

| Path | Purpose | Persistence |
| --- | --- | --- |
| `/app/.storage` | Attachments shared by Web and every Worker | Required shared volume |
| `/app/.next/cache` | Web image/incremental cache | Disposable, container-local |
| `/app/.cache` | `XDG_CACHE_HOME`, including tool caches | Disposable, container-local |
| `/home/mailhub` | `HOME` for runtime tools | Disposable, container-local |
| `/tmp` | Temporary files (`TMPDIR`) | Disposable, container-local |

New private directories use mode `0700`; files created through the entrypoint
use `0600` (umask `077`). Existing modes are not silently rewritten. Mounting over
any of these paths hides the image's ownership, so bind mounts and pre-existing
volumes need preparation. Fresh Docker named volumes copy the image directory's
ownership unless volume copy-up is explicitly disabled. Keep `/app/.storage` at
its existing path: persisted attachment references depend on it. If using a
read-only root filesystem, supply writable mounts for all the paths above,
owned by `10001:10001`; `/tmp` may use a private tmpfs with mode `1777`.

## Prepare an existing attachment volume

Stop Web and **all** Workers before changing storage and take a backup/snapshot
of both the database and attachment volume. Identify the actual attachment
volume with `docker volume ls` and `docker volume inspect`; Compose usually
prefixes its name with the project name. Never apply these commands to database,
Redis, search, or unrelated host directories.

Set `IMAGE` to the newly built runtime image and `STORAGE_VOLUME` to that exact
Docker volume name. Inspect the mount and backup before proceeding. This one-off
maintenance container explicitly runs as root and bypasses the normal entrypoint;
normal application containers continue to run unprivileged.

```sh
IMAGE=mailhub-smoke:runtime # replace with your built/published image
STORAGE_VOLUME=myproject_mailhub_storage # replace with the inspected name

docker run --rm --user 0:0 --entrypoint sh \
  --mount "type=volume,src=$STORAGE_VOLUME,dst=/data" "$IMAGE" -ec '
    find /data -xdev -type d -exec chown 10001:10001 {} +
    find /data -xdev -type f -exec chown 10001:10001 {} +
    find /data -xdev -type d -exec chmod 700 {} +
    find /data -xdev -type f -exec chmod 600 {} +
  '

# Verify nested reads/writes as the application identity before restarting.
docker run --rm \
  --mount "type=volume,src=$STORAGE_VOLUME,dst=/app/.storage" \
  "$IMAGE" sh -ec '
    test "$(id -u):$(id -g)" = 10001:10001
    mkdir /app/.storage/.permission-check
    printf synthetic > /app/.storage/.permission-check/file
    rm /app/.storage/.permission-check/file
    rmdir /app/.storage/.permission-check
  '
```

Also verify representative existing nested attachments can be read and updated by
UID 10001 before resuming mail processing.

The repair visits only regular files/directories inside the selected volume and
does not follow symbolic links or cross filesystem boundaries. Review any special
files or symlinks separately. For bind mounts, prepare only the dedicated
attachment directory; never recursively change ownership of a home directory,
repository, `/var/lib/docker`, or host filesystem. Rootless Docker and user
namespace remapping translate container UID 10001 to a different host UID; use a
maintenance container in the same Docker daemon rather than guessing host IDs.

If startup reports a writable-path error, inspect the mount destination, UID and
modes first. A writable root directory does not guarantee nested legacy files are
accessible. If modifying the original bind mount is undesirable, copy the backup
into a **new dedicated named volume**, apply the scoped repair there, and point
Web and every Worker at that volume at `/app/.storage`. Keep the original volume
and database snapshot for rollback. Restore a matching database/storage snapshot
if rollback is needed; do not delete attachments or use `chmod 777` as a repair.
Caches can be recreated independently; attachment storage cannot.

Run schema deployment with the dedicated `migrate` image (same UID/GID), then
start Web and Workers. `bash scripts/ci/smoke.sh` validates both images, fresh and
root-owned/repaired volumes, private file/directory creation, synthetic attachment
preservation, repeatable migrations, Web HTTP startup, and Worker heartbeat.
