/**
 * ISS-9814 (ISS-4779 closed-by-default): the PostHog key that decides whether a
 * per-dollar surface DISPLAYS the Pensero points numerator instead of LOC.
 *
 * ## Why this is not `pensero-integration`
 *
 * `pensero-integration` answers *may this org store a credential and have rows
 * written for it*. This one answers *does this org see a different metric*. The
 * ordering makes one key fatal rather than untidy: the write gate must be ON for
 * an org before any of its `delivery_points` rows exist, while the display gate
 * must stay OFF until that org's backfill has actually populated. A single key
 * would force "credential stored implies metric already switched" — which is
 * precisely the empty-numerator state the parent (ISS-9733) warns about, a
 * `Pensero pts / $` card computed over a table that has nothing in it yet.
 *
 * Two keys compose, and both must pass: the read
 * (`readPenseroBranchDeliveryPoints`) refuses outside the `pensero-integration`
 * rollout, and this key then decides whether the value that read produced is the
 * one a card renders.
 *
 * ## No desktop Labs toggle — and what that does NOT buy
 *
 * Labs toggles are retired (operator directive 2026-08-30) and verified inert on
 * `origin/main`: `apps/desktop/src/renderer/feature-flags/desktop-feature-flag-provider.tsx`
 * builds its adapter from `useDesktopPostHogFlagAssignment()` alone and never
 * reads the Labs store. `AGENTS.md` still describes a Labs-parity requirement;
 * it is stale, and the directive governs.
 *
 * So the GATE is shared — desktop mounts the same `@repo/app` card and reads
 * this same key. The DATA is not, in several of desktop's reader states.
 *
 * ## ISS-9929 (operator ruling, Marisol, 2026-09-18): no desktop numerator is coming
 *
 * An earlier draft of this note claimed the key "MUST NOT be enabled before a
 * desktop-side numerator exists". That precondition is WITHDRAWN, and its
 * premise was wrong as well as its conclusion. It assumed desktop branch detail
 * always comes from the local SQLite projection. It does not:
 * `apps/desktop/src/renderer/shared-branches/desktop-branches-source.tsx`
 * selects the CLOUD `/branches/[id]` source whenever `useCanonicalCloudSource`
 * holds, and that route already passes `penseroPoints`
 * (`apps/api/app/branches/[id]/route.ts`). The disagreement is one reader state,
 * not every desktop branch.
 *
 * ## Which predicate actually picks the source — and it is NOT the app-core mode
 *
 * Read this before reasoning about any state below, because getting it wrong is
 * how the first draft of this note under-counted the divergence. The Branches
 * source is selected by `useCanonicalCloudSource`
 * (`apps/desktop/src/renderer/shared-branches/desktop-branches-consumption.tsx`)
 * = `identityKey !== null && readsCloud`. BOTH terms are load-bearing and they
 * are not the same question:
 *
 * - `readsCloud` is `resolveDesktopAppCoreMode` — authenticated AND online. It
 *   carried a third term, `consentPermitsCloudRead`, until 2026-09-25; see the
 *   note under "States where desktop takes the LOC arm" for what that removal
 *   did to the states below.
 * - `identityKey` additionally requires a NON-EMPTY `organizationId`, which the
 *   mode never checks — `desktop-branches-consumption.tsx` says so in its own
 *   docstring, citing ISS-5714.
 *
 * The flag is resolved by a THIRD predicate that agrees with neither:
 * `useDesktopPostHogFlagAssignment` keys on `authedUserId` and `isOnline` alone
 * — never the org, never consent, never the mode. So "takes the LOC arm" and
 * "this key is closed" are genuinely independent, and every state where they
 * come apart is a divergence.
 *
 * ## States where desktop takes the LOC arm
 *
 * CLOSED, and therefore agreeing with a flag-off web — the LOC arm is the
 * correct arm for a closed key. Both of these are states in which no comparable
 * web render exists for that account on that machine:
 *
 * - Authed + OFFLINE — the assignment closes `FeatureAssignmentDelivery.Offline`
 *   with an empty `flags`.
 * - Signed OUT — `authedUserId` is null, so the assignment closes `Unavailable`.
 *
 * TWO OF THE FOUR STATES BELOW ARE NOW UNREACHABLE, and the lettering is kept
 * anyway. On 2026-09-25 the operator removed sync consent from the read-source
 * decision — it governs EGRESS, and gating ingress on it held a reader out of a
 * workspace they were entitled to read — so `resolveDesktopAppCoreMode` no
 * longer consults consent at all. That retires **(a)** and **(c)**: neither a
 * withholding consent tier nor an unsettled consent read can force the mode
 * Local any more. They are left in place, marked, rather than deleted, because
 * ISS-9929's ruling is ON (a) and a reader who meets that ruling elsewhere needs
 * to find what it was about. **(a)'s carve-out now has no live subject**, and
 * **(b) and (d) are unaffected and still open.**
 *
 * CAN DIVERGE — desktop takes the LOC arm while web is FREE to render
 * `Pensero pts / $` for the same branch. "Can", not "does", and the difference
 * is load-bearing: selecting the cloud source only means the route ATTEMPTS the
 * numerator read. `readBranchPenseroNumerator`
 * (`apps/api/app/branches/branch-pensero-numerator.ts`) returns `null` — and a
 * `null` numerator renders LOC/$, per ISS-9733 AC2 — whenever the SERVER
 * display half (`PENSERO_POINTS_PER_DOLLAR_SERVER_FLAG`) is closed for that
 * principal, the attribution resolves no points for that branch, or the read
 * throws (it is best-effort and swallows to `null`). In every one of those, web
 * renders LOC too and the two surfaces agree for the ordinary reason. So each
 * state below is a divergence only once web has a PUBLISHABLE numerator for
 * that branch; they are states that can come apart, not states that always do:
 *
 * - **(a) RETIRED 2026-09-25 — Authed + online + consent withholds session
 *   metadata** (`DesktopLocalReadReason.SyncOff`, itself now removed). This is
 *   the state ISS-9929 ruled on, and it can no longer occur.
 * - **(b) Authed + online, but `organizationId` is EMPTY.** (It read "consent
 *   permits" until 2026-09-25; that term is gone and the state is unchanged.)
 *   `canonicalBranchesIdentityKey` returns null, so the source is local; but
 *   `authedUserId` is truthy, so the assignment is genuinely fetched. NOT ruled
 *   on — see below.
 * - **(c) RETIRED 2026-09-25 — Authed + online + the consent read has not
 *   SETTLED yet.** `consentPermitsCloudRead` returned false while
 *   `!consent.resolved`, so the mode was Local while the flag settled
 *   independently. The mode no longer waits on that read, so this cannot occur.
 * - **(d) The flag's own DELIVERY failed, on a cloud-source reader** —
 *   `MissingBridge` (a version-skewed preload with no
 *   `getDesktopFeatureFlags`), `EvaluationFailed` (the bridge call rejected), or
 *   still-`Pending`. This one is the MIRROR of the other three and is not fixed
 *   by the same reasoning: they lack the DATA, whereas here the cloud source was
 *   selected and `penseroPoints` IS in the payload, and it is the GATE that is
 *   spuriously shut. Both failure branches sit AFTER the `authedUserId` and
 *   `isOnline` guards, so they are reachable authed and online; source selection
 *   never reads the assignment; `closedWith` hands back an empty `flags`, and
 *   `DesktopFeatureFlagProvider` compares `flags[key] === true`, so a transport
 *   failure is indistinguishable from an evaluated-off key at the read site.
 *   `Pending` belongs here too: the card reads
 *   `useFeatureFlagEnabledOptional` and never withholds on
 *   `useFeatureFlagResolved`. This re-collapses exactly the distinction
 *   `FeatureAssignmentDelivery` exists to keep — its own docstring warns that
 *   "`resolved` alone cannot say whether a closed gate was evaluated closed or
 *   never reached us". NOT ruled on — see below.
 *
 * Do not restate this as a count ("the four states", "the other three agree").
 * An earlier draft did, derived the list from the mode alone, and thereby missed
 * (b) and (c) entirely while asserting exhaustiveness.
 *
 * ## (a) was ACCEPTED and is now unreachable. (b) and (d) are still OPEN.
 *
 * "Desktop and web are always the same" is standing and absolute by default.
 * ISS-9929 was an explicit operator exception to it for **(a) only**: closing (a)
 * would mean a machine whose user chose a consent tier that withholds session
 * metadata issuing a cloud read per branch opened, disclosing which branch that
 * user is viewing and when. That egress was judged not worth buying the
 * agreement. Neither surface LIED — each labelled what it actually computed
 * (ISS-9733 AC6); they disagreed in (a) (AC5), knowingly.
 *
 * Past tense because the STATE is gone, not because the reasoning was
 * withdrawn, and a reader will not find the (a) divergence in the wild any more
 * — anything that looks like it is a different state, so check the mode's terms
 * first. The 2026-09-25 ruling is about the read SOURCE: consent governs egress,
 * and gating ingress on it held readers out of a workspace they were entitled to
 * read. Its effect is that (a) can no longer be entered. It does not, on its
 * face, address the per-branch-read disclosure ISS-9929 weighed, which such a
 * reader now performs. **Whether the ruling reverses that call or merely outruns
 * it is an OPEN QUESTION for the operator and is not settled here.** Do not cite
 * this paragraph as permission either way.
 *
 * **(b) and (d) carry no ruling at all.** The consent/egress rationale above
 * does not describe them — neither of those readers is characterised by a
 * consent tier — and the operator was not asked about them. They are OPEN
 * QUESTIONS, not part of the carve-out, and must not be read as accepted merely
 * because they appear in this note. (d) in particular is a gate bug rather than
 * a data gap, so it would not be closed by a desktop numerator even if one were
 * built. They are escalated as **ISS-10698**, which asks for a runtime gate that
 * makes them unreachable or a per-state ruling like (a)'s, BEFORE the key is
 * enabled for anyone. ISS-10698 also lists (c), which is now unreachable and
 * needs no gate. Do not fold the rest into (a)'s rationale, and do not treat
 * this paragraph as permission to leave them unfixed: a note is a record, not a
 * boundary.
 *
 * Withdrawing the precondition does NOT enable anything. The key still ships
 * OFF, and its row in `scripts/lint/posthog-flag-registration-ledger.ts` is
 * `Unverified` — which asserts only that NOBODY HERE HAS LOOKED in PostHog. It
 * is the absence of an attestation, never evidence about external state: that
 * ledger's own header says `Unverified` means "the key ships and nobody has
 * looked, so the gate may be resolving `false` for every user with no way to
 * open it", and the row would read identically on the day someone creates the
 * flag. Do not take it as a safety check, least of all while a precondition is
 * being withdrawn. What actually holds the card closed is the read path, not
 * the row: an unregistered key resolves `undefined` and folds to `false` (see
 * below), and the SERVER half must pass as well. Enabling the key remains a
 * rollout decision for the operator — and ISS-10698 above is a precondition of
 * it, not a parallel note.
 *
 * ## The flag must exist in PostHog before it can be enabled
 *
 * Declaring this constant creates nothing in PostHog. `useFeatureFlag(KEY)`
 * returns `undefined` for a key PostHog has never heard of, which folds to
 * `false` — indistinguishable from a deliberate "off", and the safe direction
 * for a closed-by-default gate.
 */
export const PENSERO_POINTS_PER_DOLLAR_FLAG_KEY =
  "pensero-points-per-dollar" as const;
