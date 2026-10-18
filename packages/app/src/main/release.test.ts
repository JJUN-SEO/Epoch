import { describe, expect, it } from "vitest";
import { isAllowedExternalUrl } from "./policy";
import { REPOSITORY, REPOSITORY_URL } from "./release";

describe("release", () => {
  it("names the repository by its current name", () => {
    expect(REPOSITORY).toBe("JJUN-SEO/Epoch");
    expect(REPOSITORY_URL).toBe("https://github.com/JJUN-SEO/Epoch");
  });

  it("links only where external links may go", () => {
    expect(isAllowedExternalUrl(REPOSITORY_URL)).toBe(true);
  });
});
