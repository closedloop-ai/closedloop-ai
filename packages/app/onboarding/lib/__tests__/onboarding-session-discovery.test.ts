import { describe, expect, it } from "vitest";
import {
  getSourceProgressPercent,
  OnboardingAnalysisEstimateStatus,
  type OnboardingAnalysisProgress,
  OnboardingAnalysisProgressStatus,
  OnboardingProgressOperand,
  type OnboardingSessionDiscovery,
  type OnboardingSessionSource,
} from "../../components/guided-onboarding-data";
import {
  foldOnboardingSessionDiscovery,
  type OnboardingDiscoveryInput,
  OnboardingEnumerationQuality,
  type OnboardingHarnessSessions,
} from "../onboarding-session-discovery";

/**
 * ISS-8346. The rule this fold exists to enforce: the summary may never
 * contradict its own population, and absence is never rendered as zero. Each
 * case below is written so removing the rule it names changes the asserted
 * output, not just the internal computation.
 */
describe("foldOnboardingSessionDiscovery", () => {
  it("sums the detected rows to the stated total, and excludes a harness reported only in analyzed", () => {
    const { discovery } = foldOnboardingSessionDiscovery(
      input({
        analyzed: [
          harness("claude-code", 100),
          harness("codex", 10),
          // Only in `analyzed`, never in `found` — must be neither rendered
          // nor summed into either total.
          harness("cursor", 5),
        ],
        found: [harness("claude-code", 120), harness("codex", 30)],
      })
    );

    const measured = expectMeasured(discovery);
    expect(measured.sessionsFound).toBe(150);
    expect(measured.sessionsAnalyzed).toBe(110);
    expect(measured.sources.map((source) => source.label)).toEqual([
      "Label:claude-code",
      "Label:codex",
    ]);
    expect(sumDetectedFound(measured.sources)).toBe(measured.sessionsFound);
  });

  it("never rounds a ratio into either end: 3,985 of 4,004 is 99 and 1 of 4,004 is 1", () => {
    const nearlyDone = foldOnboardingSessionDiscovery(
      input({ analyzed: [harness("a", 3985)], found: [harness("a", 4004)] })
    );
    // 99.5% would round to 100, and 100 is what turns the title into "Session
    // analysis complete." over nineteen sessions still to go.
    expect(nearlyDone.progress).toEqual({
      percent: 99,
      status: OnboardingAnalysisProgressStatus.Measured,
    });

    const justStarted = foldOnboardingSessionDiscovery(
      input({ analyzed: [harness("a", 1)], found: [harness("a", 4004)] })
    );
    // 0.02% would round to 0, and a measured 0 is what disables Continue.
    expect(justStarted.progress).toEqual({
      percent: 1,
      status: OnboardingAnalysisProgressStatus.Measured,
    });

    const done = foldOnboardingSessionDiscovery(
      input({ analyzed: [harness("a", 4004)], found: [harness("a", 4004)] })
    );
    expect(done.progress).toEqual({
      percent: 100,
      status: OnboardingAnalysisProgressStatus.Measured,
    });
  });

  it("derives the session-ratio percent from the two reported counts", () => {
    const { progress } = foldOnboardingSessionDiscovery(
      input({
        analyzed: [harness("a", 3)],
        found: [harness("a", 10)],
      })
    );

    expect(progress).toEqual({
      percent: 30,
      status: OnboardingAnalysisProgressStatus.Measured,
    });
  });

  it("states a full ratio from the counts alone, with no completeness caveat in the way (ISS-8346 ruling 2026-09-04)", () => {
    const { discovery, progress } = foldOnboardingSessionDiscovery(
      input({
        analyzed: [harness("a", 5)],
        found: [harness("a", 5)],
      })
    );

    const measured = expectMeasured(discovery);
    expect(measured.sessionsFound).toBe(5);
    expect(measured.sources).toHaveLength(1);
    // The percentage is over the population the rows show. An earlier revision
    // withheld it whenever the host's sweep had one impaired probe, which left
    // the approved screen with no bar caption on real machines.
    expect(progress).toEqual({
      percent: 100,
      status: OnboardingAnalysisProgressStatus.Measured,
    });
  });

  it("withdraws the counts and rows entirely, while a supplied logBytes still renders", () => {
    const shared = {
      analyzed: [harness("a", 5)],
      found: [harness("a", 5)],
      logBytes: 12_345,
    };

    const withdrawn = expectMeasured(
      foldOnboardingSessionDiscovery(
        input({ ...shared, quality: OnboardingEnumerationQuality.Withdrawn })
      ).discovery
    );
    expect(withdrawn.sessionsFound).toBeNull();
    expect(withdrawn.sessionsAnalyzed).toBeNull();
    expect(withdrawn.sources).toHaveLength(0);
    expect(withdrawn.logBytes).toBe(12_345);

    // Positive control: the same counts under a Whole enumeration DO render,
    // so the withdrawal above is what suppressed them, not something else
    // about the input.
    const control = expectMeasured(
      foldOnboardingSessionDiscovery(
        input({ ...shared, quality: OnboardingEnumerationQuality.Whole })
      ).discovery
    );
    expect(control.sessionsFound).toBe(5);
    expect(control.sources).toHaveLength(1);
  });

  it("withdraws the count rather than stating a zero, for either an all-zero list or an empty one", () => {
    for (const found of [
      [harness("a", 0), harness("b", 0)],
      [],
    ] satisfies (readonly OnboardingHarnessSessions[])[]) {
      const { discovery, progress } = foldOnboardingSessionDiscovery(
        // `logBytes` so the discovery still has something measured to report;
        // without it this input measured nothing at all and folds to `unknown`.
        input({ analyzed: [harness("a", 0)], found, logBytes: 999 })
      );

      const measured = expectMeasured(discovery);
      // NOT `0`. Every row here was dropped as a producer bug, which leaves no
      // population that was counted — and "0 sessions found" would be this
      // fold inventing a measured empty machine out of that.
      expect(measured.sessionsFound).toBeNull();
      expect(measured.sessionsAnalyzed).toBeNull();
      expect(measured.sources).toHaveLength(0);
      // No percent field at all — a NaN from an unguarded divide would add one.
      expect(progress).toEqual({
        status: OnboardingAnalysisProgressStatus.Unknown,
      });
    }
  });

  it("still states a surviving subset when only SOME rows are dropped", () => {
    // The boundary of the rule above: a partial drop leaves a real population,
    // so it renders. Only a total drop withdraws.
    const { discovery } = foldOnboardingSessionDiscovery(
      input({ found: [harness("a", 0), harness("b", 7)] })
    );

    const measured = expectMeasured(discovery);
    expect(measured.sessionsFound).toBe(7);
    expect(measured.sources).toHaveLength(1);
  });

  it("falls back to the byte remainder when no session count is reported", () => {
    const { progress } = foldOnboardingSessionDiscovery(
      input({ bytes: { eligible: 100, remaining: 40 }, found: null })
    );
    expect(progress).toEqual({
      percent: 60,
      status: OnboardingAnalysisProgressStatus.Measured,
    });
  });

  it("lets a complete estimate claim 100% only when no session ratio or byte fallback applied — a 3/10 ratio still reports 30", () => {
    const { progress: ratioProgress } = foldOnboardingSessionDiscovery(
      input({
        analyzed: [harness("a", 3)],
        estimate: { status: OnboardingAnalysisEstimateStatus.Complete },
        found: [harness("a", 10)],
      })
    );
    expect(ratioProgress).toEqual({
      percent: 30,
      status: OnboardingAnalysisProgressStatus.Measured,
    });

    const { progress: fallbackProgress } = foldOnboardingSessionDiscovery(
      input({
        bytes: null,
        estimate: { status: OnboardingAnalysisEstimateStatus.Complete },
        found: null,
      })
    );
    expect(fallbackProgress).toEqual({
      percent: 100,
      status: OnboardingAnalysisProgressStatus.Measured,
    });
  });

  it("lets a complete estimate claim 100% under every enumeration quality (ISS-8346 ruling 2026-09-04)", () => {
    const completeEstimate = {
      // The OpenCode shape: the byte lane finished, and the session lane omits
      // a harness that is on the machine. Nothing here divides, so only the
      // estimate can reach a percent.
      analyzed: null,
      bytes: null,
      estimate: { status: OnboardingAnalysisEstimateStatus.Complete },
      found: [harness("claude-code", 40)],
      logBytes: 4096,
    } satisfies Partial<OnboardingDiscoveryInput>;

    for (const quality of [
      OnboardingEnumerationQuality.Whole,
      OnboardingEnumerationQuality.Withdrawn,
    ]) {
      const { progress } = foldOnboardingSessionDiscovery(
        input({ ...completeEstimate, quality })
      );
      expect(progress, quality).toEqual({
        percent: 100,
        status: OnboardingAnalysisProgressStatus.Measured,
      });
    }
    // The count is withdrawn under Withdrawn: the ruling changed what the
    // percentage does, not what the count does.
    expect(
      expectMeasured(
        foldOnboardingSessionDiscovery(
          input({
            ...completeEstimate,
            quality: OnboardingEnumerationQuality.Withdrawn,
          })
        ).discovery
      ).sessionsFound
    ).toBeNull();
  });

  it("reports an unread analyzed store as null on each row and on the total, not zero", () => {
    const { discovery } = foldOnboardingSessionDiscovery(
      input({ analyzed: null, found: [harness("a", 7)] })
    );

    const measured = expectMeasured(discovery);
    expect(measured.sessionsAnalyzed).toBeNull();
    expect(measured.sources).toHaveLength(1);
    expect(expectDetected(measured.sources[0]).analyzed).toBeNull();
    // NOT withheld: this read has not settled, so the row is still being
    // measured and its bar may honestly sweep. The withdrawn case below is the
    // one that must settle, and the two are indistinguishable without this.
    expect(
      expectDetected(measured.sources[0]).analyzedWithheld
    ).toBeUndefined();
  });

  it("renders a harness proven absent as not-detected, contributing nothing to either total", () => {
    const { discovery } = foldOnboardingSessionDiscovery(
      input({
        absent: ["b"],
        analyzed: [harness("a", 5)],
        found: [harness("a", 5)],
      })
    );

    const measured = expectMeasured(discovery);
    expect(measured.sources).toHaveLength(2);
    const absentRow = measured.sources.find(
      (source) => source.label === "Label:b"
    );
    expect(absentRow?.detection.status).toBe("not-detected");
    expect(measured.sessionsFound).toBe(5);
    expect(measured.sessionsAnalyzed).toBe(5);
  });

  // The counterfactual for ISS-11591. This was the ISS-11346 case asserting
  // that `c` and `d` each got an `unknown` row; the operator's 2026-09-29
  // ruling retires those rows, so the same input now has to produce ONLY the
  // two rows the host holds evidence about. `c` is the sharp half: it has
  // landed in the store and no sweep counted it on disk, so it is exactly the
  // "we cannot say" case, and its 9 must still reach neither total.
  it("omits a source nothing counted, keeping only evidence-backed rows (ISS-11591)", () => {
    const { discovery } = foldOnboardingSessionDiscovery(
      input({
        absent: ["b"],
        analyzed: [harness("a", 4), harness("c", 9)],
        found: [harness("a", 5)],
      })
    );

    const measured = expectMeasured(discovery);
    expect(measured.sources).toEqual([
      {
        detection: { analyzed: 4, found: 5, status: "detected" },
        harness: "a",
        label: "Label:a",
      },
      { detection: { status: "not-detected" }, harness: "b", label: "Label:b" },
    ]);
    expect(measured.sources.map((source) => source.harness)).not.toContain("c");
    expect(measured.sessionsFound).toBe(5);
    expect(measured.sessionsAnalyzed).toBe(4);
  });

  it("lists no sources until the host reports a row of its own", () => {
    // The shape a desktop sends before its sweep lands: no counts, and an
    // estimate that is `unavailable` rather than `unknown`, so the fold is
    // already `measured`. An empty list is what keeps the awaiting-scan state.
    const { discovery } = foldOnboardingSessionDiscovery(
      input({
        analyzed: null,
        estimate: { status: OnboardingAnalysisEstimateStatus.Unavailable },
        found: null,
      })
    );

    expect(expectMeasured(discovery).sources).toEqual([]);
  });

  it("renders a harness in both found and absent once, as detected", () => {
    const { discovery } = foldOnboardingSessionDiscovery(
      input({
        absent: ["a"],
        analyzed: [harness("a", 2)],
        found: [harness("a", 5)],
      })
    );

    const measured = expectMeasured(discovery);
    expect(measured.sources).toHaveLength(1);
    expect(measured.sources[0].detection.status).toBe("detected");
  });

  it("returns the unknown discovery and progress when nothing was measured at all", () => {
    const result = foldOnboardingSessionDiscovery(
      input({ analyzed: null, found: null })
    );

    expect(result.discovery).toEqual({ status: "unknown" });
    expect(result.progress).toEqual({
      status: OnboardingAnalysisProgressStatus.Unknown,
    });
  });

  it("clamps the derived percentage at both bounds instead of reporting the raw overshoot or undershoot", () => {
    // Both bounds are reachable ONLY through the byte lane, where a remainder
    // outside its own denominator is a real skew between two producers. The
    // session lane declines an overshoot rather than clamping it, so it reaches
    // neither bound this way — see the two ISS-10582 progress cases below.
    const { progress: overBytes } = foldOnboardingSessionDiscovery(
      input({ bytes: { eligible: 100, remaining: -20 }, found: null })
    );
    expect(expectMeasuredProgress(overBytes).percent).toBe(100);

    const { progress: underBytes } = foldOnboardingSessionDiscovery(
      input({ bytes: { eligible: 100, remaining: 140 }, found: null })
    );
    expect(expectMeasuredProgress(underBytes).percent).toBe(0);
  });

  it("names each row from the injected label function, not the raw harness key", () => {
    const { discovery } = foldOnboardingSessionDiscovery(
      input({
        absent: ["y"],
        analyzed: [harness("x", 1)],
        found: [harness("x", 3)],
        label: (key) => `Display(${key})`,
      })
    );

    const measured = expectMeasured(discovery);
    expect(measured.sources.map((source) => source.label)).toEqual([
      "Display(x)",
      "Display(y)",
    ]);
  });

  /**
   * ISS-10582. `analyzed` counts rows in the local store and `found` counts
   * transcripts still on disk, so a pruned checkout drives the store above the
   * disk permanently. The fold used to read that as a contradiction and
   * withdraw the analyzed half, which on a measured install left the modal
   * reporting no analyzed count and no percent on every launch, forever.
   */
  describe("an analyzed store that has outlived its transcripts", () => {
    it("states the analyzed count when it exceeds the found count", () => {
      const { discovery } = foldOnboardingSessionDiscovery(
        input({
          // The numbers measured on the real install in ISS-10582.
          analyzed: [harness("claude", 2443)],
          found: [harness("claude", 940)],
        })
      );

      const measured = expectMeasured(discovery);
      expect(measured.sessionsAnalyzed).toBe(2443);
      expect(expectDetected(measured.sources[0]).analyzed).toBe(2443);
      // The found side is a different population and is not moved to match.
      expect(measured.sessionsFound).toBe(940);
    });

    it("declines the session ratio when the analyzed read overshoots its denominator, and measures the byte lane instead", () => {
      const { progress } = foldOnboardingSessionDiscovery(
        input({
          analyzed: [harness("claude", 2443)],
          // A quarter of the parse work is still outstanding, which is what the
          // screen must say. 2443/940 would clamp to 100 and put "Session
          // analysis complete." and a green check over a population nobody
          // proved was analyzed: the surplus store rows have no counterpart in
          // the denominator, so they bias the quotient rather than narrow it.
          bytes: { eligible: 400, remaining: 100 },
          found: [harness("claude", 940)],
        })
      );

      expect(expectMeasuredProgress(progress).percent).toBe(75);
    });

    it("declines the session ratio for a per-harness overshoot a sibling's headroom would otherwise absorb", () => {
      const { discovery, progress } = foldOnboardingSessionDiscovery(
        input({
          // Only claude overshoots. Summed, 2443 sits inside 5940 and the
          // headline would state 41% — while at most 940 of those 5,940 can
          // have been analyzed, and claude's own row declines its bar. The
          // guard is per harness so the headline and the list cannot disagree.
          analyzed: [harness("claude", 2443)],
          bytes: { eligible: 400, remaining: 100 },
          found: [harness("claude", 940), harness("codex", 5000)],
        })
      );

      expect(expectMeasuredProgress(progress).percent).toBe(75);
      // The counts themselves are untouched by the declined ratio.
      expect(expectMeasured(discovery).sessionsAnalyzed).toBe(2443);
    });

    it("names the withheld operand when the ratio is declined and no byte remainder exists", () => {
      const { progress } = foldOnboardingSessionDiscovery(
        input({
          analyzed: [harness("claude", 2443)],
          bytes: null,
          found: [harness("claude", 940)],
        })
      );

      // Not `unknown`: a population IS on screen and its numerator settled as
      // unusable, so the slot is named rather than left to sweep (ISS-10624).
      expect(progress).toEqual({
        missing: OnboardingProgressOperand.AnalyzedSessions,
        status: OnboardingAnalysisProgressStatus.Unavailable,
      });
    });

    /**
     * davetho, PR #7575 P1. The declined ratio used to fall THROUGH to the
     * producer's own `complete`, which is a verdict about the byte lane, and
     * the heading then read "Session analysis complete." over 2,443 analyzed
     * against 940 found — the completion claim the declining exists to prevent.
     */
    it("refuses a complete estimate the claim the declined session ratio could not make", () => {
      const { progress } = foldOnboardingSessionDiscovery(
        input({
          analyzed: [harness("claude", 2443)],
          // No byte lane to fall back to, and the producer says its own lane
          // finished. That verdict may not be promoted into the session lane.
          bytes: null,
          estimate: { status: OnboardingAnalysisEstimateStatus.Complete },
          found: [harness("claude", 940)],
        })
      );

      expect(progress).toEqual({
        missing: OnboardingProgressOperand.AnalyzedSessions,
        status: OnboardingAnalysisProgressStatus.Unavailable,
      });
    });

    it("marks the row that overshot as withheld so it does not sweep on forever", () => {
      const { discovery } = foldOnboardingSessionDiscovery(
        input({
          analyzed: [harness("claude", 2443)],
          found: [harness("claude", 940), harness("codex", 5000)],
        })
      );

      const [claude, codex] =
        expectMeasured(discovery).sources.map(expectDetected);
      // The counts still render; it is the RATIO that is withheld, and the row
      // has to say so or it is indistinguishable from one still being measured.
      expect(claude.analyzedWithheld).toBe(true);
      // The sibling reported no store rows against a settled read, so it states
      // 0 of 5,000 — a formable ratio, and no marker. Carrying claude's verdict
      // here held a bar over a row with nothing wrong with it.
      expect(codex.analyzed).toBe(0);
      expect(codex.analyzedWithheld).toBeUndefined();
    });

    it("leaves a reconcilable read unmarked, so a pending row may honestly sweep", () => {
      const { discovery } = foldOnboardingSessionDiscovery(
        input({
          analyzed: [harness("claude", 500)],
          found: [harness("claude", 940)],
        })
      );

      for (const source of expectMeasured(discovery).sources) {
        expect(expectDetected(source).analyzedWithheld).toBeUndefined();
      }
    });

    it("states an analyzed count that exactly equals its found count", () => {
      const { discovery, progress } = foldOnboardingSessionDiscovery(
        input({
          analyzed: [harness("claude", 250)],
          found: [harness("claude", 250)],
        })
      );

      const measured = expectMeasured(discovery);
      expect(measured.sessionsAnalyzed).toBe(250);
      expect(expectMeasuredProgress(progress).percent).toBe(100);
    });

    it("states an analyzed count below its found count as the unsaturated ratio", () => {
      const { discovery, progress } = foldOnboardingSessionDiscovery(
        input({
          analyzed: [harness("claude", 500)],
          found: [harness("claude", 940)],
        })
      );

      const measured = expectMeasured(discovery);
      expect(measured.sessionsAnalyzed).toBe(500);
      // 500/940 is 0.5319; the shared clamp rounds and never rounds into 100.
      expect(expectMeasuredProgress(progress).percent).toBe(53);
    });

    it("keeps one harness above its found count from withdrawing the read of its siblings", () => {
      const { discovery } = foldOnboardingSessionDiscovery(
        input({
          analyzed: [harness("claude", 2443), harness("codex", 4)],
          found: [harness("claude", 940), harness("codex", 146)],
        })
      );

      const measured = expectMeasured(discovery);
      expect(
        measured.sources.map((source) => expectDetected(source).analyzed)
      ).toEqual([2443, 4]);
      expect(measured.sessionsAnalyzed).toBe(2447);
    });

    it("attaches no analyzed count to a harness whose found population is zero", () => {
      const { discovery } = foldOnboardingSessionDiscovery(
        input({
          // A `0` from a producer that omits what it cannot enumerate is that
          // producer's bug, so the row is dropped and nothing is left to carry
          // an analyzed count — it is not rendered against an empty population.
          analyzed: [harness("claude", 2443)],
          found: [harness("claude", 0)],
          // Keeps the discovery `measured` so the analyzed half is observable;
          // without it the whole fold is `unknown` and this case would pass
          // even if the analyzed read were summed over a withdrawn population.
          logBytes: 999,
        })
      );

      const measured = expectMeasured(discovery);
      expect(measured.sources).toEqual([]);
      expect(measured.sessionsAnalyzed).toBeNull();
      expect(measured.sessionsFound).toBeNull();
    });

    /**
     * The compounding half. The desktop host sweeps its transcript inventory
     * once per process (`startSweepOnce`), so `found` is frozen for the app's
     * lifetime while `analyzed` re-reads on every poll. An import landing rows
     * mid-session therefore pushes a machine that started reconcilable across
     * the line, and under the old rule it never recovered.
     */
    it("keeps stating the analyzed count across polls once a frozen found count is overtaken", () => {
      const frozenFound = [harness("claude", 940)];
      const polls = [700, 940, 1500, 2443].map(
        (analyzed) =>
          foldOnboardingSessionDiscovery(
            input({
              analyzed: [harness("claude", analyzed)],
              found: frozenFound,
            })
          ).discovery
      );

      expect(
        polls.map((discovery) => expectMeasured(discovery).sessionsAnalyzed)
      ).toEqual([700, 940, 1500, 2443]);
    });
  });

  it("states the byte percentage on the operator's own shape, where the session ratio is declined (ISS-10624)", () => {
    // Measured from the operator's machine, 2026-09-17: the on-disk sweep found
    // 946 Claude and 146 Codex sessions while the store held 2,454 Claude, 146
    // Codex and 714 OpenCode — transcripts the store accumulated and disk no
    // longer has. The ratio is declined, and on that machine every bar then
    // swept indefinitely beside an em-dash.
    const { discovery, progress } = foldOnboardingSessionDiscovery(
      input({
        analyzed: OPERATOR_ANALYZED,
        // What the parse lane's own position now transports, independent of
        // whether a TIME can be estimated yet.
        bytes: { eligible: 1000, remaining: 640 },
        estimate: { status: OnboardingAnalysisEstimateStatus.Calculating },
        found: OPERATOR_FOUND,
        logBytes: 8192,
      })
    );

    const measured = expectMeasured(discovery);
    expect(measured.sessionsFound).toBe(1092);
    // ISS-10582 reversed this from `null`: the store's own count is a real read
    // of a real population and is stated. Only the quotient is withheld. The
    // total is summed over the COUNTED harnesses, so opencode — discovered by
    // nobody and shown on no row — contributes to neither.
    expect(measured.sessionsAnalyzed).toBe(2600);
    // A REAL percentage over real measurement, not a sweep and not an em-dash.
    expect(progress).toEqual({
      percent: 36,
      status: OnboardingAnalysisProgressStatus.Measured,
    });
  });

  it("withholds rather than sweeping when that same shape has no byte position either", () => {
    // The counterfactual for the case above: identical input with the parse
    // position withdrawn. The percentage must be NAMED as unavailable, never
    // invented, and never reported as "nobody has told us anything".
    const { progress } = foldOnboardingSessionDiscovery(
      input({
        analyzed: OPERATOR_ANALYZED,
        bytes: null,
        estimate: { status: OnboardingAnalysisEstimateStatus.Calculating },
        found: OPERATOR_FOUND,
        logBytes: 8192,
      })
    );

    expect(progress).toEqual({
      missing: OnboardingProgressOperand.AnalyzedSessions,
      status: OnboardingAnalysisProgressStatus.Unavailable,
    });
  });

  it("keeps `unknown` while the analyzed read is still pending over a found population", () => {
    // whitlockk, PR #7547. `sessionsFound` arrives from the INVENTORY, which lands
    // before the store read settles, so every run passes through "found > 0,
    // analyzed pending". Calling that `unavailable` pauses the dialog and puts
    // "Analyzed count unavailable" on screen over a count that is still
    // loading — the loading-vs-unavailable conflation `packages/app/AGENTS.md`
    // forbids. Only a read that SETTLED and could not be divided withholds.
    const { discovery, progress } = foldOnboardingSessionDiscovery(
      input({
        analyzed: null,
        bytes: null,
        estimate: { status: OnboardingAnalysisEstimateStatus.Calculating },
        found: OPERATOR_FOUND,
        logBytes: 8192,
      })
    );

    const measured = expectMeasured(discovery);
    expect(measured.sessionsFound).toBe(1092);
    expect(measured.sessionsAnalyzed).toBeNull();
    // Still in flight, so the row may honestly sweep and the headline may not
    // name a shortfall that has not happened.
    for (const source of measured.sources) {
      if (source.detection.status === "detected") {
        expect(source.detection.analyzedWithheld).toBeUndefined();
      }
    }
    expect(progress).toEqual({
      status: OnboardingAnalysisProgressStatus.Unknown,
    });
  });

  it("keeps `unknown` for a screen that has no population at all", () => {
    // The boundary of the arm above. Nothing was found, so there is no
    // denominator to be short a numerator for, and the two states stay
    // distinct rather than one absorbing the other.
    const { progress } = foldOnboardingSessionDiscovery(
      input({ analyzed: null, bytes: null, found: null, logBytes: 8192 })
    );

    expect(progress).toEqual({
      status: OnboardingAnalysisProgressStatus.Unknown,
    });
  });

  it("states both counts when a source reports more analyzed than found", () => {
    const { discovery, progress } = foldOnboardingSessionDiscovery(
      input({
        // The store holds sessions whose transcripts have since been pruned, so
        // the two reads describe different populations and neither can be shown
        // as a FRACTION of the other. ISS-10582 reversed the response to that
        // from withdrawing the analyzed half to withholding only the quotient.
        analyzed: [harness("claude", 300), harness("codex", 4)],
        found: [harness("claude", 250), harness("codex", 10)],
      })
    );

    const measured = expectMeasured(discovery);
    // The FOUND side is untouched — it is not the half that overshot.
    expect(measured.sessionsFound).toBe(260);
    expect(sumDetectedFound(measured.sources)).toBe(260);
    expect(measured.sessionsAnalyzed).toBe(304);
    // The row that overshot says WHY it has no bar. Without this it is
    // indistinguishable from one whose store read is still in flight, and it
    // sweeps for the life of the screen. Its sibling at 4 of 10 divides fine
    // and carries no marker — see the per-source case below.
    expect(expectDetected(measured.sources[0]).analyzedWithheld).toBe(true);
    expect(
      expectDetected(measured.sources[1]).analyzedWithheld
    ).toBeUndefined();
    expect(progress).toEqual({
      missing: OnboardingProgressOperand.AnalyzedSessions,
      status: OnboardingAnalysisProgressStatus.Unavailable,
    });
  });

  /**
   * The operator's own two harnesses, 2026-09-19. `claude` has outlived its
   * transcripts and `codex` has not, so the two rows are in genuinely different
   * states and only one of them may be held.
   *
   * Two sources with DIFFERENT states is what makes this case able to fail: a
   * single-source fixture cannot tell a per-source marker from an aggregate one,
   * because there the two verdicts are the same verdict.
   */
  it("holds only the row that overshot, leaving a sibling whose own ratio divides", () => {
    const { discovery, progress } = foldOnboardingSessionDiscovery(
      input({
        analyzed: [harness("claude", 2443), harness("codex", 4)],
        found: [harness("claude", 940), harness("codex", 146)],
      })
    );

    const measured = expectMeasured(discovery);
    const [claude, codex] = measured.sources.map(expectDetected);
    expect(claude.analyzedWithheld).toBe(true);
    // 4 of 146 is a formable ratio measuring a sweep genuinely under way, so
    // this row keeps its live bar. Marking it would report a source nothing is
    // wrong with as degraded, over a shortfall belonging to its sibling.
    expect(codex.analyzedWithheld).toBeUndefined();
    expect(getSourceProgressPercent(codex)).toBe(3);
    // The HEADLINE's gate stays aggregate: it divides the sums, so one row's
    // overshoot disqualifies that quotient however well the other fits.
    expect(progress).toEqual({
      missing: OnboardingProgressOperand.AnalyzedSessions,
      status: OnboardingAnalysisProgressStatus.Unavailable,
    });
  });

  /**
   * The values a session count can never take. Each renders as a confident
   * measurement if it reaches the screen, so the read is withdrawn whole —
   * the same shape the store-exceeds-disk case used to get for a figure that
   * was merely surprising.
   */
  describe("an analyzed read carrying an impossible count", () => {
    const impossible: readonly (readonly [string, number])[] = [
      ["negative", -5],
      ["fractional", 1.5],
      ["not a number", Number.NaN],
      ["infinite", Number.POSITIVE_INFINITY],
      ["past the safe-integer range", Number.MAX_SAFE_INTEGER + 2],
    ];

    for (const [name, sessions] of impossible) {
      it(`withdraws the analyzed half whole when one harness reports a ${name} count`, () => {
        const { discovery, progress } = foldOnboardingSessionDiscovery(
          input({
            // Two harnesses, so the case cannot pass by dropping only the row
            // that carried the bad value.
            analyzed: [harness("claude", sessions), harness("codex", 4)],
            found: [harness("claude", 940), harness("codex", 146)],
          })
        );

        const measured = expectMeasured(discovery);
        expect(measured.sessionsAnalyzed).toBeNull();
        for (const source of measured.sources) {
          expect(expectDetected(source).analyzed).toBeNull();
          // The withdrawal is the whole fold's, so every row carries the reason
          // and none of them sweeps as though its read were still in flight.
          expect(expectDetected(source).analyzedWithheld).toBe(true);
        }
        // The found side did not fail and is untouched.
        expect(measured.sessionsFound).toBe(1086);
        expect(sumDetectedFound(measured.sources)).toBe(1086);
        // Nothing left to divide, and no byte remainder was supplied — but a
        // population IS on screen, so ISS-10624 names the missing operand here
        // rather than reporting "nobody has told us anything".
        expect(progress).toEqual({
          missing: OnboardingProgressOperand.AnalyzedSessions,
          status: OnboardingAnalysisProgressStatus.Unavailable,
        });
      });

      it(`keeps a discovered harness's valid count when an UNDISCOVERED one reports a ${name} count`, () => {
        const { discovery } = foldOnboardingSessionDiscovery(
          input({
            // `ghost` is absent from `found`, so it reaches no row and no total
            // and its value can never render. Withdrawing over it would delete
            // claude's good measurement to suppress one nothing would show.
            analyzed: [harness("claude", 400), harness("ghost", sessions)],
            found: [harness("claude", 940)],
          })
        );

        const measured = expectMeasured(discovery);
        expect(measured.sessionsAnalyzed).toBe(400);
        expect(expectDetected(measured.sources[0]).analyzed).toBe(400);
      });
    }
  });
});

/** The operator's machine, 2026-09-17: what the on-disk sweep could still see. */
const OPERATOR_FOUND: readonly OnboardingHarnessSessions[] = [
  { harness: "claude", sessions: 946 },
  { harness: "codex", sessions: 146 },
];

/** The same machine's store, which has outlived some of those transcripts. */
const OPERATOR_ANALYZED: readonly OnboardingHarnessSessions[] = [
  { harness: "claude", sessions: 2454 },
  { harness: "codex", sessions: 146 },
  { harness: "opencode", sessions: 714 },
];

function input(
  overrides: Partial<OnboardingDiscoveryInput> = {}
): OnboardingDiscoveryInput {
  return {
    absent: [],
    analyzed: [],
    bytes: null,
    estimate: { status: OnboardingAnalysisEstimateStatus.Unknown },
    found: [],
    label: (key) => `Label:${key}`,
    logBytes: null,
    quality: OnboardingEnumerationQuality.Whole,
    ...overrides,
  };
}

function harness(name: string, sessions: number): OnboardingHarnessSessions {
  return { harness: name, sessions };
}

function sumDetectedFound(sources: readonly OnboardingSessionSource[]): number {
  return sources.reduce(
    (total, source) =>
      total +
      (source.detection.status === "detected" ? source.detection.found : 0),
    0
  );
}

function expectDetected(source: OnboardingSessionSource) {
  if (source.detection.status !== "detected") {
    throw new Error(`expected a detected row, got ${source.detection.status}`);
  }
  return source.detection;
}

function expectMeasured(discovery: OnboardingSessionDiscovery) {
  if (discovery.status !== "measured") {
    throw new Error("expected a measured discovery");
  }
  return discovery;
}

function expectMeasuredProgress(progress: OnboardingAnalysisProgress) {
  if (progress.status !== OnboardingAnalysisProgressStatus.Measured) {
    throw new Error("expected a measured progress");
  }
  return progress;
}
