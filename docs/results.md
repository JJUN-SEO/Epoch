# Measured results

Every table here is copied by `scripts/readme-tables.mjs` from a report that a reproducible script generated; `pnpm lint` fails if a copied cell is edited by hand. Each linked report names its repositories, commits, method, host and limits. The README shows a few headline numbers from these tables.

## Full and incremental analysis

zod, from [the performance report](benchmarks/typescript-performance.md). The report also covers vitest; these timings are medians under the report's stated conditions.

<!-- BEGIN GENERATED:typescript-performance -->

| Scenario                     | Wall   | Analysis | Discover | Changes | Parse  | Resolve | Graph | Files parsed | Files re-hashed |
| ---------------------------- | ------ | -------- | -------- | ------- | ------ | ------- | ----- | ------------ | --------------- |
| cold (empty cache)           | 1.69 s | 1.18 s   | 27 ms    | 42 ms   | 850 ms | 234 ms  | 26 ms | 522          | 522             |
| cold, parsing in-process     | 2.11 s | 1.61 s   | 27 ms    | 39 ms   | 1.32 s | 200 ms  | 23 ms | 522          | 522             |
| warm, unchanged              | 809 ms | 319 ms   | 30 ms    | 66 ms   | 0 ms   | 199 ms  | 25 ms | 0            | 0               |
| incremental, 1 file edited   | 890 ms | 375 ms   | 34 ms    | 64 ms   | 52 ms  | 201 ms  | 25 ms | 1            | 3               |
| incremental, 5 files edited  | 898 ms | 406 ms   | 26 ms    | 62 ms   | 91 ms  | 201 ms  | 26 ms | 5            | 15              |
| incremental, 50 files edited | 1.13 s | 590 ms   | 26 ms    | 78 ms   | 230 ms | 230 ms  | 33 ms | 50           | 135             |

<!-- END GENERATED:typescript-performance -->

## Dependency accuracy

TypeScript/JavaScript versus dependency-cruiser, from [the TS/JS report](benchmarks/typescript.md). Adjusted scores classify each disagreement and include real edges the comparison tool missed.

<!-- BEGIN GENERATED:typescript-accuracy -->

| Repository                               | Commit       | Files | Epoch edges | Tool edges | Agreed | Raw precision | Raw recall | Adjusted precision | Adjusted recall | Unclassified |
| ---------------------------------------- | ------------ | ----- | ----------- | ---------- | ------ | ------------- | ---------- | ------------------ | --------------- | ------------ |
| https://github.com/colinhacks/zod.git    | 680d19f7d1e0 | 523   | 970         | 901        | 901    | 92.9%         | 100.0%     | 100.0%             | 100.0%          | 0            |
| https://github.com/vitest-dev/vitest.git | 2899eb3e9793 | 2400  | 4655        | 4405       | 4374   | 94.0%         | 99.3%      | 100.0%             | 100.0%          | 0            |
| https://github.com/vuejs/core.git        | 0ff253bfba3e | 528   | 1818        | 1818       | 1818   | 100.0%        | 100.0%     | 100.0%             | 100.0%          | 0            |

<!-- END GENERATED:typescript-accuracy -->

Python versus grimp, from [the Python report](benchmarks/python-accuracy.md). The adjusted score accounts for namespace package imports the comparison tool missed.

<!-- BEGIN GENERATED:python-accuracy -->

| Edges                      | Epoch | Reference | Agreed | Raw precision | Raw recall | Adjusted precision | Adjusted recall | Unclassified |
| -------------------------- | ----- | --------- | ------ | ------------- | ---------- | ------------------ | --------------- | ------------ |
| flask vs grimp             | 95    | 68        | 68     | 71.6%         | 100.0%     | 100.0%             | 100.0%          | 0            |
| flask vs CPython's finders | 95    | 95        | 95     | 100.0%        | 100.0%     | 100.0%             | 100.0%          | 0            |
| httpx vs grimp             | 87    | 87        | 87     | 100.0%        | 100.0%     | 100.0%             | 100.0%          | 0            |
| httpx vs CPython's finders | 87    | 87        | 87     | 100.0%        | 100.0%     | 100.0%             | 100.0%          | 0            |

<!-- END GENERATED:python-accuracy -->

Go versus `go list`, from [the Go report](benchmarks/go.md). Build-tagged test files explain the remaining test-edge difference.

<!-- BEGIN GENERATED:go-accuracy -->

| Edges      | Epoch | go list | Agreed | Precision | Recall |
| ---------- | ----- | ------- | ------ | --------- | ------ |
| Production | 1444  | 1444    | 1444   | 100.0%    | 100.0% |
| Tests      | 1098  | 1093    | 1093   | 99.5%     | 100.0% |

<!-- END GENERATED:go-accuracy -->

## Findings precision

Two samples, and the difference matters:

- **Design sample** ([findings report](benchmarks/findings.md)): pinned repositories whose verdicts were assessed by Claude at the maintainer's request (**not** a human precision study). The 2026-10-22 unreachable-file fixes were made against these verdicts, so this sample overstates precision on code Epoch has not seen.
- **Held-out sample** ([held-out report](benchmarks/findings-heldout.md)): trpc/trpc and fastapi/fastapi, never used to design the detectors, with a review sheet for a person to fill blind. Its precision reads "not measured" until then.

Design sample:

<!-- BEGIN GENERATED:findings-precision -->

| Confidence   | Yes | No  | Unsure | Not reviewed | Precision |
| ------------ | --- | --- | ------ | ------------ | --------- |
| Worth a look | 11  | 0   | 0      | 0            | 100.0%    |
| Maybe        | 8   | 11  | 0      | 2            | 42.1%     |

<!-- END GENERATED:findings-precision -->

Held-out sample:

<!-- BEGIN GENERATED:findings-heldout-precision -->

| Confidence   | Yes | No  | Unsure | Not reviewed | Precision    |
| ------------ | --- | --- | ------ | ------------ | ------------ |
| Worth a look | 0   | 0   | 0      | 14           | not measured |
| Maybe        | 0   | 0   | 0      | 16           | not measured |

<!-- END GENERATED:findings-heldout-precision -->

## Risk tiers

The risk tiers were evaluated against files fixed in a later window; hindsight is a proxy, not proof of a defect. From [the risk report](benchmarks/risk.md):

<!-- BEGIN GENERATED:risk -->

| Tier         | All repositories   | zod             | vitest              | flask-full     | cli-full          |
| ------------ | ------------------ | --------------- | ------------------- | -------------- | ----------------- |
| critical     | 81.4% (48 of 59)   | 75.0% (6 of 8)  | 97.1% (33 of 34)    | 33.3% (1 of 3) | 57.1% (8 of 14)   |
| high         | 50.0% (46 of 92)   | 20.0% (1 of 5)  | 66.0% (33 of 50)    | 0.0% (0 of 3)  | 35.3% (12 of 34)  |
| moderate     | 33.1% (119 of 360) | 18.0% (9 of 50) | 42.8% (92 of 215)   | 9.1% (1 of 11) | 20.2% (17 of 84)  |
| low-moderate | 11.9% (44 of 371)  | 1.6% (1 of 61)  | 17.0% (24 of 141)   | 0.0% (0 of 9)  | 11.9% (19 of 160) |
| low          | 9.5% (197 of 2081) | 3.6% (9 of 247) | 10.5% (162 of 1540) | 0.0% (0 of 57) | 11.0% (26 of 237) |

<!-- END GENERATED:risk -->

## Hint scorers

Hint scorer calibration on a temporal holdout, from [the scorer report](benchmarks/scorers.md). Hints never become fact edges or findings.

<!-- BEGIN GENERATED:scorers -->

| Scorer                                                                               | Judged | Positive rate | Mean p | Brier | ECE   | ROC AUC |
| ------------------------------------------------------------------------------------ | ------ | ------------- | ------ | ----- | ----- | ------- |
| Heuristic with a model, fitted on T0                                                 | 15472  | 18.0%         | 0.163  | 0.126 | 0.027 | 0.707   |
| Heuristic with a model, shipped coefficients                                         | 15472  | 18.0%         | 0.163  | 0.126 | 0.027 | 0.707   |
| Heuristic without a model, fitted on T0 (similarity-only pairs at 0: never proposed) | 15472  | 18.0%         | 0.076  | 0.139 | 0.113 | 0.659   |
| Cosine alone                                                                         | 15472  | 18.0%         | 0.708  | 0.464 | 0.566 | 0.501   |
| Co-change ratio alone                                                                | 15472  | 18.0%         | 0.044  | 0.149 | 0.141 | 0.638   |
| Constant (T0 positive rate)                                                          | 15472  | 18.0%         | 0.195  | 0.148 | 0.015 | 0.500   |

<!-- END GENERATED:scorers -->

## Summary cost

Measured with one provider, one pinned Flask history and the report's stated price; your cost depends on your provider, model and changes. From [the summary report](benchmarks/summaries.md):

<!-- BEGIN GENERATED:summary-cost -->

| Run                                         | Requests | Stored | Not stored (refusal, cut off, emptied) | Input tokens | Output tokens | Cost    | Time in requests | Stopped early |
| ------------------------------------------- | -------- | ------ | -------------------------------------- | ------------ | ------------- | ------- | ---------------- | ------------- |
| Full run                                    | 108      | 108    | 0                                      | 269203       | 16255         | $0.035  | 144.5 s          | no            |
| Incremental run, whole project              | 102      | 102    | 0                                      | 269860       | 15408         | $0.035  | 136.9 s          | no            |
| Incremental run, new and changed files only | 7        | 7      | 0                                      | 56897        | 1250          | $0.0063 | 11.1 s           | –             |

<!-- END GENERATED:summary-cost -->

## Installer sizes

From the [installer size report](benchmarks/installers.md), generated by `scripts/package-size.mjs` on the CI run named there. They describe that run's build, not a promise about later releases.

<!-- BEGIN GENERATED:installers -->

| Runner       | Installer                  | Size     |
| ------------ | -------------------------- | -------- |
| macos-26     | `Epoch-mac-arm64.dmg`      | 210.3 MB |
| windows-2025 | `Epoch-win-x64-setup.exe`  | 200.1 MB |
| ubuntu-24.04 | `Epoch-linux-x64.AppImage` | 223.3 MB |
| ubuntu-24.04 | `Epoch-linux-x64.deb`      | 192.5 MB |

<!-- END GENERATED:installers -->
