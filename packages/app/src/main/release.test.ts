import { describe, expect, it } from "vitest";
import { isAllowedExternalUrl } from "./policy";
import {
  LATEST_RELEASE_URL,
  releasePageUrl,
  REPOSITORY,
  REPOSITORY_URL,
} from "./release";

describe("release", () => {
  it("names the repository by its current name", () => {
    expect(REPOSITORY).toBe("JJUN-SEO/Epoch");
    expect(REPOSITORY_URL).toBe("https://github.com/JJUN-SEO/Epoch");
  });

  it("links only where external links may go", () => {
    expect(isAllowedExternalUrl(REPOSITORY_URL)).toBe(true);
  });

  it("asks GitHub's API for the latest release of this repository", () => {
    expect(LATEST_RELEASE_URL).toBe(
      "https://api.github.com/repos/JJUN-SEO/Epoch/releases/latest",
    );
  });

  it("builds a release page link from a release tag only", () => {
    const url = releasePageUrl("v1.2.3");
    expect(url).toBe("https://github.com/JJUN-SEO/Epoch/releases/tag/v1.2.3");
    expect(isAllowedExternalUrl(url ?? "")).toBe(true);
    for (const tag of ["v1.2.3-rc.1", "../../evil", "v1.2.3/../x", "", "v1.2"])
      expect(releasePageUrl(tag)).toBeUndefined();
  });
});
