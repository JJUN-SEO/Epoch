import assert from "node:assert/strict";
import { test } from "node:test";
import { copyrightLine } from "./site-data.mjs";

test("the copyright line is the first line that starts with Copyright", () => {
  assert.equal(
    copyrightLine(
      "MIT License\n\nCopyright (c) 2019 GitHub Inc.\n\nPermission",
    ),
    "Copyright (c) 2019 GitHub Inc.",
  );
  assert.equal(
    copyrightLine("Copyright 2010 Pallets\r\n\r\nRedistribution"),
    "Copyright 2010 Pallets",
  );
  assert.equal(copyrightLine("no holder named"), "");
});
