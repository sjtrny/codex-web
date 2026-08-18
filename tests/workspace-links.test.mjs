import assert from "node:assert/strict";

import {
  rewriteWorkspaceLinks,
  setWorkspaceRoot,
  workspaceFileUrl,
} from "../frontend/workspace-links.mjs";

assert.equal(
  workspaceFileUrl("/workspaces/example-project/report.pdf"),
  "/api/files?path=%2Fworkspaces%2Fexample-project%2Freport.pdf",
);
assert.equal(
  workspaceFileUrl("/workspaces/example-project/a%20file.py:42:7"),
  "/api/files?path=%2Fworkspaces%2Fexample-project%2Fa+file.py%3A42%3A7&line=42",
);
assert.equal(
  workspaceFileUrl("file:///workspaces/example-project/image.png#L12"),
  "/api/files?path=%2Fworkspaces%2Fexample-project%2Fimage.png&line=12",
);
assert.equal(
  workspaceFileUrl("/workspaces/example-project/100%.txt"),
  "/api/files?path=%2Fworkspaces%2Fexample-project%2F100%25.txt",
);
assert.equal(workspaceFileUrl("https://example.com/report.pdf"), null);
assert.equal(workspaceFileUrl("/etc/passwd"), null);

const attributes = new Map([["href", "/workspaces/example-project/result.txt:9"]]);
const link = {
  title: "",
  getAttribute(name) {
    return attributes.get(name) ?? null;
  },
  setAttribute(name, value) {
    attributes.set(name, String(value));
  },
};
rewriteWorkspaceLinks({ querySelectorAll: () => [link] });
assert.equal(
  attributes.get("href"),
  "/api/files?path=%2Fworkspaces%2Fexample-project%2Fresult.txt%3A9&line=9",
);
assert.equal(attributes.get("data-workspace-file"), "true");
assert.equal(link.title, "Open workspace file");

assert.equal(setWorkspaceRoot("/srv/code/"), true);
assert.equal(
  workspaceFileUrl("/srv/code/project/result.txt:12"),
  "/api/files?path=%2Fsrv%2Fcode%2Fproject%2Fresult.txt%3A12&line=12",
);
assert.equal(
  workspaceFileUrl("file:///srv/code/project/image.png"),
  "/api/files?path=%2Fsrv%2Fcode%2Fproject%2Fimage.png",
);
assert.equal(workspaceFileUrl("/workspaces/example-project/report.pdf"), null);
assert.equal(setWorkspaceRoot("relative/path"), false);

console.log("workspace-links=ok");
