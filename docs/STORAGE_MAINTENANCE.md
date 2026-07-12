# Storage maintenance

Historical validation, rollback, and backup directories may be moved to cold
storage without discarding evidence:

```sh
scripts/archive-directory-zstd.sh /opt/polymirror/validation /opt/polymirror/cold-archives
```

The helper uses the system `tar`, `zstd`, and `sha256sum` implementations. It
creates a temporary archive, tests the complete compressed stream, lists the
tar payload, publishes an adjacent SHA-256 manifest, verifies the published
pair, and only then removes the source directory.

Restore an archive into a staging directory before use:

```sh
mkdir -p /opt/polymirror/restore-staging
cd /opt/polymirror/cold-archives
sha256sum -c validation.tar.zst.sha256
tar --zstd -xf validation.tar.zst -C /opt/polymirror/restore-staging
```

Never archive active account data, an active cohort directory, or a directory
being used as the current rollback source. Docker build cache and unused images
are reproducible and may be pruned independently of experiment evidence.
