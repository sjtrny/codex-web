let workspaceRoot = "/workspaces";

export function setWorkspaceRoot(value) {
  const normalized = String(value || "").replace(/\/+$/, "") || "/";
  if (!normalized.startsWith("/")) return false;
  workspaceRoot = normalized;
  return true;
}

function isWorkspacePath(value) {
  return workspaceRoot === "/"
    ? value.startsWith("/")
    : value === workspaceRoot || value.startsWith(`${workspaceRoot}/`);
}

export function workspaceFileUrl(value) {
  let candidate = String(value || "");
  if (candidate.startsWith("file://")) {
    candidate = candidate.slice("file://".length);
  }
  if (!isWorkspacePath(candidate)) {
    return null;
  }

  let line = "";
  const hashIndex = candidate.indexOf("#");
  if (hashIndex >= 0) {
    const fragment = candidate.slice(hashIndex + 1);
    const location = /^L?(\d+)(?:C\d+)?$/i.exec(fragment);
    if (location) line = location[1];
    candidate = candidate.slice(0, hashIndex);
  }

  try {
    candidate = decodeURIComponent(
      candidate.replace(/%(?![0-9a-f]{2})/gi, "%25"),
    );
  } catch {
    return null;
  }

  const suffix = /:(\d+)(?::\d+)?$/.exec(candidate);
  if (!line && suffix) line = suffix[1];

  const params = new URLSearchParams({ path: candidate });
  if (line) params.set("line", line);
  return `/api/files?${params.toString()}`;
}

export function rewriteWorkspaceLinks(fragment) {
  for (const link of fragment.querySelectorAll("a[href]")) {
    const rewritten = workspaceFileUrl(link.getAttribute("href"));
    if (rewritten) {
      link.setAttribute("href", rewritten);
      link.setAttribute("data-workspace-file", "true");
      link.title = "Open workspace file";
    }
  }
  return fragment;
}
