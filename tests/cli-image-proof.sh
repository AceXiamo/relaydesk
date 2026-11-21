#!/usr/bin/env bash
# Pass the tag of a locally built runner image. No model credentials or external network.
set -euo pipefail
image=${1:?runner image tag required}
fixture="$(cd "$(dirname "$0")" && pwd)/cli-image-proof.py"
limits=(--rm --init --network none --read-only --cap-drop ALL --security-opt no-new-privileges
        --cap-add SETUID --cap-add SETGID --cap-add CHOWN --cap-add KILL --cap-add DAC_OVERRIDE
        --cpus=1 --memory=1g --pids-limit=128 --tmpfs /tmp:rw,exec,nosuid,nodev,mode=1777,size=256m)
docker run "${limits[@]}" "$image" --self-test
docker run "${limits[@]}" --mount "type=bind,src=$fixture,dst=/fixture.py,readonly" --entrypoint sh \
  "$image" -ec 'python3 -I /fixture.py --serve & python3 -I /fixture.py'
