"""Read repository metadata using the operator's GitHub token."""
import json
import os
from pathlib import Path
from tempfile import NamedTemporaryFile
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, Request, build_opener


class GithubError(Exception):
    pass


class NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def repositories(token, page=1):
    url = f"https://api.github.com/user/repos?sort=updated&per_page=100&page={page}"
    request = Request(url, headers={"Authorization": "Bearer " + token,
                                    "Accept": "application/vnd.github+json", "User-Agent": "Relaydesk"})
    try:
        with build_opener(NoRedirects()).open(request, timeout=10) as response:
            rows = json.load(response)
            more = 'rel="next"' in response.headers.get("Link", "")
            return {"repos": [repo["full_name"] for repo in rows], "more": more}
    except HTTPError as exc:
        if exc.code in {401, 403}:
            raise GithubError("GitHub 拒绝了请求，请检查 token、组织授权和 API 配额。") from None
        raise GithubError(f"GitHub 返回 {exc.code}，请稍后重试。") from None
    except (OSError, URLError, ValueError, KeyError, TypeError):
        raise GithubError("无法读取 GitHub 仓库，请稍后重试。") from None


def save_token(path, token):
    with NamedTemporaryFile(mode="w", dir=path.parent, delete=False) as handle:
        tmp = Path(handle.name)
        try:
            handle.write(token)
            handle.flush()
            os.replace(tmp, path)
        finally:
            tmp.unlink(missing_ok=True)
